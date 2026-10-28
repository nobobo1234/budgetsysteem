import {
	and,
	asc,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	lte,
	ne,
	notInArray,
	or,
	sql,
	type SQL
} from 'drizzle-orm';
import { addDays } from '../dates.ts';
import { advancePast } from '../recurring.ts';
import { pairTransfers, TRANSFER_DAYS } from '../transfers.ts';
import { recordChange } from './audit.ts';
import { correctedCents, linkCorrection, releaseCorrectionsOf } from './corrections.ts';
import type { Conn, DB } from './db/index.ts';
import { INTERNAL_TRANSFER } from './db/seed.ts';
import {
	accounts,
	categories,
	owedPayments,
	receipts,
	recurring,
	reservations,
	transactionSplits,
	transactions
} from './db/schema.ts';
import { ValidationError } from './errors.ts';
import {
	applyShare,
	dropSourcePosts,
	MY_SHARE,
	recomputeStatus,
	refundInfo,
	settlePayment,
	shareFromNames,
	unlinkPayment
} from './owed.ts';
import { applySharedSplit, hasSharePosts, removeSharedFor } from './shares.ts';
import { syncAutoTags } from './tags.ts';
import { dateInRange, type NewTransaction, type TransactionPatch } from './validation.ts';

export { ValidationError };

function categoryExists(db: Conn, id: string): boolean {
	return (
		db.select({ id: categories.id }).from(categories).where(eq(categories.id, id)).get() !==
		undefined
	);
}

/**
 * Slaat een handmatige transactie op. Idempotent op het ID van de client: dezelfde post
 * twee keer versturen (offline wachtrij) levert één transactie op.
 */
export function createTransaction(
	db: DB,
	input: NewTransaction,
	today?: string
): { id: string; created: boolean } {
	if (!dateInRange(input.date, today)) throw new ValidationError('Datum ligt te ver weg');
	if (input.categoryId && !categoryExists(db, input.categoryId)) {
		throw new ValidationError('Onbekende categorie');
	}
	const account = db
		.select({ id: accounts.id })
		.from(accounts)
		.where(eq(accounts.id, input.accountId))
		.get();
	if (!account) throw new ValidationError('Onbekende rekening');

	return db.transaction((tx) => {
		const existing = tx
			.select({ id: transactions.id })
			.from(transactions)
			.where(eq(transactions.id, input.id))
			.get();
		if (existing) return { id: existing.id, created: false };

		const status = input.amountCents === 0 ? 'te_controleren' : 'bevestigd';
		let row = tx
			.insert(transactions)
			.values({
				id: input.id,
				amountCents: input.amountCents,
				date: input.date,
				counterparty: input.counterparty,
				description: input.description,
				categoryId: input.categoryId,
				categorySource: input.categoryId ? 'handmatig' : null,
				accountId: input.accountId,
				source: 'handmatig',
				origAmountCents: input.origAmountCents,
				origCurrency: input.origCurrency,
				status,
				note: input.note
			})
			.returning()
			.get();

		// Alleen jouw deel telt in de categorie; de rest is voorgeschoten (Te krijgen)
		if (input.share)
			applyShare(tx, row.id, shareFromNames(tx, input.share.people, input.share.with));

		// Ontvangen of terugbetaald. Is de gekozen post intussen weg (offline ingevoerd), dan
		// niet raden: de transactie blijft staan en komt bij te controleren.
		if (input.settle && !settlePayment(tx, row.id, input.settle)) {
			row = tx
				.update(transactions)
				.set({ status: 'te_controleren' })
				.where(eq(transactions.id, row.id))
				.returning()
				.get();
		}

		recordChange(tx, 'aangemaakt', 'transactions', row.id, null, row);
		// Tags met een periode die deze dag dekt (spec: Tags)
		syncAutoTags(tx, [row.id]);

		// Retour: verrekenen met de gekozen uitgave. Past hij niet (meer), bijvoorbeeld omdat er
		// offline al een andere retour op kwam, dan blijft hij staan en komt hij bij te controleren.
		if (input.correct) {
			try {
				linkCorrection(tx, row.id, input.correct.transactionId, { mode: input.correct.mode });
			} catch (e) {
				if (!(e instanceof ValidationError)) throw e;
				tx.update(transactions)
					.set({ status: 'te_controleren' })
					.where(eq(transactions.id, row.id))
					.run();
			}
		}
		return { id: row.id, created: true };
	});
}

export function updateTransaction(
	db: DB,
	id: string,
	patch: TransactionPatch,
	today?: string
): boolean {
	if (patch.date && !dateInRange(patch.date, today))
		throw new ValidationError('Datum ligt te ver weg');
	if (patch.categoryId && !categoryExists(db, patch.categoryId)) {
		throw new ValidationError('Onbekende categorie');
	}
	return db.transaction((tx) => {
		const before = tx.select().from(transactions).where(eq(transactions.id, id)).get();
		if (!before) return false;
		const amountChanged =
			patch.amountCents !== undefined && patch.amountCents !== before.amountCents;
		if (amountChanged && before.correctionOf) {
			throw new ValidationError('Maak de retour eerst los om het bedrag aan te passen');
		}
		if (amountChanged) {
			// Samen nooit meer terug dan het origineel
			const used = correctedCents(tx, id);
			const next = patch.amountCents!;
			if (used > 0 && (Math.sign(next) !== Math.sign(before.amountCents) || Math.abs(next) < used))
				throw new ValidationError('Er is al meer teruggekomen dan dit bedrag');
		}
		const hasSplits =
			tx
				.select({ id: transactionSplits.id })
				.from(transactionSplits)
				.where(eq(transactionSplits.transactionId, id))
				.get() !== undefined;
		// Een gedeelde vaste last rekent zijn aandelen opnieuw uit; een voorgeschoten uitgave niet
		const shared = hasSharePosts(tx, id);
		if (
			hasSplits &&
			!shared &&
			patch.amountCents !== undefined &&
			patch.amountCents !== before.amountCents
		) {
			throw new ValidationError('Het bedrag van een gedeelde uitgave pas je aan via de verdeling');
		}
		const status =
			before.status === 'te_controleren' && patch.amountCents !== undefined
				? 'bevestigd'
				: before.status;
		// Een zelf gekozen categorie is handmatig: regels blijven er voortaan af. Kies je geen
		// categorie, dan mogen regels hem weer invullen.
		const category =
			patch.categoryId !== undefined && patch.categoryId !== before.categoryId
				? {
						categorySource: patch.categoryId ? ('handmatig' as const) : null,
						categoryRuleId: null
					}
				: {};
		const after = tx
			.update(transactions)
			.set({ ...patch, ...category, status, updatedAt: new Date().toISOString() })
			.where(eq(transactions.id, id))
			.returning()
			.get();
		if (hasSplits && patch.categoryId !== undefined) {
			tx.update(transactionSplits)
				.set({ categoryId: patch.categoryId })
				.where(and(eq(transactionSplits.transactionId, id), eq(transactionSplits.note, MY_SHARE)))
				.run();
		}
		// Een retour telt in de categorie van het origineel en verhuist mee
		if (patch.categoryId !== undefined && patch.categoryId !== before.categoryId)
			moveCorrections(tx, id, before.categoryId, patch.categoryId);
		if (shared) applySharedSplit(tx, id);
		if (patch.date !== undefined && patch.date !== before.date) syncAutoTags(tx, [id]);
		// Een gekoppelde betaling met een ander bedrag wordt opnieuw over de posten verdeeld
		if (patch.amountCents !== undefined && patch.amountCents !== before.amountCents) {
			const links = tx
				.select({ personId: owedPayments.personId, owedId: owedPayments.owedId })
				.from(owedPayments)
				.where(eq(owedPayments.transactionId, id))
				.all();
			if (links.length > 0) {
				const first = links.find((l) => l.owedId)?.owedId ?? null;
				if (!settlePayment(tx, id, { personId: links[0]!.personId, owedId: first }))
					unlinkPayment(tx, id);
			}
		}
		// Een bon die op nakijken wachtte (controleren), is met de transactie mee nagekeken
		if (before.status === 'te_controleren' && after.status === 'bevestigd') {
			tx.update(receipts)
				.set({ handledAt: new Date().toISOString() })
				.where(and(eq(receipts.transactionId, id), isNull(receipts.handledAt)))
				.run();
		}
		recordChange(tx, 'gewijzigd', 'transactions', id, before, after);
		return true;
	});
}

type RecurringRow = typeof recurring.$inferSelect;
type Transaction = typeof transactions.$inferSelect;

/** Wat er aan een vaste last verandert als een van zijn posten verdwijnt. */
function afterRemoval(db: Conn, r: RecurringRow, t: Transaction): Partial<RecurringRow> {
	const patch: Partial<RecurringRow> = advancePast(r, t.date);
	if (t.status !== 'bevestigd') return patch;
	const newer = db
		.select({ id: transactions.id })
		.from(transactions)
		.where(
			and(
				eq(transactions.recurringId, r.id),
				eq(transactions.status, 'bevestigd'),
				ne(transactions.id, t.id),
				gte(transactions.date, t.date)
			)
		)
		.get();
	if (newer) return patch;
	// Dit was de laatste afschrijving: wat hij aan de vaste last veranderde, gaat terug
	const cents = -t.amountCents;
	if (r.signal && r.signalToCents === cents) {
		if (r.signal === 'prijsverhoging' && r.signalFromCents !== null)
			patch.medianCents = r.signalFromCents;
		patch.signal = null;
		patch.signalFromCents = null;
		patch.signalToCents = null;
	}
	const previous = db
		.select({ amountCents: transactions.amountCents })
		.from(transactions)
		.where(
			and(
				eq(transactions.recurringId, r.id),
				eq(transactions.status, 'bevestigd'),
				ne(transactions.id, t.id)
			)
		)
		.orderBy(desc(transactions.date))
		.get();
	if (previous) patch.lastCents = -previous.amountCents;
	else if (r.signalFromCents !== null && patch.signal === null) patch.lastCents = r.signalFromCents;
	return patch;
}

export function deleteTransaction(db: DB, id: string): boolean {
	return db.transaction((tx) => {
		const before = tx.select().from(transactions).where(eq(transactions.id, id)).get();
		if (!before) return false;
		// Retouren op deze boeking worden gewone boekingen op te controleren, vóór het opruimen
		// van de posten: hun deel staat als betaling op die posten
		releaseCorrectionsOf(tx, id);
		// Maandaandelen van een gedeelde vaste last vervallen; wat betaald was wordt tegoed
		removeSharedFor(tx, id);
		dropSourcePosts(tx, id);
		// Was dit een betaling, dan gaan de posten die hij dekte weer open
		const covered = unlinkPayment(tx, id);
		// Een afschrijving van een uitgesmeerde vaste last: de reservering staat weer opzij
		tx.update(reservations)
			.set({ drawnCents: 0, transactionId: null })
			.where(eq(reservations.transactionId, id))
			.run();
		if (before.recurringId) {
			const r = tx.select().from(recurring).where(eq(recurring.id, before.recurringId)).get();
			// Een post weggooien is "deze keer niet": de vaste last schuift door. Een bevestigde
			// afschrijving telt daarna niet meer als laatste bedrag of als prijsverhoging.
			if (r)
				tx.update(recurring)
					.set(afterRemoval(tx, r, before))
					.where(eq(recurring.id, r.id))
					.run();
		}
		tx.delete(transactions).where(eq(transactions.id, id)).run();
		recomputeStatus(tx, covered);
		recordChange(tx, 'verwijderd', 'transactions', id, before, null);
		return true;
	});
}

/** Retouren die de categorie van het origineel volgen gaan mee naar de nieuwe categorie. */
function moveCorrections(db: Conn, originalId: string, from: string | null, to: string | null) {
	const linked = db
		.select({ id: transactions.id, categoryId: transactions.categoryId })
		.from(transactions)
		.where(
			and(eq(transactions.correctionOf, originalId), eq(transactions.categorySource, 'correctie'))
		)
		.all();
	for (const r of linked) {
		if (r.categoryId !== from) continue;
		db.update(transactions).set({ categoryId: to }).where(eq(transactions.id, r.id)).run();
		db.update(transactionSplits)
			.set({ categoryId: to })
			.where(and(eq(transactionSplits.transactionId, r.id), eq(transactionSplits.note, MY_SHARE)))
			.run();
	}
}

export interface ListFilter {
	q?: string;
	month?: string;
	categoryId?: string | 'geen';
	status?: 'bevestigd' | 'verwacht' | 'te_controleren';
	/** Zonder verwachte posten, zoals Recent op het startscherm */
	withoutExpected?: boolean;
	accountId?: string;
	/** Datums `YYYY-MM-DD`, beide inclusief */
	from?: string;
	to?: string;
	/** Bijschrijvingen die als deel van een interne overboeking al bij hun afschrijving staan */
	excludeIds?: string[];
	limit?: number;
	offset?: number;
}

function likePattern(q: string): string {
	return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function filterWhere(filter: ListFilter): SQL | undefined {
	const where: SQL[] = [];
	const q = filter.q?.trim().slice(0, 100);
	if (q) {
		const p = likePattern(q);
		where.push(
			or(
				sql`${transactions.counterparty} LIKE ${p} ESCAPE '\\'`,
				sql`${transactions.description} LIKE ${p} ESCAPE '\\'`,
				sql`${transactions.note} LIKE ${p} ESCAPE '\\'`
			)!
		);
	}
	if (filter.month) {
		where.push(
			gte(transactions.date, `${filter.month}-01`),
			lte(transactions.date, `${filter.month}-31`)
		);
	}
	if (filter.categoryId === 'geen') where.push(isNull(transactions.categoryId));
	else if (filter.categoryId) where.push(eq(transactions.categoryId, filter.categoryId));
	if (filter.status) where.push(eq(transactions.status, filter.status));
	if (filter.withoutExpected) where.push(ne(transactions.status, 'verwacht'));
	if (filter.accountId) where.push(eq(transactions.accountId, filter.accountId));
	if (filter.from) where.push(gte(transactions.date, filter.from));
	if (filter.to) where.push(lte(transactions.date, filter.to));
	if (filter.excludeIds?.length) where.push(notInArray(transactions.id, filter.excludeIds));
	return and(...where);
}

/** Hoogstens zoveel rijen per aanroep; de transactielijst laadt bij tot 500 plus een hele dag */
const MAX_ROWS = 1000;

/** Nieuwste eerst; het id als laatste, zodat rijen uit één import (zelfde createdAt) vast liggen */
export function listTransactions(db: DB, filter: ListFilter = {}) {
	return db
		.select({
			id: transactions.id,
			amountCents: transactions.amountCents,
			date: transactions.date,
			counterparty: transactions.counterparty,
			description: transactions.description,
			categoryId: transactions.categoryId,
			categoryName: categories.name,
			categoryGroup: categories.group,
			accountAlias: accounts.alias,
			source: transactions.source,
			status: transactions.status,
			origAmountCents: transactions.origAmountCents,
			origCurrency: transactions.origCurrency,
			note: transactions.note
		})
		.from(transactions)
		.leftJoin(categories, eq(categories.id, transactions.categoryId))
		.innerJoin(accounts, eq(accounts.id, transactions.accountId))
		.where(filterWhere(filter))
		.orderBy(desc(transactions.date), desc(transactions.createdAt), desc(transactions.id))
		.limit(Math.min(filter.limit ?? 50, MAX_ROWS))
		.offset(Math.max(0, filter.offset ?? 0))
		.all();
}

export type TransactionRow = ReturnType<typeof listTransactions>[number];

/**
 * De nieuwste `count` rijen, aangevuld tot de laatste dag compleet is: een lijst per dag toont
 * anders een half dagsaldo en mogelijk de verkeerde grootste uitgave.
 */
export function listWholeDays(
	db: DB,
	filter: Omit<ListFilter, 'limit' | 'offset'>,
	count: number
): { rows: TransactionRow[]; hasMore: boolean } {
	const rows = listTransactions(db, { ...filter, limit: count + 1 });
	if (rows.length <= count) return { rows, hasMore: false };
	const last = rows[count - 1]!.date;
	if (rows[count]!.date !== last) return { rows: rows.slice(0, count), hasMore: true };
	// De laatste dag loopt door na de grens: die hele dag erbij, en kijken of er daarvoor nog iets is
	const day = listTransactions(db, { ...filter, from: last, to: last, limit: MAX_ROWS });
	const older = listTransactions(db, { ...filter, to: addDays(last, -1), limit: 1 });
	return { rows: [...rows.filter((r) => r.date > last), ...day], hasMore: older.length > 0 };
}

/** Rijen voor een lijst, met bij een gekoppelde betaling waar hij voor was. */
export function withRefunds<T extends { id: string }>(db: DB, rows: T[]) {
	const info = refundInfo(
		db,
		rows.map((r) => r.id)
	);
	return rows.map((r) => ({ ...r, refund: info.get(r.id) ?? null }));
}

/** Aantal en totalen voor alles wat het filter vindt, over alle pagina's heen. */
export function summarizeTransactions(db: DB, filter: Omit<ListFilter, 'limit' | 'offset'> = {}) {
	const row = db
		.select({
			count: sql<number>`count(*)`,
			inCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} > 0 then ${transactions.amountCents} end), 0)`,
			outCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} < 0 then ${transactions.amountCents} end), 0)`
		})
		.from(transactions)
		.where(filterWhere(filter))
		.get();
	return { count: row?.count ?? 0, inCents: row?.inCents ?? 0, outCents: row?.outCents ?? 0 };
}

/**
 * Een boeking tussen eigen rekeningen: herkend aan de eigen IBAN bij de import, of in de
 * categorie Interne overboeking (zoals opwaarderen naar Revolut via de standaardregel).
 */
function internalLeg(db: Conn): SQL {
	const internal = db
		.select({ id: categories.id })
		.from(categories)
		.where(eq(categories.name, INTERNAL_TRANSFER))
		.get()?.id;
	return internal
		? sql`coalesce(${transactions.categorySource} = 'intern' or ${transactions.categoryId} = ${internal}, 0)`
		: sql`coalesce(${transactions.categorySource} = 'intern', 0)`;
}

function transferLegs(db: Conn, where: SQL | undefined) {
	return db
		.select({
			id: transactions.id,
			amountCents: transactions.amountCents,
			date: transactions.date,
			accountId: transactions.accountId,
			accountName: accounts.name
		})
		.from(transactions)
		.innerJoin(accounts, eq(accounts.id, transactions.accountId))
		.where(and(where, ne(transactions.status, 'verwacht'), internalLeg(db)))
		.all();
}

export interface TransferInfo {
	/** De andere boeking van het paar */
	id: string;
	amountCents: number;
	date: string;
	/** Namen van de rekeningen: waar het geld afging en waar het binnenkwam */
	from: string;
	to: string;
}

/**
 * Interne overboekingen binnen het filter, als paar (spec: Transacties): de afschrijving staat in
 * de lijst met de bijschrijving erbij, de bijschrijving zelf niet. Alleen als beide boekingen
 * binnen het filter vallen; bij één rekening of één dag blijft elke boeking een eigen rij.
 */
export function transferPairs(db: DB, filter: Omit<ListFilter, 'limit' | 'offset' | 'excludeIds'>) {
	const legs = transferLegs(db, filterWhere(filter));
	const byId = new Map(legs.map((l) => [l.id, l]));
	const pairs = new Map<string, TransferInfo>();
	for (const [outId, inId] of pairTransfers(legs)) {
		const inc = byId.get(inId)!;
		pairs.set(outId, {
			id: inc.id,
			amountCents: inc.amountCents,
			date: inc.date,
			from: byId.get(outId)!.accountName,
			to: inc.accountName
		});
	}
	return {
		pairs,
		/** De bijschrijvingen, die in de lijst bij hun afschrijving staan */
		hidden: [...pairs.values()].map((p) => p.id),
		/** Beide boekingen van elk paar: samen geen uitgave en geen inkomen */
		paired: [...pairs.keys(), ...[...pairs.values()].map((p) => p.id)]
	};
}

/** Rijen voor een lijst, met bij de afschrijving van een interne overboeking de bijschrijving. */
export function withTransfers<T extends { id: string }>(
	rows: T[],
	pairs: Map<string, TransferInfo>
): (T & { transfer: TransferInfo | null })[] {
	return rows.map((r) => ({ ...r, transfer: pairs.get(r.id) ?? null }));
}

/** De andere boeking van een interne overboeking, voor de detailpagina. */
export function transferCounterpart(db: DB, id: string): TransferInfo | null {
	const tx = transferLegs(db, eq(transactions.id, id))[0];
	if (!tx) return null;
	// Ruim om de datum, zodat het paar hetzelfde is als in de lijst
	const legs = transferLegs(
		db,
		and(
			gte(transactions.date, addDays(tx.date, -2 * TRANSFER_DAYS)),
			lte(transactions.date, addDays(tx.date, 2 * TRANSFER_DAYS)),
			inArray(transactions.amountCents, [tx.amountCents, -tx.amountCents])
		)
	);
	const pairs = pairTransfers(legs);
	const otherId = pairs.get(id) ?? [...pairs].find(([, inId]) => inId === id)?.[0];
	const other = legs.find((l) => l.id === otherId);
	if (!other) return null;
	const [out, inc] = tx.amountCents < 0 ? [tx, other] : [other, tx];
	return {
		id: other.id,
		amountCents: other.amountCents,
		date: other.date,
		from: out.accountName,
		to: inc.accountName
	};
}

/** Maanden (`YYYY-MM`) waarin transacties staan, de nieuwste eerst. */
/**
 * Uitgaven per dag voor het staafdiagram boven Transacties: alleen uitgaand, zonder verwachte
 * posten, met de rest van het filter (zoekterm, categorie, rekening).
 */
export function spendingPerDay(
	db: DB,
	filter: Omit<ListFilter, 'limit' | 'offset' | 'status' | 'withoutExpected'> & { month: string }
): { date: string; outCents: number }[] {
	return db
		.select({
			date: transactions.date,
			outCents: sql<number>`-sum(${transactions.amountCents})`
		})
		.from(transactions)
		.where(
			and(
				filterWhere({ ...filter, withoutExpected: true }),
				sql`${transactions.amountCents} < 0`,
				// Een overboeking naar je eigen rekening is geen uitgave, ook niet via een regel
				sql`not ${internalLeg(db)}`
			)
		)
		.groupBy(transactions.date)
		.orderBy(asc(transactions.date))
		.all();
}

export function transactionMonths(db: DB): string[] {
	return db
		.selectDistinct({ month: sql<string>`substr(${transactions.date}, 1, 7)` })
		.from(transactions)
		.orderBy(desc(sql`substr(${transactions.date}, 1, 7)`))
		.all()
		.map((r) => r.month);
}

/** Bekende tegenpartijen, de vaakst gebruikte eerst. Voor het koppelen van snelinvoer. */
export function knownCounterparties(db: DB, limit = 300): string[] {
	return db
		.select({ name: transactions.counterparty, n: sql<number>`count(*)` })
		.from(transactions)
		.where(sql`${transactions.counterparty} != ''`)
		.groupBy(transactions.counterparty)
		.orderBy(desc(sql`count(*)`), desc(sql`max(${transactions.date})`))
		.limit(limit)
		.all()
		.map((r) => r.name);
}

/**
 * Tegenpartijen die je de laatste 60 dagen het vaakst zelf invoerde: suggesties onder een lege
 * snelinvoer (spec: Snelinvoer). Alleen namen.
 */
export function frequentManual(db: DB, today: string, limit = 5): string[] {
	return db
		.select({ name: transactions.counterparty })
		.from(transactions)
		.where(
			and(
				eq(transactions.source, 'handmatig'),
				gte(transactions.date, addDays(today, -60)),
				sql`${transactions.counterparty} != ''`
			)
		)
		.groupBy(transactions.counterparty)
		.orderBy(desc(sql`count(*)`), desc(sql`max(${transactions.date})`))
		.limit(limit)
		.all()
		.map((r) => r.name);
}
