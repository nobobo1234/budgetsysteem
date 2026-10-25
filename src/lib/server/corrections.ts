import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import {
	checkCorrection,
	correctionRoom,
	distributeCorrection,
	largestSplit,
	postEffect,
	REFUND_WINDOW_DAYS,
	type CorrectionMode,
	type Distribution
} from '../correction.ts';
import { addDays } from '../dates.ts';
import { nameScore, rankMatches, type MatchTarget } from '../match.ts';
import { recordChange } from './audit.ts';
import type { Conn } from './db/index.ts';
import {
	auditLog,
	categories,
	owed,
	owedPayments,
	people,
	transactionSplits,
	transactions
} from './db/schema.ts';
import { ValidationError } from './errors.ts';
import {
	ADVANCED,
	applyCredit,
	MY_SHARE,
	recomputeStatus,
	REFUND_CATEGORY,
	unlinkPayment
} from './owed.ts';

// Terugboekingen en retouren (spec: Terugboekingen en retouren). Een terugboeking verwijst via
// `correction_of` naar de boeking die hij verrekent en telt in diens categorie en maand; het
// saldo telt hem op zijn eigen datum. Bij een voorgeschoten uitgave gaat hij over jouw deel en
// de aandelen van de anderen: hun deel dekt (als betaling vanuit de terugboeking) wat er nog
// openstaat, en wat iemand al te veel betaalde wordt een post te betalen. Zo maakt losmaken
// alles weer ongedaan met de bestaande koppelingen.

type Row = typeof transactions.$inferSelect;

/** Een gelijke tegenpartij telt vanaf deze naamscore als "dezelfde winkel". */
const SAME_NAME = 0.75;

function load(db: Conn, id: string): Row | undefined {
	return db.select().from(transactions).where(eq(transactions.id, id)).get();
}

/** Terugboekingen die aan een boeking gekoppeld zijn, oudste eerst. */
function linkedCorrections(db: Conn, originalId: string, except?: string) {
	return db
		.select({ id: transactions.id, amountCents: transactions.amountCents })
		.from(transactions)
		.where(
			and(
				eq(transactions.correctionOf, originalId),
				except ? ne(transactions.id, except) : undefined
			)
		)
		.orderBy(asc(transactions.date), asc(transactions.createdAt))
		.all();
}

function paidByOwed(db: Conn, ids: readonly string[], onlyFrom?: readonly string[]) {
	if (ids.length === 0 || onlyFrom?.length === 0) return new Map<string, number>();
	const rows = db
		.select({ owedId: owedPayments.owedId, paid: sql<number>`sum(${owedPayments.amountCents})` })
		.from(owedPayments)
		.where(
			and(
				inArray(owedPayments.owedId, [...ids]),
				onlyFrom ? inArray(owedPayments.transactionId, [...onlyFrom]) : undefined
			)
		)
		.groupBy(owedPayments.owedId)
		.all();
	return new Map(rows.map((r) => [r.owedId!, r.paid]));
}

/** Posten te betalen die een terugboeking aanmaakte omdat iemand al te veel betaald had. */
function payBackPosts(db: Conn, correctionIds: readonly string[]) {
	if (correctionIds.length === 0) return [];
	return db
		.select()
		.from(owed)
		.where(
			and(inArray(owed.sourceTransactionId, [...correctionIds]), eq(owed.direction, 'te_betalen'))
		)
		.all();
}

export interface SharePart {
	owedId: string;
	personId: string | null;
	/** Aandeel zoals het nu nog telt, na eerdere terugboekingen */
	shareCents: number;
	outstandingCents: number;
}

/**
 * De delen van een voorgeschoten uitgave zoals ze nu nog tellen, zonder de terugboeking `except`.
 * Een kwijtgescholden post telt niet meer als aandeel: dat deel is al naar jouw deel geschoven.
 */
function currentShares(db: Conn, original: Row, except?: string) {
	const posts = db
		.select()
		.from(owed)
		.where(and(eq(owed.sourceTransactionId, original.id), eq(owed.direction, 'te_krijgen')))
		.orderBy(asc(owed.createdAt), asc(sql`owed.rowid`))
		.all();
	if (posts.length === 0) return null;
	const mySplit = db
		.select()
		.from(transactionSplits)
		.where(
			and(eq(transactionSplits.transactionId, original.id), eq(transactionSplits.note, MY_SHARE))
		)
		.get();
	const prior = linkedCorrections(db, original.id, except).map((c) => c.id);
	const priorMine =
		prior.length === 0
			? 0
			: (db
					.select({ n: sql<number>`coalesce(sum(${transactionSplits.amountCents}), 0)` })
					.from(transactionSplits)
					.where(
						and(
							inArray(transactionSplits.transactionId, prior),
							eq(transactionSplits.note, MY_SHARE)
						)
					)
					.get()?.n ?? 0);
	const ids = posts.map((p) => p.id);
	const paid = paidByOwed(db, ids);
	const fromPrior = paidByOwed(db, ids, prior);
	const payBack = payBackPosts(db, prior);
	const parts: SharePart[] = posts.map((p) => {
		const reduced =
			(fromPrior.get(p.id) ?? 0) +
			payBack.filter((b) => b.personId === p.personId).reduce((s, b) => s + b.amountCents, 0);
		return {
			owedId: p.id,
			personId: p.personId,
			shareCents: p.status === 'kwijtgescholden' ? 0 : Math.max(0, p.amountCents - reduced),
			outstandingCents: p.amountCents - (paid.get(p.id) ?? 0)
		};
	});
	return {
		mySplit: mySplit ?? null,
		mineCents: Math.max(0, -(mySplit?.amountCents ?? 0) - priorMine),
		parts
	};
}

export interface LinkOptions {
	/** Bij een voorgeschoten uitgave: naar verhouding (standaard) of eerst van jouw deel */
	mode?: CorrectionMode;
	/** Bij een verdeling over categorieën: van welke categorie hij afgaat; standaard het grootste deel */
	categoryId?: string | null;
	/** Automatisch gekoppeld bij een import (storno met `RvslInd`) */
	auto?: boolean;
}

interface Plan {
	categoryId: string | null;
	shared: {
		distribution: Distribution;
		parts: SharePart[];
		myCategoryId: string | null;
	} | null;
}

/** Rekent uit wat een koppeling doet, zonder iets te schrijven. Weigert met een ValidationError. */
function plan(db: Conn, correction: Row, original: Row, opts: LinkOptions): Plan {
	if (correction.id === original.id)
		throw new ValidationError('Een boeking verrekent zichzelf niet');
	if (original.correctionOf) throw new ValidationError('Dit is zelf al een terugboeking');
	if (correction.status === 'verwacht' || original.status === 'verwacht')
		throw new ValidationError('Een verwachte post kan niet verrekend worden');
	const existing = linkedCorrections(db, original.id, correction.id).map((c) => c.amountCents);
	const check = checkCorrection(original.amountCents, correction.amountCents, existing);
	if (!check.ok) throw new ValidationError(check.reason);
	const hasOwn =
		db
			.select({ id: transactionSplits.id })
			.from(transactionSplits)
			.where(eq(transactionSplits.transactionId, correction.id))
			.get() !== undefined ||
		db
			.select({ id: owedPayments.id })
			.from(owedPayments)
			.where(eq(owedPayments.transactionId, correction.id))
			.get() !== undefined;
	if (hasOwn)
		throw new ValidationError('Deze boeking is al gekoppeld of verdeeld; maak dat eerst los');

	const shares = original.amountCents < 0 ? currentShares(db, original, correction.id) : null;
	if (shares) {
		const distribution = distributeCorrection(
			Math.abs(correction.amountCents),
			{ mineCents: shares.mineCents, othersCents: shares.parts.map((p) => p.shareCents) },
			opts.mode ?? 'verhouding'
		);
		if (!distribution) throw new ValidationError('Deze terugboeking past niet in de verdeling');
		// Een post zonder persoon kan nog niet omlaag; alleen van jouw deel kan wel
		if (shares.parts.some((p, i) => p.personId === null && distribution.others[i]! > 0))
			throw new ValidationError('Kies eerst bij Te krijgen wie er meededen');
		const myCategoryId = shares.mySplit?.categoryId ?? original.categoryId;
		return {
			categoryId: myCategoryId,
			shared: { distribution, parts: shares.parts, myCategoryId }
		};
	}

	const splits = db
		.select()
		.from(transactionSplits)
		.where(eq(transactionSplits.transactionId, original.id))
		.all();
	if (splits.length > 0) {
		if (opts.categoryId !== undefined && opts.categoryId !== null) {
			if (!splits.some((s) => s.categoryId === opts.categoryId))
				throw new ValidationError('Deze categorie hoort niet bij de verdeling');
			return { categoryId: opts.categoryId, shared: null };
		}
		return { categoryId: largestSplit(splits)?.categoryId ?? null, shared: null };
	}
	return { categoryId: original.categoryId, shared: null };
}

function refundCategory(db: Conn): string | null {
	return (
		db
			.select({ id: categories.id })
			.from(categories)
			.where(eq(categories.name, REFUND_CATEGORY))
			.get()?.id ?? null
	);
}

/**
 * Koppelt een terugboeking aan de boeking die hij verrekent. Een eerdere koppeling van deze
 * terugboeking vervalt eerst. Rekent alles uit voordat er iets geschreven wordt, zodat een
 * ValidationError niets halverwege achterlaat. Moet binnen een database-transactie draaien.
 */
export function linkCorrection(
	db: Conn,
	correctionId: string,
	originalId: string,
	opts: LinkOptions = {}
): void {
	let correction = load(db, correctionId);
	const original = load(db, originalId);
	if (!correction || !original) throw new ValidationError('Onbekende transactie');
	if (correction.correctionOf) {
		unlinkCorrection(db, correction.id, { review: false });
		correction = load(db, correctionId)!;
	}
	const p = plan(db, correction, original, opts);

	const touchedPeople = new Set<string>();
	if (p.shared) {
		const { distribution, parts, myCategoryId } = p.shared;
		const othersTotal = distribution.others.reduce((s, c) => s + c, 0);
		// Splits zijn positief: ze verlagen de uitgave in de categorie van het origineel
		const splits = [
			...(distribution.mine > 0
				? [{ categoryId: myCategoryId, amountCents: distribution.mine, note: MY_SHARE }]
				: []),
			...(othersTotal > 0
				? [{ categoryId: refundCategory(db), amountCents: othersTotal, note: ADVANCED }]
				: [])
		];
		if (splits.length > 0)
			db.insert(transactionSplits)
				.values(splits.map((s) => ({ ...s, transactionId: correction!.id })))
				.run();
		parts.forEach((part, i) => {
			const cents = distribution.others[i]!;
			if (cents === 0 || !part.personId) return;
			const { coverCents, payBackCents } = postEffect(cents, part.outstandingCents);
			if (coverCents > 0)
				db.insert(owedPayments)
					.values({
						transactionId: correction!.id,
						personId: part.personId,
						owedId: part.owedId,
						amountCents: coverCents
					})
					.run();
			if (payBackCents > 0) {
				db.insert(owed)
					.values({
						personId: part.personId,
						direction: 'te_betalen',
						amountCents: payBackCents,
						sourceTransactionId: correction!.id,
						description: `Retour ${original.counterparty}`.trim(),
						date: correction!.date
					})
					.run();
				touchedPeople.add(part.personId);
			}
		});
		recomputeStatus(
			db,
			parts.map((x) => x.owedId)
		);
	}

	const before = {
		correctionOf: correction.correctionOf,
		categoryId: correction.categoryId,
		categorySource: correction.categorySource,
		status: correction.status
	};
	const after = {
		correctionOf: original.id,
		categoryId: p.categoryId,
		categorySource: 'correctie' as const,
		categoryRuleId: null,
		status: correction.status === 'te_controleren' ? ('bevestigd' as const) : correction.status
	};
	db.update(transactions)
		.set({ ...after, updatedAt: new Date().toISOString() })
		.where(eq(transactions.id, correction.id))
		.run();
	// Tegoed van eerder (jij betaalde al te veel terug) gaat naar de nieuwe post te betalen
	for (const personId of touchedPeople) applyCredit(db, personId);
	recordChange(
		db,
		opts.auto ? 'storno_gekoppeld' : 'correctie_gekoppeld',
		'transactions',
		correction.id,
		before,
		{
			...after,
			// De maand die verandert; is die al voorbij, dan zie je het bij die maand
			month: original.date.slice(0, 7),
			mode: p.shared ? (opts.mode ?? 'verhouding') : null,
			distribution: p.shared?.distribution ?? null
		}
	);
}

/**
 * Maakt een terugboeking los: hij wordt een gewone boeking, standaard op "te controleren".
 * Aandelen van anderen gaan terug naar wat ze waren. Geeft false als er niets gekoppeld was.
 */
export function unlinkCorrection(
	db: Conn,
	correctionId: string,
	{ review = true }: { review?: boolean } = {}
): boolean {
	const row = load(db, correctionId);
	if (!row?.correctionOf) return false;
	db.delete(transactionSplits).where(eq(transactionSplits.transactionId, row.id)).run();
	unlinkPayment(db, row.id);
	// Posten te betalen die deze terugboeking maakte. Is er al op terugbetaald, dan wordt dat
	// tegoed en gaat het naar de volgende post te betalen van die persoon.
	const payBack = payBackPosts(db, [row.id]);
	if (payBack.length > 0) {
		db.delete(owed)
			.where(
				inArray(
					owed.id,
					payBack.map((b) => b.id)
				)
			)
			.run();
		for (const personId of new Set(payBack.flatMap((b) => (b.personId ? [b.personId] : []))))
			applyCredit(db, personId);
	}
	const fromCorrection = row.categorySource === 'correctie';
	const after = {
		correctionOf: null,
		...(fromCorrection && { categoryId: null, categorySource: null, categoryRuleId: null }),
		...(review && { status: 'te_controleren' as const })
	};
	db.update(transactions)
		.set({ ...after, updatedAt: new Date().toISOString() })
		.where(eq(transactions.id, row.id))
		.run();
	recordChange(
		db,
		'correctie_losgemaakt',
		'transactions',
		row.id,
		{
			correctionOf: row.correctionOf,
			categoryId: row.categoryId,
			categorySource: row.categorySource,
			status: row.status,
			payBack
		},
		after
	);
	return true;
}

/** Bij het verwijderen van een boeking worden de terugboekingen erop weer gewone boekingen. */
export function releaseCorrectionsOf(db: Conn, originalId: string): string[] {
	const ids = linkedCorrections(db, originalId).map((c) => c.id);
	for (const id of ids) unlinkCorrection(db, id);
	return ids;
}

/** Wat er al terugkwam op een boeking, positief. */
export function correctedCents(db: Conn, originalId: string): number {
	return linkedCorrections(db, originalId).reduce((s, c) => s + Math.abs(c.amountCents), 0);
}

/** Wat er nog terug kan op een boeking. */
export function roomFor(db: Conn, original: Pick<Row, 'id' | 'amountCents'>, except?: string) {
	return correctionRoom(
		original.amountCents,
		linkedCorrections(db, original.id, except).map((c) => c.amountCents)
	);
}

/**
 * Koppellijst voor een retour: boekingen de andere kant op bij dezelfde tegenpartij (naam of
 * IBAN) in de 60 dagen ervoor, waar het bedrag nog in past. Een lager bedrag dan de uitgave telt
 * niet als afwijking.
 */
export function correctionCandidates(db: Conn, correctionId: string) {
	const row = load(db, correctionId);
	if (!row || row.amountCents === 0 || row.correctionOf || row.status === 'verwacht') {
		return { candidates: [], preselect: null };
	}
	const rows = db
		.select({
			id: transactions.id,
			amountCents: transactions.amountCents,
			date: transactions.date,
			counterparty: transactions.counterparty,
			counterIban: transactions.counterIban,
			categoryName: categories.name
		})
		.from(transactions)
		.leftJoin(categories, eq(categories.id, transactions.categoryId))
		.where(
			and(
				gte(transactions.date, addDays(row.date, -REFUND_WINDOW_DAYS)),
				lte(transactions.date, row.date),
				row.amountCents > 0
					? sql`${transactions.amountCents} < 0`
					: sql`${transactions.amountCents} > 0`,
				isNull(transactions.correctionOf),
				ne(transactions.status, 'verwacht'),
				ne(transactions.id, row.id)
			)
		)
		.orderBy(desc(transactions.date))
		.limit(500)
		.all();
	const sameParty = rows.filter(
		(r) =>
			(row.counterIban !== null && r.counterIban === row.counterIban) ||
			nameScore(row.counterparty, r.counterparty) >= SAME_NAME
	);
	const amount = Math.abs(row.amountCents);
	const targets = sameParty.flatMap((r) => {
		const room = roomFor(db, r);
		return room >= amount
			? [
					{
						id: r.id,
						amountCents: room,
						date: r.date,
						name: r.counterparty,
						ibans: r.counterIban ? [r.counterIban] : [],
						row: { ...r, roomCents: room }
					} satisfies MatchTarget & { row: unknown }
				]
			: [];
	});
	const result = rankMatches(
		{ amountCents: amount, date: row.date, name: row.counterparty, iban: row.counterIban },
		targets,
		{ lower: 'vol' }
	);
	return {
		preselect: result.preselect,
		candidates: result.candidates.map((c) => {
			const { counterIban: _iban, ...rest } = c.target.row;
			return {
				...rest,
				shared: hasPosts(db, c.target.id),
				splitCategories: splitCategories(db, c.target.id),
				score: c.score,
				label: c.label
			};
		})
	};
}

function hasPosts(db: Conn, id: string): boolean {
	return (
		db
			.select({ id: owed.id })
			.from(owed)
			.where(and(eq(owed.sourceTransactionId, id), eq(owed.direction, 'te_krijgen')))
			.get() !== undefined
	);
}

/** Categorieën van een verdeling over categorieën (niet voorgeschoten), grootste eerst. */
function splitCategories(db: Conn, id: string) {
	if (hasPosts(db, id)) return [];
	return db
		.select({
			categoryId: transactionSplits.categoryId,
			name: categories.name,
			amountCents: transactionSplits.amountCents
		})
		.from(transactionSplits)
		.leftJoin(categories, eq(categories.id, transactionSplits.categoryId))
		.where(eq(transactionSplits.transactionId, id))
		.orderBy(asc(transactionSplits.amountCents))
		.all();
}

/**
 * Storno uit een import (`RvslInd`): de eerdere boeking met hetzelfde tegen-IBAN en
 * end-to-end-kenmerk, de andere kant op. Alleen als er precies één is.
 */
export function findReversedOriginal(db: Conn, correctionId: string): Row | null {
	const row = load(db, correctionId);
	if (!row?.counterIban || !row.endToEndId) return null;
	const found = db
		.select()
		.from(transactions)
		.where(
			and(
				eq(transactions.counterIban, row.counterIban),
				eq(transactions.endToEndId, row.endToEndId),
				ne(transactions.id, row.id),
				isNull(transactions.correctionOf),
				ne(transactions.status, 'verwacht'),
				lte(transactions.date, row.date),
				row.amountCents > 0
					? sql`${transactions.amountCents} < 0`
					: sql`${transactions.amountCents} > 0`
			)
		)
		.limit(2)
		.all();
	return found.length === 1 ? found[0]! : null;
}

/** Wat een boeking verrekent, of wat erop verrekend is, voor de detailpagina. */
export function correctionInfo(db: Conn, id: string) {
	const row = load(db, id);
	if (!row) return null;
	const summary = (t: Row) => ({
		id: t.id,
		amountCents: t.amountCents,
		date: t.date,
		counterparty: t.counterparty,
		categoryName: t.categoryId
			? (db
					.select({ name: categories.name })
					.from(categories)
					.where(eq(categories.id, t.categoryId))
					.get()?.name ?? null)
			: null
	});
	const original = row.correctionOf ? load(db, row.correctionOf) : undefined;
	const corrections = db
		.select()
		.from(transactions)
		.where(eq(transactions.correctionOf, row.id))
		.orderBy(asc(transactions.date), asc(transactions.createdAt))
		.all();
	let shared: {
		mineCents: number;
		parts: { personName: string; cents: number; payBackCents: number }[];
		/** Hoe het verdeeld zou zijn met de andere keuze; null als die op hetzelfde uitkomt */
		alternative: CorrectionMode | null;
		mode: CorrectionMode;
	} | null = null;
	if (original) {
		const shares = currentShares(db, original, row.id);
		if (shares) {
			const mine =
				db
					.select({ n: sql<number>`coalesce(sum(${transactionSplits.amountCents}), 0)` })
					.from(transactionSplits)
					.where(
						and(eq(transactionSplits.transactionId, row.id), eq(transactionSplits.note, MY_SHARE))
					)
					.get()?.n ?? 0;
			const paidFrom = paidByOwed(
				db,
				shares.parts.map((p) => p.owedId),
				[row.id]
			);
			const payBack = payBackPosts(db, [row.id]);
			const names = new Map(
				db
					.select({ id: owed.id, name: people.name })
					.from(owed)
					.leftJoin(people, eq(people.id, owed.personId))
					.where(
						inArray(
							owed.id,
							shares.parts.map((p) => p.owedId)
						)
					)
					.all()
					.map((r) => [r.id, r.name])
			);
			const parts = shares.parts
				.map((p) => {
					const back = payBack
						.filter((b) => b.personId === p.personId)
						.reduce((s, b) => s + b.amountCents, 0);
					return {
						personName: names.get(p.owedId) ?? 'Nog onbekend',
						cents: (paidFrom.get(p.owedId) ?? 0) + back,
						payBackCents: back
					};
				})
				.filter((p) => p.cents > 0);
			const state = {
				mineCents: shares.mineCents,
				othersCents: shares.parts.map((p) => p.shareCents)
			};
			const amount = Math.abs(row.amountCents);
			const asMineOnly = distributeCorrection(amount, state, 'mijn_deel');
			const proportional = distributeCorrection(amount, state, 'verhouding');
			const mode: CorrectionMode =
				asMineOnly && asMineOnly.mine === mine && proportional?.mine !== mine
					? 'mijn_deel'
					: 'verhouding';
			const other = mode === 'mijn_deel' ? proportional : asMineOnly;
			shared = {
				mineCents: mine,
				parts,
				mode,
				alternative:
					other && other.mine !== mine ? (mode === 'mijn_deel' ? 'verhouding' : 'mijn_deel') : null
			};
		}
	}
	return {
		original: original ? summary(original) : null,
		shared,
		auto: original ? autoLinked(db, row.id) : false,
		corrections: corrections.map(summary),
		roomCents: row.correctionOf ? 0 : roomFor(db, row)
	};
}

/** Of de laatste koppeling automatisch gebeurde (storno bij een import). */
function autoLinked(db: Conn, id: string): boolean {
	const last = db
		.select({ action: auditLog.action })
		.from(auditLog)
		.where(
			and(
				eq(auditLog.entity, 'transactions'),
				eq(auditLog.entityId, id),
				inArray(auditLog.action, [
					'storno_gekoppeld',
					'correctie_gekoppeld',
					'correctie_losgemaakt'
				])
			)
		)
		.orderBy(desc(auditLog.at), desc(sql`audit_log.rowid`))
		.get();
	return last?.action === 'storno_gekoppeld';
}

/**
 * Uitgaven van de laatste 60 dagen waar een retour bij kan horen, voor de snelinvoer in de
 * browser. Zonder IBANs.
 */
export function refundTargets(db: Conn, today: string, limit = 300) {
	const rows = db
		.select({
			id: transactions.id,
			amountCents: transactions.amountCents,
			date: transactions.date,
			counterparty: transactions.counterparty,
			categoryId: transactions.categoryId
		})
		.from(transactions)
		.where(
			and(
				gte(transactions.date, addDays(today, -REFUND_WINDOW_DAYS)),
				sql`${transactions.amountCents} < 0`,
				isNull(transactions.correctionOf),
				ne(transactions.status, 'verwacht'),
				sql`${transactions.counterparty} != ''`
			)
		)
		.orderBy(desc(transactions.date))
		.limit(limit)
		.all();
	if (rows.length === 0) return [];
	const used = new Map(
		db
			.select({
				id: transactions.correctionOf,
				n: sql<number>`sum(abs(${transactions.amountCents}))`
			})
			.from(transactions)
			.where(
				inArray(
					transactions.correctionOf,
					rows.map((r) => r.id)
				)
			)
			.groupBy(transactions.correctionOf)
			.all()
			.map((r) => [r.id!, r.n])
	);
	return rows
		.map((r) => ({ ...r, roomCents: -r.amountCents - (used.get(r.id) ?? 0) }))
		.filter((r) => r.roomCents > 0);
}

/**
 * Terugboekingen die na afloop van een maand binnenkwamen maar in die maand verrekend worden.
 * Zo zie je bij een voorbije maand dat er iets veranderde (spec: Verrekenen in de oorspronkelijke maand).
 */
export function lateCorrections(db: Conn, month: string) {
	return db.all<{ id: string; counterparty: string; amountCents: number; date: string }>(sql`
		SELECT t.id, t.counterparty, t.amount_cents AS amountCents, t.date
		FROM transactions t
		JOIN transactions o ON o.id = t.correction_of
		WHERE o.date BETWEEN ${`${month}-01`} AND ${`${month}-31`} AND t.date > ${`${month}-31`}
		ORDER BY t.date, t.created_at
	`);
}
