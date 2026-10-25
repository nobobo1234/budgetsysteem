import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { addDays, shiftMonth, toIsoDate } from '../dates.ts';
import { occurrenceMonth } from '../recurring.ts';
import {
	checkShares,
	detectShareProposals,
	FULL,
	isActive,
	lastMonths,
	monthState,
	receiveDate,
	shareCents,
	splitShared,
	type MonthState,
	type ShareKind
} from '../shares.ts';
import { isValidIban, normalizeCounterparty, normalizeIban } from '../text.ts';
import { recordChange } from './audit.ts';
import type { Conn, DB } from './db/index.ts';
import {
	accounts,
	categories,
	owed,
	owedPayments,
	people,
	peopleIbans,
	recurring,
	recurringShares,
	shareDismissals,
	transactionSplits,
	transactions
} from './db/schema.ts';
import { INTERNAL_TRANSFER } from './db/seed.ts';
import { ValidationError } from './errors.ts';
import {
	ADVANCED,
	applyCredit,
	MY_SHARE,
	openItems,
	paidByOwed,
	recomputeStatus,
	refundCategory,
	settlePayment
} from './owed.ts';
import { findOrCreatePerson, ibansOf, personByIban } from './people.ts';

// Gedeelde vaste lasten (spec: Gedeelde vaste lasten). Een aandeel per persoon per vaste last;
// elke maand met een afschrijving krijgt ieder met een actief aandeel een openstaande post
// (`owed` met `share_id` en `month`). De afschrijving krijgt splits: jouw deel in de categorie
// van de vaste last, de aandelen in Terugbetaling. Zo telt in het budget alleen jouw deel.
// IBANs van huisgenoten zijn persoonsgegevens: nooit in logs, het audit-log of de browser.

export type ShareRow = typeof recurringShares.$inferSelect;

const SPLIT_NOTES = [MY_SHARE, ADVANCED];
/** Een al met één tik bevestigde ontvangst en de overboeking uit de bank: zo ver uit elkaar. */
export const MERGE_DAYS = 10;
/** Hoe ver terug voorstellen uit de historie kijken. */
const PROPOSAL_MONTHS = 8;

function sharesOf(db: Conn, recurringId: string): ShareRow[] {
	return db
		.select()
		.from(recurringShares)
		.where(eq(recurringShares.recurringId, recurringId))
		.orderBy(asc(recurringShares.createdAt), asc(sql`recurring_shares.rowid`))
		.all();
}

function activeShares(db: Conn, recurringId: string, month: string): ShareRow[] {
	return sharesOf(db, recurringId).filter((s) => isActive(s, month));
}

/** Jouw deel van `totalCents` in `month`: wat overblijft na de aandelen van de anderen. */
export function myShareCents(
	db: Conn,
	recurringId: string,
	totalCents: number,
	month: string
): number {
	const shares = activeShares(db, recurringId, month);
	return shares.length === 0 ? totalCents : splitShared(totalCents, shares).mine;
}

/** Heeft deze vaste last aandelen (in welke maand ook)? */
export function isShared(db: Conn, recurringId: string): boolean {
	return (
		db
			.select({ id: recurringShares.id })
			.from(recurringShares)
			.where(eq(recurringShares.recurringId, recurringId))
			.get() !== undefined
	);
}

export function hasSharePosts(db: Conn, transactionId: string): boolean {
	return (
		db
			.select({ id: owed.id })
			.from(owed)
			.where(and(eq(owed.sourceTransactionId, transactionId), isNotNull(owed.shareId)))
			.get() !== undefined
	);
}

// --- Posten en splits van een afschrijving --------------------------------------------------

/**
 * Betaald boven het (nieuwe) bedrag van een post wordt tegoed: de laatste betalingen eerst.
 */
function trimOverpaid(db: Conn, owedId: string, amountCents: number): void {
	const rows = db
		.select()
		.from(owedPayments)
		.where(eq(owedPayments.owedId, owedId))
		.orderBy(desc(owedPayments.createdAt), desc(sql`owed_payments.rowid`))
		.all();
	let excess = rows.reduce((s, r) => s + r.amountCents, 0) - amountCents;
	for (const row of rows) {
		if (excess <= 0) break;
		if (row.amountCents <= excess) {
			db.update(owedPayments).set({ owedId: null }).where(eq(owedPayments.id, row.id)).run();
			excess -= row.amountCents;
		} else {
			db.update(owedPayments)
				.set({ amountCents: row.amountCents - excess })
				.where(eq(owedPayments.id, row.id))
				.run();
			db.insert(owedPayments)
				.values({
					transactionId: row.transactionId,
					personId: row.personId,
					owedId: null,
					amountCents: excess
				})
				.run();
			excess = 0;
		}
	}
}

/**
 * Splits van een gedeelde afschrijving opnieuw uit de posten: de aandelen in Terugbetaling,
 * jouw deel in de categorie. Wat kwijtgescholden is, telt bij jouw deel.
 */
function writeSplits(db: Conn, transactionId: string): void {
	const t = db.select().from(transactions).where(eq(transactions.id, transactionId)).get();
	if (!t) return;
	db.delete(transactionSplits)
		.where(
			and(
				eq(transactionSplits.transactionId, transactionId),
				inArray(transactionSplits.note, SPLIT_NOTES)
			)
		)
		.run();
	const posts = db
		.select()
		.from(owed)
		.where(and(eq(owed.sourceTransactionId, transactionId), isNotNull(owed.shareId)))
		.all();
	if (posts.length === 0) return;
	const paid = paidByOwed(
		db,
		posts.map((p) => p.id)
	);
	const others = posts.reduce(
		(s, p) =>
			s +
			(p.status === 'kwijtgescholden'
				? Math.min(p.amountCents, paid.get(p.id) ?? 0)
				: p.amountCents),
		0
	);
	const total = -t.amountCents;
	// Zelfde regel als bij voorschieten (syncShareSplits): jouw deel kan niet onder nul
	if (total - others < 0)
		throw new ValidationError('Het bedrag is lager dan wat de anderen nog moeten');
	db.insert(transactionSplits)
		.values([
			{ transactionId, categoryId: t.categoryId, amountCents: -(total - others), note: MY_SHARE },
			{ transactionId, categoryId: refundCategory(db), amountCents: -others, note: ADVANCED }
		])
		.run();
}

/** Een post weg; betalingen erop worden tegoed (owed_payments.owed_id → null). */
function dropPost(db: Conn, post: typeof owed.$inferSelect): void {
	db.delete(owed).where(eq(owed.id, post.id)).run();
	recordChange(db, 'verwijderd', 'owed', post.id, post, null);
}

/**
 * Maakt of herberekent de maandposten en splits bij een afschrijving van een gedeelde vaste
 * last (verwacht of bevestigd). Idempotent. Een vast aandeel verandert nooit vanzelf; een
 * percentage volgt het bedrag. Een aandeel dat in deze maand niet (meer) loopt, verliest zijn
 * post: wat erop betaald was wordt tegoed en gaat naar de volgende post.
 */
export function applySharedSplit(db: Conn, transactionId: string): void {
	const t = db.select().from(transactions).where(eq(transactions.id, transactionId)).get();
	if (!t?.recurringId || t.amountCents >= 0 || t.status === 'te_controleren') return;
	const r = db.select().from(recurring).where(eq(recurring.id, t.recurringId)).get();
	if (!r) return;
	const posts = db.select().from(owed).where(eq(owed.sourceTransactionId, t.id)).all();
	// Zelf als voorgeschoten verdeeld: daar blijven we af
	if (posts.some((p) => p.shareId === null)) return;

	const month = occurrenceMonth(t.date, r.expectedDay);
	const shares = activeShares(db, r.id, month);
	// Niet gedeeld: niets te doen
	if (shares.length === 0 && posts.length === 0) return;
	const { others } = splitShared(-t.amountCents, shares);
	const touched = new Set<string>();

	for (const p of posts) {
		const i = shares.findIndex((s) => s.id === p.shareId);
		if ((i < 0 || others[i] === 0 || p.month !== month) && p.status !== 'kwijtgescholden') {
			dropPost(db, p);
			if (p.personId) touched.add(p.personId);
		}
	}
	const changed: string[] = [];
	shares.forEach((s, i) => {
		const cents = others[i]!;
		if (cents <= 0) return;
		const date = receiveDate(month, s.receiveDay);
		const existing = db
			.select()
			.from(owed)
			.where(and(eq(owed.shareId, s.id), eq(owed.month, month)))
			.get();
		if (existing?.status === 'kwijtgescholden') return;
		if (existing) {
			if (
				existing.amountCents !== cents ||
				existing.sourceTransactionId !== t.id ||
				existing.date !== date
			) {
				db.update(owed)
					.set({ amountCents: cents, sourceTransactionId: t.id, date, description: r.counterparty })
					.where(eq(owed.id, existing.id))
					.run();
				trimOverpaid(db, existing.id, cents);
			}
			changed.push(existing.id);
		} else {
			const row = db
				.insert(owed)
				.values({
					personId: s.personId,
					amountCents: cents,
					direction: 'te_krijgen',
					sourceTransactionId: t.id,
					description: r.counterparty,
					date,
					shareId: s.id,
					month
				})
				.returning()
				.get();
			changed.push(row.id);
		}
		touched.add(s.personId);
	});
	recomputeStatus(db, changed);
	for (const personId of touched) applyCredit(db, personId);
	writeSplits(db, t.id);
}

/**
 * Voor een afschrijving die vervalt (gemist, opgezegd of verwijderd): zonder afschrijving geen
 * posten. Wat erop betaald was wordt tegoed.
 */
export function removeSharedFor(db: Conn, transactionId: string): void {
	const posts = db
		.select()
		.from(owed)
		.where(and(eq(owed.sourceTransactionId, transactionId), isNotNull(owed.shareId)))
		.all();
	if (posts.length === 0) return;
	for (const p of posts) dropPost(db, p);
	writeSplits(db, transactionId);
	for (const personId of new Set(posts.flatMap((p) => (p.personId ? [p.personId] : []))))
		applyCredit(db, personId);
}

/** Alle afschrijvingen van een vaste last vanaf `fromMonth` opnieuw verdelen. */
function syncShared(db: Conn, recurringId: string, fromMonth: string): void {
	const r = db.select().from(recurring).where(eq(recurring.id, recurringId)).get();
	if (!r) return;
	const rows = db
		.select({ id: transactions.id, date: transactions.date })
		.from(transactions)
		.where(
			and(
				eq(transactions.recurringId, recurringId),
				inArray(transactions.status, ['verwacht', 'bevestigd']),
				gte(transactions.date, addDays(`${fromMonth}-01`, -16))
			)
		)
		.orderBy(asc(transactions.date))
		.all();
	for (const t of rows) {
		if (occurrenceMonth(t.date, r.expectedDay) >= fromMonth) applySharedSplit(db, t.id);
	}
}

/**
 * Terugwerkend: afschrijvingen uit de historie die bij de vaste last horen (zelfde tegenpartij en
 * IBAN) worden eraan gekoppeld, één per maand, de dichtst bij de verwachte dag.
 */
function linkHistoricDebits(
	db: Conn,
	r: typeof recurring.$inferSelect,
	fromMonth: string,
	today: string
): number {
	const [name, iban] = r.matchKey.split('|') as [string, string];
	const known = new Set(
		db
			.select({ date: transactions.date })
			.from(transactions)
			.where(eq(transactions.recurringId, r.id))
			.all()
			.map((t) => occurrenceMonth(t.date, r.expectedDay))
	);
	const candidates = db
		.select({
			id: transactions.id,
			date: transactions.date,
			counterparty: transactions.counterparty,
			counterIban: transactions.counterIban
		})
		.from(transactions)
		.where(
			and(
				isNull(transactions.recurringId),
				eq(transactions.status, 'bevestigd'),
				sql`${transactions.amountCents} < 0`,
				gte(transactions.date, addDays(`${fromMonth}-01`, -16)),
				lte(transactions.date, today)
			)
		)
		.all()
		.filter(
			(t) =>
				normalizeCounterparty(t.counterparty) === name &&
				(!iban || !t.counterIban || normalizeIban(t.counterIban) === iban)
		);
	const byMonth = new Map<string, (typeof candidates)[number]>();
	const distance = (d: string) => Math.abs(Number(d.slice(8, 10)) - r.expectedDay);
	for (const t of candidates) {
		const month = occurrenceMonth(t.date, r.expectedDay);
		if (month < fromMonth || known.has(month)) continue;
		const best = byMonth.get(month);
		if (!best || distance(t.date) < distance(best.date)) byMonth.set(month, t);
	}
	for (const t of byMonth.values()) {
		db.update(transactions).set({ recurringId: r.id }).where(eq(transactions.id, t.id)).run();
	}
	return byMonth.size;
}

// --- Aandelen beheren -----------------------------------------------------------------------

export interface NewShare {
	recurringId: string;
	personId: string;
	kind: ShareKind;
	amountCents?: number | null;
	basisPoints?: number | null;
	receiveDay: number;
	startMonth: string;
	endMonth?: string | null;
}

function checkTerms(input: NewShare): void {
	if (input.kind === 'vast') {
		if (!Number.isSafeInteger(input.amountCents) || (input.amountCents ?? 0) <= 0)
			throw new ValidationError('Vul een bedrag in');
	} else if (
		!Number.isInteger(input.basisPoints) ||
		(input.basisPoints ?? 0) < 1 ||
		(input.basisPoints ?? 0) > FULL
	) {
		throw new ValidationError('Vul een percentage tussen 0 en 100 in');
	}
	if (!Number.isInteger(input.receiveDay) || input.receiveDay < 1 || input.receiveDay > 31)
		throw new ValidationError('De ontvangstdag ligt tussen 1 en 31');
	if (input.endMonth && input.endMonth < input.startMonth)
		throw new ValidationError('De eindmaand ligt voor de startmaand');
}

function checkWindow(startMonth: string, today: string): void {
	const month = today.slice(0, 7);
	if (startMonth < shiftMonth(month, -24))
		throw new ValidationError('De startmaand ligt meer dan twee jaar terug');
	if (startMonth > shiftMonth(month, 12))
		throw new ValidationError('De startmaand ligt te ver weg');
}

/** Past dit aandeel naast de andere? Geen overlap per persoon, samen niet meer dan de last. */
function checkFits(
	db: Conn,
	r: typeof recurring.$inferSelect,
	candidate: Omit<ShareRow, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
): void {
	const others = sharesOf(db, r.id).filter((s) => s.id !== candidate.id);
	const overlaps = others.some(
		(s) =>
			s.personId === candidate.personId &&
			s.startMonth <= (candidate.endMonth ?? '9999-12') &&
			candidate.startMonth <= (s.endMonth ?? '9999-12')
	);
	if (overlaps) throw new ValidationError('Deze persoon heeft in die maanden al een aandeel');
	const reason = checkShares(r.medianCents, [...others, candidate]);
	if (reason) throw new ValidationError(reason);
}

function activeRecurring(db: Conn, id: string) {
	const r = db.select().from(recurring).where(eq(recurring.id, id)).get();
	if (!r || r.status !== 'actief') throw new ValidationError('Deze vaste last loopt niet');
	return r;
}

/** Voor terugwerkend en voor betalingen die al binnen zijn: één keer koppelen. */
function linkHistoricPayments(db: Conn, personId: string, fromMonth: string, today: string) {
	const ibans = ibansOf(db, personId);
	if (ibans.length === 0) return 0;
	const rows = db
		.select({ id: transactions.id })
		.from(transactions)
		.where(
			and(
				inArray(transactions.counterIban, ibans),
				sql`${transactions.amountCents} > 0`,
				ne(transactions.status, 'verwacht'),
				gte(transactions.date, addDays(`${fromMonth}-01`, -15)),
				lte(transactions.date, today),
				sql`NOT EXISTS (SELECT 1 FROM owed_payments op WHERE op.transaction_id = ${transactions.id})`
			)
		)
		.orderBy(asc(transactions.date), asc(transactions.createdAt))
		.all();
	let linked = 0;
	for (const t of rows) if (autoLinkPayment(db, t.id)) linked++;
	return linked;
}

function insertShare(db: Conn, input: NewShare, today: string): string {
	checkTerms(input);
	checkWindow(input.startMonth, today);
	const r = activeRecurring(db, input.recurringId);
	if (!db.select({ id: people.id }).from(people).where(eq(people.id, input.personId)).get())
		throw new ValidationError('Onbekende persoon');
	const values = {
		recurringId: r.id,
		personId: input.personId,
		kind: input.kind,
		amountCents: input.kind === 'vast' ? input.amountCents! : null,
		basisPoints: input.kind === 'percentage' ? input.basisPoints! : null,
		receiveDay: input.receiveDay,
		startMonth: input.startMonth,
		endMonth: input.endMonth ?? null
	};
	checkFits(db, r, values);
	const row = db.insert(recurringShares).values(values).returning().get();
	recordChange(db, 'aangemaakt', 'recurring_shares', row.id, null, row);

	// Terugwerkend: de posten vanaf de startmaand, en de overboekingen uit de historie één keer
	const month = today.slice(0, 7);
	if (input.startMonth < month) linkHistoricDebits(db, r, input.startMonth, today);
	syncShared(db, r.id, input.startMonth);
	if (input.startMonth <= month) linkHistoricPayments(db, input.personId, input.startMonth, today);
	return row.id;
}

/** Een aandeel toevoegen. Ligt de startmaand in het verleden, dan werkt het terug. */
export function createShare(db: DB, input: NewShare, today = toIsoDate(new Date())): string {
	return db.transaction((tx) => insertShare(tx, input, today));
}

/** Ontvangstdag of eindmaand aanpassen (huisgenoot vertrekt). */
export function updateShare(
	db: DB,
	id: string,
	patch: { receiveDay?: number; endMonth?: string | null }
): void {
	db.transaction((tx) => {
		const before = tx.select().from(recurringShares).where(eq(recurringShares.id, id)).get();
		if (!before) throw new ValidationError('Onbekend aandeel');
		const r = activeRecurring(tx, before.recurringId);
		const next = { ...before, ...patch };
		checkTerms(next);
		checkFits(tx, r, next);
		const after = tx
			.update(recurringShares)
			.set({ ...patch, updatedAt: new Date().toISOString() })
			.where(eq(recurringShares.id, id))
			.returning()
			.get();
		recordChange(tx, 'gewijzigd', 'recurring_shares', id, before, after);
		// Een andere ontvangstdag verschuift alle posten; een eindmaand alleen die erna
		let from: string | null = null;
		if (patch.receiveDay !== undefined && patch.receiveDay !== before.receiveDay)
			from = before.startMonth;
		if (patch.endMonth !== undefined && patch.endMonth !== before.endMonth) {
			const first = [patch.endMonth, before.endMonth]
				.flatMap((m) => (m ? [shiftMonth(m, 1)] : []))
				.sort()[0];
			if (first && (!from || first < from)) from = first;
		}
		if (from) syncShared(tx, r.id, from);
	});
}

/**
 * Een ander bedrag of percentage vanaf `fromMonth`. Het oude aandeel krijgt een eindmaand en er
 * komt een nieuw aandeel, zodat eerdere maanden blijven zoals ze waren. Posten vanaf die maand
 * krijgen het nieuwe bedrag; wat erop al betaald is, gaat mee.
 */
export function changeShareAmount(
	db: DB,
	id: string,
	terms: { amountCents?: number; basisPoints?: number },
	fromMonth: string,
	today = toIsoDate(new Date())
): void {
	db.transaction((tx) => {
		const before = tx.select().from(recurringShares).where(eq(recurringShares.id, id)).get();
		if (!before) throw new ValidationError('Onbekend aandeel');
		const r = activeRecurring(tx, before.recurringId);
		if (before.endMonth && fromMonth > before.endMonth)
			throw new ValidationError('Dit aandeel loopt dan niet meer');
		const values = {
			kind: before.kind,
			amountCents: before.kind === 'vast' ? (terms.amountCents ?? null) : null,
			basisPoints: before.kind === 'percentage' ? (terms.basisPoints ?? null) : null
		};
		checkTerms({ ...before, ...values });

		if (fromMonth <= before.startMonth) {
			checkFits(tx, r, { ...before, ...values });
			const after = tx
				.update(recurringShares)
				.set({ ...values, updatedAt: new Date().toISOString() })
				.where(eq(recurringShares.id, id))
				.returning()
				.get();
			recordChange(tx, 'gewijzigd', 'recurring_shares', id, before, after);
			syncShared(tx, r.id, before.startMonth);
			return;
		}
		checkWindow(fromMonth, today);
		const ended = { ...before, endMonth: shiftMonth(fromMonth, -1) };
		const next = { ...before, ...values, id: undefined, startMonth: fromMonth };
		const reason = checkShares(r.medianCents, [
			...sharesOf(tx, r.id).filter((s) => s.id !== id),
			ended,
			next
		]);
		if (reason) throw new ValidationError(reason);
		tx.update(recurringShares)
			.set({ endMonth: ended.endMonth, updatedAt: new Date().toISOString() })
			.where(eq(recurringShares.id, id))
			.run();
		const row = tx
			.insert(recurringShares)
			.values({
				recurringId: r.id,
				personId: before.personId,
				...values,
				receiveDay: before.receiveDay,
				startMonth: fromMonth,
				endMonth: before.endMonth
			})
			.returning()
			.get();
		recordChange(tx, 'gewijzigd', 'recurring_shares', id, before, { endMonth: ended.endMonth });
		recordChange(tx, 'aangemaakt', 'recurring_shares', row.id, null, row);
		syncShared(tx, r.id, fromMonth);
	});
}

/** Een aandeel helemaal weg: zijn posten vervallen, wat erop betaald was wordt tegoed. */
export function deleteShare(db: DB, id: string): void {
	db.transaction((tx) => {
		const before = tx.select().from(recurringShares).where(eq(recurringShares.id, id)).get();
		if (!before) throw new ValidationError('Onbekend aandeel');
		const posts = tx.select().from(owed).where(eq(owed.shareId, id)).all();
		for (const p of posts) dropPost(tx, p);
		tx.delete(recurringShares).where(eq(recurringShares.id, id)).run();
		recordChange(tx, 'verwijderd', 'recurring_shares', id, before, null);
		for (const source of new Set(
			posts.flatMap((p) => (p.sourceTransactionId ? [p.sourceTransactionId] : []))
		))
			writeSplits(tx, source);
		applyCredit(tx, before.personId);
	});
}

export interface ShareItem {
	id: string;
	personId: string;
	personName: string;
	kind: ShareKind;
	amountCents: number | null;
	basisPoints: number | null;
	receiveDay: number;
	startMonth: string;
	endMonth: string | null;
	/** Het aandeel bij het verwachte bedrag van de last */
	expectedCents: number;
	active: boolean;
}

/** Aandelen van een vaste last, voor de detailpagina. */
export function listShares(db: Conn, recurringId: string, today = toIsoDate(new Date())) {
	const r = db.select().from(recurring).where(eq(recurring.id, recurringId)).get();
	if (!r) return { items: [] as ShareItem[], mineCents: 0 };
	const month = today.slice(0, 7);
	const names = new Map(
		db
			.select({ id: people.id, name: people.name })
			.from(people)
			.all()
			.map((p) => [p.id, p.name])
	);
	const rows = sharesOf(db, recurringId);
	const items: ShareItem[] = rows.map((s) => ({
		id: s.id,
		personId: s.personId,
		personName: names.get(s.personId) ?? '',
		kind: s.kind,
		amountCents: s.amountCents,
		basisPoints: s.basisPoints,
		receiveDay: s.receiveDay,
		startMonth: s.startMonth,
		endMonth: s.endMonth,
		expectedCents: shareCents(s, r.medianCents),
		active: isActive(s, month) || s.startMonth > month
	}));
	return { items, mineCents: myShareCents(db, recurringId, r.medianCents, month) };
}

// --- Ontvangen en koppelen ------------------------------------------------------------------

function defaultAccountId(db: Conn): string {
	const sns =
		db.select({ id: accounts.id }).from(accounts).where(eq(accounts.kind, 'sns')).get() ??
		db.select({ id: accounts.id }).from(accounts).orderBy(asc(accounts.createdAt)).get();
	if (!sns) throw new Error('Geen rekening');
	return sns.id;
}

/**
 * Eén tik "ontvangen": boekt een inkomende transactie in Terugbetaling voor wat er nog openstaat
 * en koppelt hem aan de post. Een latere import ontdubbelt ertegen.
 */
export function confirmReceived(db: DB, owedId: string, today = toIsoDate(new Date())): string {
	return db.transaction((tx) => {
		const post = tx.select().from(owed).where(eq(owed.id, owedId)).get();
		if (!post?.shareId || !post.personId || (post.status !== 'open' && post.status !== 'deels'))
			throw new ValidationError('Deze post staat niet open');
		const outstanding = post.amountCents - (paidByOwed(tx, [post.id]).get(post.id) ?? 0);
		if (outstanding <= 0) throw new ValidationError('Deze post staat niet open');
		const share = tx
			.select({ recurringId: recurringShares.recurringId })
			.from(recurringShares)
			.where(eq(recurringShares.id, post.shareId))
			.get();
		const r = share
			? tx.select().from(recurring).where(eq(recurring.id, share.recurringId)).get()
			: undefined;
		const person = tx.select().from(people).where(eq(people.id, post.personId)).get()!;
		const refund = refundCategory(tx);
		const row = tx
			.insert(transactions)
			.values({
				amountCents: outstanding,
				date: today,
				counterparty: person.name,
				description: post.description,
				categoryId: refund,
				categorySource: refund ? 'handmatig' : null,
				accountId: r?.accountId ?? defaultAccountId(tx),
				source: 'handmatig',
				status: 'bevestigd'
			})
			.returning()
			.get();
		recordChange(tx, 'ontvangen', 'transactions', row.id, null, row);
		if (!settlePayment(tx, row.id, { owedId: post.id }))
			throw new ValidationError('Deze post staat niet open');
		return row.id;
	});
}

/**
 * Automatisch koppelen bij import of invoer: de tegen-IBAN hoort bij precies één persoon (een
 * IBAN hoort bij hooguit één persoon) en het bedrag is gelijk aan wat die persoon openstaat, aan
 * één open post, of aan zijn maandaandelen (een overboeking vóór de post er is wordt tegoed).
 * Staat in het audit-log; loskoppelen maakt het ongedaan.
 */
export function autoLinkPayment(db: Conn, transactionId: string): boolean {
	const t = db.select().from(transactions).where(eq(transactions.id, transactionId)).get();
	if (!t || t.amountCents <= 0 || !t.counterIban || t.status === 'verwacht') return false;
	const linked = db
		.select({ id: owedPayments.id })
		.from(owedPayments)
		.where(eq(owedPayments.transactionId, t.id))
		.get();
	if (linked) return false;
	const personId = personByIban(db, t.counterIban);
	if (!personId) return false;

	const items = openItems(db, personId, 'te_krijgen');
	const total = items.reduce((s, i) => s + i.outstandingCents, 0);
	const month = t.date.slice(0, 7);
	const monthly = db
		.select({ s: recurringShares, median: recurring.medianCents })
		.from(recurringShares)
		.innerJoin(recurring, eq(recurring.id, recurringShares.recurringId))
		.where(and(eq(recurringShares.personId, personId), eq(recurring.status, 'actief')))
		.all()
		.filter(({ s }) => isActive(s, month) || isActive(s, shiftMonth(month, 1)))
		.reduce((sum, { s, median }) => sum + shareCents(s, median), 0);
	const amount = t.amountCents;
	const fits =
		(total > 0 && amount === total) ||
		items.some((i) => i.outstandingCents === amount) ||
		(monthly > 0 && amount === monthly);
	if (!fits) return false;

	if (!settlePayment(db, t.id, { personId })) return false;
	const refund = refundCategory(db);
	if (refund && t.categorySource !== 'handmatig' && t.categorySource !== 'intern') {
		db.update(transactions)
			.set({ categoryId: refund, categorySource: 'handmatig', categoryRuleId: null })
			.where(eq(transactions.id, t.id))
			.run();
	}
	recordChange(db, 'auto_gekoppeld', 'owed_payments', t.id, null, {
		personId,
		amountCents: amount
	});
	return true;
}

/**
 * Ontdubbelen bij een import: een al met één tik bevestigde (of zelf ingevoerde en gekoppelde)
 * ontvangst van dezelfde persoon, met hetzelfde bedrag, binnen 10 dagen en nog zonder
 * bankreferentie. Geeft het ID van die transactie, de dichtstbijzijnde datum eerst.
 */
export function findReceiptToMerge(
	db: Conn,
	record: { amountCents: number; date: string; counterIban: string | null }
): string | null {
	if (record.amountCents <= 0 || !record.counterIban) return null;
	const personId = personByIban(db, record.counterIban);
	if (!personId) return null;
	const rows = db
		.selectDistinct({ id: transactions.id, date: transactions.date })
		.from(transactions)
		.innerJoin(owedPayments, eq(owedPayments.transactionId, transactions.id))
		.where(
			and(
				eq(owedPayments.personId, personId),
				eq(transactions.source, 'handmatig'),
				isNull(transactions.bankReference),
				isNull(transactions.dedupeHash),
				eq(transactions.amountCents, record.amountCents),
				gte(transactions.date, addDays(record.date, -MERGE_DAYS)),
				lte(transactions.date, addDays(record.date, MERGE_DAYS))
			)
		)
		.all();
	const gap = (d: string) => Math.abs(Date.parse(d) - Date.parse(record.date));
	rows.sort((a, b) => gap(a.date) - gap(b.date));
	return rows[0]?.id ?? null;
}

/**
 * Dubbel betaald of na vertrek: het tegoed van een persoon wordt een post "te betalen", als je
 * het wilt teruggeven in plaats van laten staan.
 */
export function creditToPayable(db: DB, personId: string, today = toIsoDate(new Date())): void {
	db.transaction((tx) => {
		const credits = tx
			.select({ id: owedPayments.id, amountCents: owedPayments.amountCents })
			.from(owedPayments)
			.innerJoin(transactions, eq(transactions.id, owedPayments.transactionId))
			.where(
				and(
					eq(owedPayments.personId, personId),
					isNull(owedPayments.owedId),
					sql`${transactions.amountCents} > 0`
				)
			)
			.all();
		const total = credits.reduce((s, c) => s + c.amountCents, 0);
		if (total <= 0) throw new ValidationError('Er is geen tegoed');
		tx.delete(owedPayments)
			.where(
				inArray(
					owedPayments.id,
					credits.map((c) => c.id)
				)
			)
			.run();
		const row = tx
			.insert(owed)
			.values({
				personId,
				direction: 'te_betalen',
				amountCents: total,
				description: 'Te veel ontvangen',
				date: today
			})
			.returning()
			.get();
		recordChange(tx, 'tegoed_terug', 'owed', row.id, credits, row);
	});
}

// --- Voorstellen uit de historie ------------------------------------------------------------

/** Ondoorzichtige sleutel voor een voorstel: het IBAN zelf gaat niet naar de browser. */
function proposalKey(recurringId: string, iban: string): string {
	return createHash('sha256').update(`${recurringId}|${iban}`).digest('hex').slice(0, 32);
}

interface FullProposal {
	key: string;
	recurringId: string;
	recurringName: string;
	recurringCents: number;
	counterIban: string;
	counterparty: string;
	personId: string | null;
	personName: string | null;
	amountCents: number;
	receiveDay: number;
	startMonth: string;
}

function fullProposals(db: Conn, today: string): FullProposal[] {
	const sources = db
		.select()
		.from(recurring)
		.where(and(eq(recurring.status, 'actief'), eq(recurring.interval, 'maand')))
		.all();
	if (sources.length === 0) return [];
	const internal = db
		.select({ id: categories.id })
		.from(categories)
		.where(eq(categories.name, INTERNAL_TRANSFER))
		.get()?.id;
	const own = new Set(
		db
			.select({ iban: accounts.iban })
			.from(accounts)
			.all()
			.flatMap((a) => (a.iban ? [a.iban] : []))
	);
	const incoming = db
		.select({
			date: transactions.date,
			amountCents: transactions.amountCents,
			counterparty: transactions.counterparty,
			counterIban: transactions.counterIban
		})
		.from(transactions)
		.where(
			and(
				gte(transactions.date, `${shiftMonth(today.slice(0, 7), -PROPOSAL_MONTHS)}-01`),
				lte(transactions.date, today),
				sql`${transactions.amountCents} > 0`,
				isNotNull(transactions.counterIban),
				ne(transactions.status, 'verwacht'),
				internal
					? or(isNull(transactions.categoryId), ne(transactions.categoryId, internal))
					: undefined
			)
		)
		.all()
		.filter((t) => !own.has(normalizeIban(t.counterIban!)));
	const dismissed = new Set(
		db
			.select()
			.from(shareDismissals)
			.all()
			.map((d) => `${d.recurringId}|${d.counterIban}`)
	);
	const month = today.slice(0, 7);
	const byId = new Map(sources.map((s) => [s.id, s]));
	const out: FullProposal[] = [];
	for (const p of detectShareProposals(incoming, sources, today)) {
		const iban = normalizeIban(p.counterIban);
		if (dismissed.has(`${p.recurringId}|${iban}`)) continue;
		const personId = personByIban(db, iban);
		if (personId && activeShares(db, p.recurringId, month).some((s) => s.personId === personId))
			continue;
		const r = byId.get(p.recurringId)!;
		const person = personId
			? db.select({ name: people.name }).from(people).where(eq(people.id, personId)).get()
			: undefined;
		out.push({
			key: proposalKey(p.recurringId, iban),
			recurringId: p.recurringId,
			recurringName: r.counterparty,
			recurringCents: r.medianCents,
			counterIban: iban,
			counterparty: p.counterparty,
			personId,
			personName: person?.name ?? null,
			amountCents: p.amountCents,
			receiveDay: p.receiveDay,
			startMonth: p.startMonth
		});
	}
	return out;
}

export type ShareProposalView = Omit<FullProposal, 'counterIban'>;

/** Voorstellen ("Krijg je van S. elke maand €20 voor Ziggo?"), zonder IBANs. */
export function shareProposals(db: Conn, today = toIsoDate(new Date())): ShareProposalView[] {
	return fullProposals(db, today).map(({ counterIban: _iban, ...rest }) => rest);
}

/**
 * Een voorstel bevestigen: de persoon (bestaand of nieuw) krijgt het IBAN erbij en een vast
 * aandeel vanaf de startmaand. Terugwerkend, dus de overboekingen uit de historie koppelen meteen.
 */
export function acceptProposal(
	db: DB,
	input: {
		key: string;
		recurringId: string;
		personId?: string | null;
		newName?: string | null;
		amountCents: number;
		receiveDay: number;
		startMonth: string;
	},
	today = toIsoDate(new Date())
): string {
	return db.transaction((tx) => {
		const p = fullProposals(tx, today).find((x) => x.key === input.key);
		if (!p) throw new ValidationError('Dit voorstel bestaat niet meer');
		const personId =
			p.personId ??
			input.personId ??
			(input.newName ? findOrCreatePerson(tx, input.newName) : null);
		if (!personId) throw new ValidationError('Kies een persoon');
		if (!tx.select({ id: people.id }).from(people).where(eq(people.id, personId)).get())
			throw new ValidationError('Onbekende persoon');
		if (!p.personId && isValidIban(p.counterIban)) {
			const other = tx
				.select({ personId: peopleIbans.personId })
				.from(peopleIbans)
				.where(eq(peopleIbans.iban, p.counterIban))
				.get();
			if (other && other.personId !== personId)
				throw new ValidationError('Dat IBAN hoort al bij iemand anders');
			if (!other) {
				const row = tx
					.insert(peopleIbans)
					.values({ personId, iban: p.counterIban })
					.returning()
					.get();
				recordChange(tx, 'iban_toegevoegd', 'people', personId, null, { ibanId: row.id });
			}
		}
		return insertShare(
			tx,
			{
				recurringId: input.recurringId,
				personId,
				kind: 'vast',
				amountCents: input.amountCents,
				receiveDay: input.receiveDay,
				startMonth: input.startMonth
			},
			today
		);
	});
}

/** "Nee": dit voorstel komt niet terug. */
export function dismissProposal(db: DB, key: string, today = toIsoDate(new Date())): void {
	db.transaction((tx) => {
		const p = fullProposals(tx, today).find((x) => x.key === key);
		if (!p) throw new ValidationError('Dit voorstel bestaat niet meer');
		tx.insert(shareDismissals)
			.values({ recurringId: p.recurringId, counterIban: p.counterIban })
			.onConflictDoNothing()
			.run();
		recordChange(tx, 'afgewezen', 'share_dismissals', p.recurringId, null, { key });
	});
}

// --- Overzicht Terugbetalingen --------------------------------------------------------------

export interface MonthPost {
	id: string;
	counterparty: string;
	amountCents: number;
	paidCents: number;
	dueDate: string;
	state: MonthState;
	sourceTransactionId: string | null;
	payments: { transactionId: string; date: string; amountCents: number }[];
}

export interface MonthBox {
	month: string;
	state: MonthState | 'geen';
	amountCents: number;
	paidCents: number;
	posts: MonthPost[];
}

const STATE_ORDER: (MonthState | 'geen')[] = [
	'te_laat',
	'open',
	'deels',
	'binnen',
	'kwijtgescholden',
	'geen'
];

/** De status van een vakje met meer posten: de post die de meeste aandacht vraagt. */
function boxState(posts: MonthPost[]): MonthState | 'geen' {
	if (posts.length === 0) return 'geen';
	const states = new Set(posts.map((p) => p.state));
	if (states.has('te_laat')) return 'te_laat';
	if (states.has('open') || states.has('deels')) {
		const open = posts.filter((p) => p.state === 'open' || p.state === 'deels');
		return open.some((p) => p.paidCents > 0) || states.has('binnen') ? 'deels' : 'open';
	}
	return STATE_ORDER.find((s) => states.has(s as MonthState))!;
}

function sharePosts(db: Conn, where?: ReturnType<typeof and>) {
	return db
		.select({
			id: owed.id,
			personId: owed.personId,
			amountCents: owed.amountCents,
			date: owed.date,
			month: owed.month,
			status: owed.status,
			description: owed.description,
			sourceTransactionId: owed.sourceTransactionId
		})
		.from(owed)
		.where(and(isNotNull(owed.shareId), where))
		.orderBy(asc(owed.date), asc(owed.createdAt))
		.all();
}

function creditsByPerson(db: Conn): Map<string, number> {
	const rows = db
		.select({
			personId: owedPayments.personId,
			cents: sql<number>`sum(${owedPayments.amountCents})`
		})
		.from(owedPayments)
		.innerJoin(transactions, eq(transactions.id, owedPayments.transactionId))
		.where(and(isNull(owedPayments.owedId), sql`${transactions.amountCents} > 0`))
		.groupBy(owedPayments.personId)
		.all();
	return new Map(rows.map((r) => [r.personId, r.cents]));
}

/**
 * Overzicht Terugbetalingen: de totale achterstand (vervallen en niet volledig betaald) en het
 * tegoed; per persoon zes maanden als vakjes, verwacht tegenover ontvangen en de achterstand;
 * per gedeelde last het bruto bedrag, de aandelen en jouw deel.
 */
export function sharesOverview(db: Conn, today = toIsoDate(new Date())) {
	const month = today.slice(0, 7);
	const months = lastMonths(month, 6);
	const all = sharePosts(db);
	const paid = paidByOwed(
		db,
		all.map((p) => p.id)
	);
	const stateOf = (p: (typeof all)[number]) =>
		monthState({
			amountCents: p.amountCents,
			paidCents: paid.get(p.id) ?? 0,
			forgiven: p.status === 'kwijtgescholden',
			dueDate: p.date,
			today
		});
	const outstanding = (p: (typeof all)[number]) =>
		p.status === 'open' || p.status === 'deels' ? p.amountCents - (paid.get(p.id) ?? 0) : 0;
	const overdue = (p: (typeof all)[number]) => (p.date < today ? outstanding(p) : 0);

	const windowPosts = all.filter((p) => p.month! >= months[0]! && p.month! <= month);
	const payments = windowPosts.length
		? db
				.select({
					owedId: owedPayments.owedId,
					transactionId: owedPayments.transactionId,
					amountCents: owedPayments.amountCents,
					date: transactions.date
				})
				.from(owedPayments)
				.innerJoin(transactions, eq(transactions.id, owedPayments.transactionId))
				.where(
					inArray(
						owedPayments.owedId,
						windowPosts.map((p) => p.id)
					)
				)
				.orderBy(asc(transactions.date))
				.all()
		: [];

	const shares = db
		.select({ s: recurringShares, name: people.name })
		.from(recurringShares)
		.innerJoin(people, eq(people.id, recurringShares.personId))
		.all();
	const credit = creditsByPerson(db);
	const personIds = new Set([
		...shares
			.filter(({ s }) => s.startMonth <= month && (s.endMonth ?? '9999-12') >= months[0]!)
			.map(({ s }) => s.personId),
		...windowPosts.flatMap((p) => (p.personId ? [p.personId] : []))
	]);
	const names = new Map(shares.map(({ s, name }) => [s.personId, name]));

	const persons = [...personIds].map((personId) => {
		const mine = all.filter((p) => p.personId === personId);
		const boxes: MonthBox[] = months.map((m) => {
			const posts: MonthPost[] = mine
				.filter((p) => p.month === m)
				.map((p) => ({
					id: p.id,
					counterparty: p.description,
					amountCents: p.amountCents,
					paidCents: paid.get(p.id) ?? 0,
					dueDate: p.date,
					state: stateOf(p),
					sourceTransactionId: p.sourceTransactionId,
					payments: payments
						.filter((x) => x.owedId === p.id)
						.map((x) => ({
							transactionId: x.transactionId,
							date: x.date,
							amountCents: x.amountCents
						}))
				}));
			return {
				month: m,
				state: boxState(posts),
				amountCents: posts.reduce((s, p) => s + p.amountCents, 0),
				paidCents: posts.reduce((s, p) => s + p.paidCents, 0),
				posts
			};
		});
		const inWindow = mine.filter((p) => p.month! >= months[0]! && p.month! <= month);
		return {
			personId,
			name: names.get(personId) ?? '',
			boxes,
			expectedCents: inWindow
				.filter((p) => p.status !== 'kwijtgescholden')
				.reduce((s, p) => s + p.amountCents, 0),
			receivedCents: inWindow.reduce((s, p) => s + (paid.get(p.id) ?? 0), 0),
			arrearsCents: mine.reduce((s, p) => s + overdue(p), 0),
			creditCents: credit.get(personId) ?? 0
		};
	});
	persons.sort((a, b) => b.arrearsCents - a.arrearsCents || a.name.localeCompare(b.name, 'nl'));

	const lasts = db
		.select()
		.from(recurring)
		.where(
			and(
				eq(recurring.status, 'actief'),
				inArray(recurring.id, db.select({ id: recurringShares.recurringId }).from(recurringShares))
			)
		)
		.orderBy(asc(recurring.counterparty))
		.all()
		.map((r) => {
			const active = shares.filter(({ s }) => s.recurringId === r.id && isActive(s, month));
			const split = splitShared(
				r.medianCents,
				active.map(({ s }) => s)
			);
			return {
				recurringId: r.id,
				counterparty: r.counterparty,
				interval: r.interval,
				grossCents: r.medianCents,
				mineCents: split.mine,
				shares: active.map(({ s, name }, i) => ({
					id: s.id,
					name,
					kind: s.kind,
					basisPoints: s.basisPoints,
					cents: split.others[i]!
				}))
			};
		});

	return {
		months,
		arrearsCents: all.reduce((s, p) => s + overdue(p), 0),
		creditCents: persons.reduce((s, p) => s + p.creditCents, 0),
		persons,
		lasts
	};
}

export interface DueReceipt {
	id: string;
	personName: string;
	counterparty: string;
	outstandingCents: number;
	dueDate: string;
	late: boolean;
}

/** Maandaandelen waarvan de ontvangstdag gekomen is en die nog openstaan: één tik "ontvangen". */
export function dueReceipts(db: Conn, today = toIsoDate(new Date())): DueReceipt[] {
	const posts = db
		.select({
			id: owed.id,
			amountCents: owed.amountCents,
			date: owed.date,
			description: owed.description,
			personName: people.name
		})
		.from(owed)
		.innerJoin(people, eq(people.id, owed.personId))
		.where(
			and(isNotNull(owed.shareId), inArray(owed.status, ['open', 'deels']), lte(owed.date, today))
		)
		.orderBy(asc(owed.date), asc(people.name))
		.all();
	const paid = paidByOwed(
		db,
		posts.map((p) => p.id)
	);
	return posts.map((p) => ({
		id: p.id,
		personName: p.personName,
		counterparty: p.description,
		outstandingCents: p.amountCents - (paid.get(p.id) ?? 0),
		dueDate: p.date,
		late:
			monthState({
				amountCents: p.amountCents,
				paidCents: paid.get(p.id) ?? 0,
				forgiven: false,
				dueDate: p.date,
				today
			}) === 'te_laat'
	}));
}

/** Aantal open maandaandelen, voor de tab. */
export function openShareCount(db: Conn): number {
	return (
		db
			.select({ n: sql<number>`count(*)` })
			.from(owed)
			.where(and(isNotNull(owed.shareId), inArray(owed.status, ['open', 'deels'])))
			.get()?.n ?? 0
	);
}
