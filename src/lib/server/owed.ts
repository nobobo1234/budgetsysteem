import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { rankMatches, type MatchTarget } from '../match.ts';
import {
	allocatePayment,
	daysBetween,
	owedStatus,
	REMIND_AFTER_DAYS,
	splitByAmounts,
	splitEqually,
	type Share
} from '../owed.ts';
import { recordChange } from './audit.ts';
import type { Conn, DB } from './db/index.ts';
import {
	categories,
	owed,
	owedPayments,
	people,
	transactionSplits,
	transactions
} from './db/schema.ts';
import { ValidationError } from './errors.ts';
import { findOrCreatePerson, peopleWithIbans, personByIban } from './people.ts';

// Nog te krijgen (spec: Nog te krijgen). Een uitgave die je voorschiet krijgt splits: jouw deel
// in de categorie, de rest in Terugbetaling (buiten budget), met per persoon een openstaande
// post. Betalingen staan in `owed_payments`: één betaling kan meer posten dekken en andersom.

export const REFUND_CATEGORY = 'Terugbetaling';
export const MY_SHARE = 'Mijn deel';
export const ADVANCED = 'Voorgeschoten';

export type Direction = 'te_krijgen' | 'te_betalen';
const OPEN = ['open', 'deels'] as const;

export function refundCategory(db: Conn): string | null {
	return (
		db
			.select({ id: categories.id })
			.from(categories)
			.where(eq(categories.name, REFUND_CATEGORY))
			.get()?.id ?? null
	);
}

/** Hoeveel er per post betaald is. */
export function paidByOwed(db: Conn, ids: readonly string[]): Map<string, number> {
	if (ids.length === 0) return new Map();
	const rows = db
		.select({ owedId: owedPayments.owedId, paid: sql<number>`sum(${owedPayments.amountCents})` })
		.from(owedPayments)
		.where(inArray(owedPayments.owedId, [...ids]))
		.groupBy(owedPayments.owedId)
		.all();
	return new Map(rows.map((r) => [r.owedId!, r.paid]));
}

/** Zet de status van posten opnieuw uit wat erop betaald is. */
export function recomputeStatus(db: Conn, ids: readonly string[]): void {
	if (ids.length === 0) return;
	const paid = paidByOwed(db, ids);
	const rows = db
		.select()
		.from(owed)
		.where(inArray(owed.id, [...ids]))
		.all();
	for (const row of rows) {
		const status = owedStatus(
			row.amountCents,
			paid.get(row.id) ?? 0,
			row.status === 'kwijtgescholden'
		);
		if (status !== row.status) db.update(owed).set({ status }).where(eq(owed.id, row.id)).run();
	}
}

/** Open posten van een persoon in één richting, oudste eerst, met wat er nog openstaat. */
export function openItems(db: Conn, personId: string, direction: Direction, first?: string | null) {
	const rows = db
		.select({ id: owed.id, amountCents: owed.amountCents, date: owed.date })
		.from(owed)
		.where(
			and(
				eq(owed.personId, personId),
				eq(owed.direction, direction),
				inArray(owed.status, [...OPEN])
			)
		)
		.orderBy(asc(owed.date), asc(owed.createdAt), asc(sql`owed.rowid`))
		.all();
	const paid = paidByOwed(
		db,
		rows.map((r) => r.id)
	);
	const items = rows.map((r) => ({
		id: r.id,
		outstandingCents: r.amountCents - (paid.get(r.id) ?? 0)
	}));
	if (first) {
		const i = items.findIndex((r) => r.id === first);
		if (i > 0) items.unshift(...items.splice(i, 1));
	}
	return items;
}

export const directionOf = (amountCents: number): Direction =>
	amountCents > 0 ? 'te_krijgen' : 'te_betalen';

/**
 * Tegoed van een persoon (betalingen zonder post) gaat naar zijn open posten, oudste eerst.
 * Een binnenkomende betaling dekt posten te krijgen, een uitgaande posten te betalen.
 */
export function applyCredit(db: Conn, personId: string): void {
	const credits = db
		.select({
			id: owedPayments.id,
			transactionId: owedPayments.transactionId,
			amountCents: owedPayments.amountCents,
			txAmount: transactions.amountCents
		})
		.from(owedPayments)
		.innerJoin(transactions, eq(transactions.id, owedPayments.transactionId))
		.where(and(eq(owedPayments.personId, personId), isNull(owedPayments.owedId)))
		.orderBy(asc(transactions.date), asc(owedPayments.createdAt))
		.all();
	const touched = new Set<string>();
	for (const credit of credits) {
		const items = openItems(db, personId, directionOf(credit.txAmount));
		const { allocations, creditCents } = allocatePayment(credit.amountCents, items);
		if (allocations.length === 0) continue;
		db.delete(owedPayments).where(eq(owedPayments.id, credit.id)).run();
		db.insert(owedPayments)
			.values([
				...allocations.map((a) => ({
					transactionId: credit.transactionId,
					personId,
					owedId: a.id,
					amountCents: a.cents
				})),
				...(creditCents > 0
					? [
							{
								transactionId: credit.transactionId,
								personId,
								owedId: null,
								amountCents: creditCents
							}
						]
					: [])
			])
			.run();
		for (const a of allocations) touched.add(a.id);
		recomputeStatus(db, [...touched]);
	}
}

export interface SettleTarget {
	/** De gekozen post; de rest gaat oudste eerst naar de andere posten van die persoon */
	owedId?: string | null;
	personId?: string | null;
}

/**
 * Koppelt een betaling aan een persoon. Een eerdere koppeling van deze transactie vervalt eerst.
 * Geeft false als er niets te koppelen viel (onbekende of verkeerde post), zodat de aanroeper
 * de transactie kan laten controleren in plaats van iets te raden.
 */
export function settlePayment(db: Conn, transactionId: string, target: SettleTarget): boolean {
	const payment = db.select().from(transactions).where(eq(transactions.id, transactionId)).get();
	if (!payment || payment.amountCents === 0) return false;
	const direction = directionOf(payment.amountCents);
	let personId = target.personId ?? null;
	if (target.owedId) {
		const post = db.select().from(owed).where(eq(owed.id, target.owedId)).get();
		if (!post || post.direction !== direction || !post.personId) return false;
		if (personId && personId !== post.personId) return false;
		personId = post.personId;
	}
	if (!personId) return false;
	if (!db.select({ id: people.id }).from(people).where(eq(people.id, personId)).get()) return false;

	const before = unlinkPayment(db, transactionId);
	const items = openItems(db, personId, direction, target.owedId);
	const { allocations, creditCents } = allocatePayment(Math.abs(payment.amountCents), items);
	db.insert(owedPayments)
		.values([
			...allocations.map((a) => ({
				transactionId,
				personId: personId!,
				owedId: a.id,
				amountCents: a.cents
			})),
			...(creditCents > 0
				? [{ transactionId, personId: personId!, owedId: null, amountCents: creditCents }]
				: [])
		])
		.run();
	recomputeStatus(db, [...new Set([...before, ...allocations.map((a) => a.id)])]);
	recordChange(db, 'gekoppeld', 'owed_payments', transactionId, null, {
		personId,
		allocations,
		creditCents
	});
	return true;
}

/** Maakt de koppeling van een betaling los; geeft de posten die geraakt werden. */
export function unlinkPayment(db: Conn, transactionId: string): string[] {
	const rows = db
		.select()
		.from(owedPayments)
		.where(eq(owedPayments.transactionId, transactionId))
		.all();
	if (rows.length === 0) return [];
	db.delete(owedPayments).where(eq(owedPayments.transactionId, transactionId)).run();
	const ids = [...new Set(rows.flatMap((r) => (r.owedId ? [r.owedId] : [])))];
	recomputeStatus(db, ids);
	recordChange(db, 'losgemaakt', 'owed_payments', transactionId, rows, null);
	return ids;
}

export interface ShareInput {
	/** Per ander: een persoon (ID) of null als je nog niet weet wie (`voor 3` zonder namen) */
	personIds: (string | null)[];
	/** Bedrag per persoon; zonder bedragen wordt gelijk verdeeld */
	amounts?: number[] | null;
}

/** Namen uit de snelinvoer naar personen; onbekende namen worden een nieuwe persoon. */
export function shareFromNames(db: Conn, people: number, names: readonly string[]): ShareInput {
	const ids = names.map((n) => findOrCreatePerson(db, n));
	if (new Set(ids).size !== ids.length) throw new ValidationError('Iemand staat er twee keer in');
	const unnamed = Math.max(0, people - 1 - ids.length);
	return { personIds: [...ids, ...Array<null>(unnamed).fill(null)] };
}

/**
 * Zet of vervangt de verdeling van een uitgave. Posten waarop al betaald of die kwijtgescholden
 * zijn, blijven staan: dan weigert de server een nieuwe verdeling.
 */
export function applyShare(
	db: Conn,
	transactionId: string,
	input: ShareInput | null
): Share | null {
	const row = db.select().from(transactions).where(eq(transactions.id, transactionId)).get();
	if (!row) throw new ValidationError('Onbekende transactie');
	const existing = db.select().from(owed).where(eq(owed.sourceTransactionId, transactionId)).all();
	if (existing.some((o) => o.shareId !== null))
		throw new ValidationError(
			'Deze afschrijving is gedeeld via de vaste last; pas daar de aandelen aan'
		);
	const paid = paidByOwed(
		db,
		existing.map((o) => o.id)
	);
	if (existing.some((o) => (paid.get(o.id) ?? 0) > 0 || o.status === 'kwijtgescholden')) {
		throw new ValidationError(
			'Er is al betaald of kwijtgescholden; pas de posten aan bij Te krijgen'
		);
	}
	if (input && row.amountCents >= 0) throw new ValidationError('Alleen een uitgave kun je delen');
	if (input && input.personIds.length === 0) throw new ValidationError('Kies minstens één persoon');
	const named = input?.personIds.filter((p): p is string => p !== null) ?? [];
	if (new Set(named).size !== named.length)
		throw new ValidationError('Iemand staat er twee keer in');

	const total = -row.amountCents;
	let share: Share | null = null;
	if (input) {
		if (input.amounts) {
			if (input.amounts.length !== input.personIds.length)
				throw new ValidationError('Bedragen kloppen niet met de personen');
			const result = splitByAmounts(total, input.amounts);
			if (!result.ok) throw new ValidationError(result.reason);
			share = result.share;
		} else {
			share = splitEqually(total, input.personIds.length + 1);
		}
	}

	db.delete(owed).where(eq(owed.sourceTransactionId, transactionId)).run();
	db.delete(transactionSplits)
		.where(
			and(
				eq(transactionSplits.transactionId, transactionId),
				inArray(transactionSplits.note, [MY_SHARE, ADVANCED])
			)
		)
		.run();

	if (input && share) {
		const othersTotal = share.others.reduce((s, n) => s + n, 0);
		db.insert(transactionSplits)
			.values([
				{ transactionId, categoryId: row.categoryId, amountCents: -share.mine, note: MY_SHARE },
				{
					transactionId,
					categoryId: refundCategory(db),
					amountCents: -othersTotal,
					note: ADVANCED
				}
			])
			.run();
		const posts = input.personIds
			.map((personId, i) => ({
				personId,
				amountCents: share!.others[i]!,
				direction: 'te_krijgen' as const,
				sourceTransactionId: transactionId,
				description: row.counterparty,
				date: row.date
			}))
			.filter((p) => p.amountCents > 0);
		if (posts.length > 0) db.insert(owed).values(posts).run();
		for (const personId of new Set(named)) applyCredit(db, personId);
	}
	recordChange(db, 'verdeling', 'transactions', transactionId, existing, share);
	return share;
}

export interface NewOwed {
	personId: string;
	direction: Direction;
	amountCents: number;
	description: string;
	date: string;
	note?: string;
	tikkieUrl?: string | null;
}

/** Een losse post zonder uitgave, zoals contant voorgeschoten of iets wat jij nog moet betalen. */
export function createOwed(db: DB, input: NewOwed): string {
	return db.transaction((tx) => {
		if (!tx.select({ id: people.id }).from(people).where(eq(people.id, input.personId)).get())
			throw new ValidationError('Onbekende persoon');
		const row = tx
			.insert(owed)
			.values({
				personId: input.personId,
				direction: input.direction,
				amountCents: input.amountCents,
				description: input.description,
				date: input.date,
				note: input.note ?? '',
				tikkieUrl: input.tikkieUrl ?? null
			})
			.returning()
			.get();
		recordChange(tx, 'aangemaakt', 'owed', row.id, null, row);
		applyCredit(tx, input.personId);
		return row.id;
	});
}

export interface OwedPatch {
	personId?: string;
	note?: string;
	tikkieUrl?: string | null;
	description?: string;
}

export function updateOwed(db: DB, id: string, patch: OwedPatch): void {
	db.transaction((tx) => {
		const before = tx.select().from(owed).where(eq(owed.id, id)).get();
		if (!before) throw new ValidationError('Onbekende post');
		if (patch.personId !== undefined && patch.personId !== before.personId) {
			if (before.shareId)
				throw new ValidationError('Dit is een aandeel in een vaste last; pas het daar aan');
			if (!tx.select({ id: people.id }).from(people).where(eq(people.id, patch.personId)).get())
				throw new ValidationError('Onbekende persoon');
			const paid = paidByOwed(tx, [id]).get(id) ?? 0;
			if (paid > 0) throw new ValidationError('Op deze post is al betaald door iemand anders');
		}
		const after = tx.update(owed).set(patch).where(eq(owed.id, id)).returning().get();
		recordChange(tx, 'gewijzigd', 'owed', id, before, after);
		if (after.personId && after.personId !== before.personId) applyCredit(tx, after.personId);
	});
}

/** Alleen een losse post; een post van een gedeelde uitgave pas je aan via de verdeling. */
export function deleteOwed(db: DB, id: string): void {
	db.transaction((tx) => {
		const before = tx.select().from(owed).where(eq(owed.id, id)).get();
		if (!before) throw new ValidationError('Onbekende post');
		if (before.sourceTransactionId)
			throw new ValidationError('Deze post hoort bij een uitgave; pas daar de verdeling aan');
		// Betalingen op deze post worden tegoed (owed_payments.owed_id → null)
		tx.delete(owed).where(eq(owed.id, id)).run();
		recordChange(tx, 'verwijderd', 'owed', id, before, null);
		if (before.personId) applyCredit(tx, before.personId);
	});
}

/**
 * Kwijtschelden: wat nog openstaat komt voor jouw rekening. Bij een gedeelde uitgave schuift dat
 * deel in de oorspronkelijke maand van Terugbetaling naar de categorie van de uitgave.
 * Met `undo` draai je het terug.
 */
export function forgiveOwed(db: DB, id: string, undo = false): void {
	db.transaction((tx) => {
		const before = tx.select().from(owed).where(eq(owed.id, id)).get();
		if (!before) throw new ValidationError('Onbekende post');
		if (undo ? before.status !== 'kwijtgescholden' : !OPEN.includes(before.status as never))
			throw new ValidationError(
				undo ? 'Deze post is niet kwijtgescholden' : 'Deze post staat niet open'
			);
		const paid = paidByOwed(tx, [id]).get(id) ?? 0;
		const rest = before.amountCents - paid;
		const status = undo ? owedStatus(before.amountCents, paid) : 'kwijtgescholden';
		tx.update(owed).set({ status }).where(eq(owed.id, id)).run();
		if (before.sourceTransactionId && before.direction === 'te_krijgen' && rest > 0) {
			// Splits zijn negatief: jouw deel wordt groter, het voorgeschoten deel kleiner
			const delta = undo ? -rest : rest;
			const shift = (note: string, cents: number) =>
				tx
					.update(transactionSplits)
					.set({ amountCents: sql`${transactionSplits.amountCents} + ${cents}` })
					.where(
						and(
							eq(transactionSplits.transactionId, before.sourceTransactionId!),
							eq(transactionSplits.note, note)
						)
					)
					.run();
			shift(MY_SHARE, -delta);
			shift(ADVANCED, delta);
		}
		recordChange(tx, undo ? 'kwijtschelden_ongedaan' : 'kwijtgescholden', 'owed', id, before, {
			status
		});
	});
}

export interface OpenPost {
	id: string;
	personId: string | null;
	personName: string | null;
	direction: Direction;
	amountCents: number;
	outstandingCents: number;
	description: string;
	date: string;
	status: 'open' | 'deels';
	tikkieUrl: string | null;
	note: string;
	sourceTransactionId: string | null;
}

/** Alle open posten met wat er nog openstaat, oudste eerst. */
export function openPosts(db: Conn): OpenPost[] {
	const rows = db
		.select({
			id: owed.id,
			personId: owed.personId,
			personName: people.name,
			direction: owed.direction,
			amountCents: owed.amountCents,
			description: owed.description,
			date: owed.date,
			status: owed.status,
			tikkieUrl: owed.tikkieUrl,
			note: owed.note,
			sourceTransactionId: owed.sourceTransactionId
		})
		.from(owed)
		.leftJoin(people, eq(people.id, owed.personId))
		.where(inArray(owed.status, [...OPEN]))
		.orderBy(asc(owed.date), asc(owed.createdAt), asc(sql`owed.rowid`))
		.all();
	const paid = paidByOwed(
		db,
		rows.map((r) => r.id)
	);
	return rows.map((r) => ({
		...r,
		status: r.status as 'open' | 'deels',
		outstandingCents: r.amountCents - (paid.get(r.id) ?? 0)
	}));
}

export interface PersonBalance {
	personId: string | null;
	name: string | null;
	/** Wat deze persoon jou nog moet */
	toReceiveCents: number;
	/** Wat jij deze persoon nog moet */
	toPayCents: number;
	/** Betaald zonder post: gaat naar de volgende post */
	creditCents: number;
	oldestDate: string | null;
	posts: (OpenPost & { daysOpen: number; remind: boolean })[];
}

/** Tegoed per persoon: betalingen zonder post, naar richting van de betaling. */
function credits(db: Conn): Map<string, number> {
	const rows = db
		.select({
			personId: owedPayments.personId,
			cents: sql<number>`sum(${owedPayments.amountCents})`
		})
		.from(owedPayments)
		.where(isNull(owedPayments.owedId))
		.groupBy(owedPayments.personId)
		.all();
	return new Map(rows.map((r) => [r.personId, r.cents]));
}

/** Overzicht Te krijgen: totalen, en per persoon de open posten met hoe lang ze openstaan. */
export function owedOverview(db: Conn, today: string) {
	const posts = openPosts(db);
	const credit = credits(db);
	const byPerson = new Map<string, PersonBalance>();
	for (const p of posts) {
		const key = p.personId ?? '';
		let entry = byPerson.get(key);
		if (!entry) {
			entry = {
				personId: p.personId,
				name: p.personName,
				toReceiveCents: 0,
				toPayCents: 0,
				creditCents: p.personId ? (credit.get(p.personId) ?? 0) : 0,
				oldestDate: null,
				posts: []
			};
			byPerson.set(key, entry);
		}
		if (p.direction === 'te_krijgen') entry.toReceiveCents += p.outstandingCents;
		else entry.toPayCents += p.outstandingCents;
		entry.oldestDate ??= p.date;
		const daysOpen = Math.max(0, daysBetween(p.date, today));
		entry.posts.push({
			...p,
			daysOpen,
			remind: p.direction === 'te_krijgen' && daysOpen >= REMIND_AFTER_DAYS
		});
	}
	// Tegoed zonder open posten staat er ook
	for (const [personId, cents] of credit) {
		if (byPerson.has(personId)) continue;
		const person = db
			.select({ name: people.name })
			.from(people)
			.where(eq(people.id, personId))
			.get();
		byPerson.set(personId, {
			personId,
			name: person?.name ?? null,
			toReceiveCents: 0,
			toPayCents: 0,
			creditCents: cents,
			oldestDate: null,
			posts: []
		});
	}
	// Wie het langst openstaat bovenaan; posten zonder persoon eerst, die vragen om een keuze
	const list = [...byPerson.values()].sort((a, b) => {
		if ((a.personId === null) !== (b.personId === null)) return a.personId === null ? -1 : 1;
		return (a.oldestDate ?? '9999').localeCompare(b.oldestDate ?? '9999');
	});
	return {
		toReceiveCents: list.reduce((s, p) => s + p.toReceiveCents, 0),
		toPayCents: list.reduce((s, p) => s + p.toPayCents, 0),
		creditCents: list.reduce((s, p) => s + p.creditCents, 0),
		people: list
	};
}

/**
 * Posten die 14 dagen of langer openstaan. Aanhaakpunt voor de herinnering: de review-inbox
 * (fase 3) en de pushmelding "een Tikkie staat 14 dagen open" gebruiken deze lijst.
 */
export function owedReminders(db: Conn, today: string) {
	return openPosts(db).filter(
		(p) => p.direction === 'te_krijgen' && daysBetween(p.date, today) >= REMIND_AFTER_DAYS
	);
}

/** Kort overzicht voor het startscherm. */
export function owedSummary(db: Conn) {
	const posts = openPosts(db);
	const toReceive = posts.filter((p) => p.direction === 'te_krijgen');
	return {
		toReceiveCents: toReceive.reduce((s, p) => s + p.outstandingCents, 0),
		people: new Set(toReceive.map((p) => p.personId ?? p.id)).size
	};
}

/** Open posten voor de koppellijst in de snelinvoer: zonder IBANs, alleen met een persoon. */
export function matchablePosts(db: Conn) {
	return openPosts(db)
		.filter((p) => p.personId !== null)
		.map((p) => ({
			id: p.id,
			personId: p.personId!,
			personName: p.personName ?? '',
			direction: p.direction,
			outstandingCents: p.outstandingCents,
			description: p.description,
			date: p.date
		}));
}

/** Koppellijst op de server voor een bestaande transactie; hier telt een bekende IBAN mee. */
export function matchCandidates(db: Conn, transactionId: string) {
	const tx = db.select().from(transactions).where(eq(transactions.id, transactionId)).get();
	if (!tx || tx.amountCents === 0) return { candidates: [], preselect: null };
	const direction = directionOf(tx.amountCents);
	const ibans = peopleWithIbans(db);
	const targets: (MatchTarget & { post: ReturnType<typeof matchablePosts>[number] })[] =
		matchablePosts(db)
			.filter((p) => p.direction === direction)
			.map((p) => ({
				id: p.id,
				amountCents: p.outstandingCents,
				date: p.date,
				name: p.personName,
				ibans: ibans.get(p.personId) ?? [],
				post: p
			}));
	const result = rankMatches(
		{
			amountCents: Math.abs(tx.amountCents),
			date: tx.date,
			name: `${tx.counterparty} ${tx.description}`,
			iban: tx.counterIban
		},
		targets,
		{ lower: 'deels' }
	);
	return {
		preselect: result.preselect,
		candidates: result.candidates.map((c) => ({
			...c.target.post,
			score: c.score,
			label: c.label
		})),
		ibanPerson: personByIban(db, tx.counterIban)
	};
}

/** Koppelingen van een betaling, voor de detailpagina. */
export function paymentLinks(db: Conn, transactionId: string) {
	return db
		.select({
			id: owedPayments.id,
			owedId: owedPayments.owedId,
			personId: owedPayments.personId,
			personName: people.name,
			amountCents: owedPayments.amountCents,
			description: owed.description,
			date: owed.date
		})
		.from(owedPayments)
		.innerJoin(people, eq(people.id, owedPayments.personId))
		.leftJoin(owed, eq(owed.id, owedPayments.owedId))
		.where(eq(owedPayments.transactionId, transactionId))
		.all();
}

/** Posten van een gedeelde uitgave met wat erop betaald is, voor de detailpagina. */
export function postsOfTransaction(db: Conn, transactionId: string) {
	const rows = db
		.select({
			id: owed.id,
			personId: owed.personId,
			personName: people.name,
			amountCents: owed.amountCents,
			status: owed.status
		})
		.from(owed)
		.leftJoin(people, eq(people.id, owed.personId))
		.where(eq(owed.sourceTransactionId, transactionId))
		.orderBy(asc(owed.createdAt), asc(sql`owed.rowid`))
		.all();
	const paid = paidByOwed(
		db,
		rows.map((r) => r.id)
	);
	return rows.map((r) => ({ ...r, paidCents: paid.get(r.id) ?? 0 }));
}
