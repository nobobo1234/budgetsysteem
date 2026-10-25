import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { addDays, daysInMonth, shiftMonth, toIsoDate } from '../dates.ts';
import {
	advancePast,
	defaultSpread,
	detectRecurring,
	occurrencesThrough,
	perMonthCents,
	perYearCents,
	reservationFor,
	signalFor,
	type AmountKind,
	type Interval,
	type Signal
} from '../recurring.ts';
import { recordChange } from './audit.ts';
import { enqueue, ensureScheduled, registerJob } from './jobs.ts';
import type { Conn, DB } from './db/index.ts';
import {
	accounts,
	categories,
	jobs,
	recurring,
	reservations,
	transactionSplits,
	transactions
} from './db/schema.ts';
import { INTERNAL_TRANSFER } from './db/seed.ts';
import { ValidationError } from './errors.ts';
import { log } from './log.ts';
import { dropSourcePosts, MY_SHARE, syncShareSplits } from './owed.ts';
import { applySharedSplit, isShared, myShareCents, removeSharedFor } from './shares.ts';
import { describeError } from './telemetry/index.ts';

/** Niet bevestigd zoveel dagen na de verwachte dag: "gemist of opgezegd?" (spec: Verwachte posten). */
export const MISSED_AFTER_DAYS = 7;
/** Hoe ver terug de herkenning kijkt: jaarlijks vraagt meer dan een jaar historie. */
const HISTORY_MONTHS = 26;

export type Recurring = typeof recurring.$inferSelect;

// --- Aanhaakpunt voor meldingen -------------------------------------------------------------
// Pushmeldingen komen uit een eigen onderdeel. Dat registreert hier een listener; de payload
// bevat bewust geen bedragen of namen (vergrendelscherm), alleen ID's en aantallen.

export type RecurringEvent =
	| { type: 'verwacht'; transactionIds: string[] }
	| { type: 'signaal'; recurringId: string; signal: Signal };

type Listener = (event: RecurringEvent) => void;
const listeners = new Set<Listener>();

export function onRecurringEvent(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function emit(event: RecurringEvent): void {
	for (const listener of listeners) {
		try {
			listener(event);
		} catch (e) {
			log.warn({ err: describeError(e), event: event.type }, 'listener vaste lasten mislukt');
		}
	}
}

// --- Hulpjes --------------------------------------------------------------------------------

const monthRange = (month: string) => [`${month}-01`, `${month}-31`] as const;

function isSpread(r: Pick<Recurring, 'spread' | 'interval'>): boolean {
	return r.spread && r.interval !== 'maand';
}

/** Wat er nu opzij staat: alles wat gereserveerd is min wat eruit gehaald is, tot en met `month`. */
export function reserveBalance(db: Conn, recurringId: string, month: string): number {
	return (
		db
			.select({
				n: sql<number>`coalesce(sum(${reservations.amountCents} - ${reservations.drawnCents}), 0)`
			})
			.from(reservations)
			.where(and(eq(reservations.recurringId, recurringId), lte(reservations.month, month)))
			.get()?.n ?? 0
	);
}

function reservationRow(db: Conn, recurringId: string, month: string) {
	const existing = db
		.select()
		.from(reservations)
		.where(and(eq(reservations.recurringId, recurringId), eq(reservations.month, month)))
		.get();
	if (existing) return existing;
	const categoryId =
		db
			.select({ categoryId: recurring.categoryId })
			.from(recurring)
			.where(eq(recurring.id, recurringId))
			.get()?.categoryId ?? null;
	return db
		.insert(reservations)
		.values({ recurringId, month, amountCents: 0, categoryId })
		.returning()
		.get();
}

/** Haalt alles wat opzij staat uit de reservering, in `month`: bij een afschrijving of bij stoppen. */
function drawReserve(db: Conn, recurringId: string, month: string, transactionId?: string): void {
	const row = reservationRow(db, recurringId, month);
	const balance = reserveBalance(db, recurringId, month);
	db.update(reservations)
		.set({
			drawnCents: row.drawnCents + Math.max(0, balance),
			...(transactionId && { transactionId })
		})
		.where(eq(reservations.id, row.id))
		.run();
}

function defaultAccountId(db: Conn): string {
	const sns =
		db.select({ id: accounts.id }).from(accounts).where(eq(accounts.kind, 'sns')).get() ??
		db.select({ id: accounts.id }).from(accounts).orderBy(asc(accounts.createdAt)).get();
	if (!sns) throw new Error('Geen rekening');
	return sns.id;
}

function categoryExists(db: Conn, id: string): boolean {
	return (
		db.select({ id: categories.id }).from(categories).where(eq(categories.id, id)).get() !==
		undefined
	);
}

// --- Herkennen en voorstellen ---------------------------------------------------------------

/**
 * Zoekt vaste lasten in de historie en bewaart nieuwe kandidaten als voorstel. Een voorstel dat
 * je al bevestigde, afwees of stopte komt niet terug; een open voorstel krijgt de nieuwste cijfers.
 */
export function refreshProposals(db: DB, today = toIsoDate(new Date())): number {
	const from = `${shiftMonth(today.slice(0, 7), -HISTORY_MONTHS)}-01`;
	const internal = db
		.select({ id: categories.id })
		.from(categories)
		.where(eq(categories.name, INTERNAL_TRANSFER))
		.get()?.id;
	const history = db
		.select({
			date: transactions.date,
			amountCents: transactions.amountCents,
			counterparty: transactions.counterparty,
			counterIban: transactions.counterIban,
			categoryId: transactions.categoryId,
			accountId: transactions.accountId
		})
		.from(transactions)
		.where(
			and(
				gte(transactions.date, from),
				lte(transactions.date, today),
				sql`${transactions.amountCents} < 0`,
				ne(transactions.status, 'verwacht'),
				or(isNull(transactions.categorySource), ne(transactions.categorySource, 'intern')),
				internal
					? or(isNull(transactions.categoryId), ne(transactions.categoryId, internal))
					: undefined
			)
		)
		.all();
	const candidates = detectRecurring(history, today);
	if (candidates.length === 0) return 0;

	return db.transaction((tx) => {
		const known = new Map(
			tx
				.select({ id: recurring.id, matchKey: recurring.matchKey, status: recurring.status })
				.from(recurring)
				.where(
					inArray(
						recurring.matchKey,
						candidates.map((c) => c.key)
					)
				)
				.all()
				.map((r) => [r.matchKey, r])
		);
		let added = 0;
		for (const c of candidates) {
			const values = {
				counterparty: c.counterparty,
				counterIban: c.counterIban,
				interval: c.interval,
				expectedDay: c.expectedDay,
				medianCents: c.medianCents,
				minCents: c.minCents,
				maxCents: c.maxCents,
				kind: c.kind,
				nextDate: c.nextDate,
				lastDate: c.lastDate,
				lastCents: c.lastCents,
				spread: defaultSpread(c.interval),
				categoryId: c.categoryId,
				accountId: c.accountId
			};
			const existing = known.get(c.key);
			if (!existing) {
				tx.insert(recurring)
					.values({ matchKey: c.key, status: 'voorstel', ...values })
					.run();
				added++;
			} else if (existing.status === 'voorstel') {
				tx.update(recurring)
					.set({ ...values, updatedAt: new Date().toISOString() })
					.where(eq(recurring.id, existing.id))
					.run();
			}
		}
		return added;
	});
}

export interface ConfirmProposal {
	nextDate: string;
	categoryId: string | null;
	spread: boolean;
}

/**
 * Kies je zelf een andere volgende datum, dan volgt de verwachte dag die datum. Behalve als de
 * datum alleen korter is omdat de maand korter is (31 wordt 30 november).
 */
function dayFor(nextDate: string, expectedDay: number): number {
	const day = Number(nextDate.slice(8, 10));
	const clamped = day === daysInMonth(nextDate.slice(0, 7)) && expectedDay > day;
	return clamped ? expectedDay : day;
}

function checkNextDate(nextDate: string, today: string): void {
	const monthStart = `${today.slice(0, 7)}-01`;
	if (nextDate < monthStart)
		throw new ValidationError('De volgende afschrijving ligt al voor deze maand');
	if (nextDate > addDays(today, 400))
		throw new ValidationError('De volgende afschrijving ligt te ver weg');
}

/** "Ja, vaste last": vanaf nu verwachte posten en, als hij uitgesmeerd wordt, reserveringen. */
export function confirmProposal(
	db: DB,
	id: string,
	input: ConfirmProposal,
	today = toIsoDate(new Date())
): void {
	checkNextDate(input.nextDate, today);
	if (input.categoryId && !categoryExists(db, input.categoryId))
		throw new ValidationError('Onbekende categorie');
	db.transaction((tx) => {
		const before = tx.select().from(recurring).where(eq(recurring.id, id)).get();
		if (!before || before.status !== 'voorstel')
			throw new ValidationError('Dit voorstel bestaat niet meer');
		const after = tx
			.update(recurring)
			.set({
				status: 'actief',
				nextDate: input.nextDate,
				expectedDay: dayFor(input.nextDate, before.expectedDay),
				categoryId: input.categoryId,
				spread: input.spread && before.interval !== 'maand',
				accountId: before.accountId ?? defaultAccountId(tx),
				updatedAt: new Date().toISOString()
			})
			.where(eq(recurring.id, id))
			.returning()
			.get();
		recordChange(tx, 'bevestigd', 'recurring', id, before, after);
	});
	generateMonth(db, today.slice(0, 7), { only: id });
}

/** "Nee": het voorstel komt niet terug. */
export function rejectProposal(db: DB, id: string): void {
	db.transaction((tx) => {
		const before = tx.select().from(recurring).where(eq(recurring.id, id)).get();
		if (!before || before.status !== 'voorstel')
			throw new ValidationError('Dit voorstel bestaat niet meer');
		tx.update(recurring)
			.set({ status: 'afgewezen', updatedAt: new Date().toISOString() })
			.where(eq(recurring.id, id))
			.run();
		recordChange(tx, 'afgewezen', 'recurring', id, before, { status: 'afgewezen' });
	});
}

// --- Verwachte posten en reserveringen ------------------------------------------------------

/**
 * Begin van de maand: per actieve vaste last de reservering (bij uitsmeren, tot en met de
 * afschrijfmaand) en in de afschrijfmaand een verwachte post op de verwachte dag met het
 * mediane bedrag. Idempotent: twee keer draaien maakt niets dubbel, en wat al bestaat
 * (ook een afgesloten maand) verandert niet.
 *
 * Loopt een vaste last achter (een post van vorige maand is nog niet bevestigd, of de job
 * draaide een maand niet), dan krijgt elke afschrijving tot en met deze maand alsnog een
 * post. Een gemiste komt zo als "gemist of opgezegd?" in beeld in plaats van stil weg te vallen.
 */
export function generateMonth(
	db: DB,
	month: string,
	opts: { only?: string } = {}
): { expected: number; reservations: number } {
	const created: string[] = [];
	let reserved = 0;
	db.transaction((tx) => {
		const active = tx
			.select()
			.from(recurring)
			.where(
				and(eq(recurring.status, 'actief'), opts.only ? eq(recurring.id, opts.only) : undefined)
			)
			.all();
		for (const r of active) {
			if (!r.nextDate) continue;
			const { dates: due, next } = occurrencesThrough({
				interval: r.interval,
				expectedDay: r.expectedDay,
				current: r.nextDate,
				previous: r.lastDate,
				until: month
			});
			// De afschrijving waarvoor deze maand opzij gaat: deze maand, of anders de volgende
			const debitMonth = due.at(-1)?.slice(0, 7) === month ? month : next.slice(0, 7);

			let reservationId: string | undefined;
			if (isSpread(r) && debitMonth >= month) {
				const existing = tx
					.select({ id: reservations.id })
					.from(reservations)
					.where(and(eq(reservations.recurringId, r.id), eq(reservations.month, month)))
					.get();
				if (existing) reservationId = existing.id;
				else {
					const balance = reserveBalance(tx, r.id, shiftMonth(month, -1));
					// Bij een gedeelde last wordt alleen jouw deel gereserveerd
					const amountCents = reservationFor({
						expectedCents: myShareCents(tx, r.id, r.medianCents, debitMonth),
						reservedCents: balance,
						month,
						debitMonth
					});
					reservationId = tx
						.insert(reservations)
						.values({ recurringId: r.id, month, amountCents, categoryId: r.categoryId })
						.returning({ id: reservations.id })
						.get().id;
					reserved++;
				}
			}

			for (const date of due) {
				const [from, to] = monthRange(date.slice(0, 7));
				const has = tx
					.select({ id: transactions.id })
					.from(transactions)
					.where(
						and(
							eq(transactions.recurringId, r.id),
							gte(transactions.date, from),
							lte(transactions.date, to)
						)
					)
					.get();
				if (has) continue;
				const row = tx
					.insert(transactions)
					.values({
						amountCents: -r.medianCents,
						date,
						counterparty: r.counterparty,
						counterIban: r.counterIban,
						categoryId: r.categoryId,
						categorySource: r.categoryId ? 'handmatig' : null,
						accountId: r.accountId ?? defaultAccountId(tx),
						source: 'verwacht',
						status: 'verwacht',
						recurringId: r.id
					})
					.returning({ id: transactions.id })
					.get();
				// Gedeeld: een post per persoon voor die maand, en splits met jouw deel
				applySharedSplit(tx, row.id);
				if (reservationId && date.slice(0, 7) === month)
					tx.update(reservations)
						.set({ transactionId: row.id })
						.where(eq(reservations.id, reservationId))
						.run();
				created.push(row.id);
			}
		}
	});
	if (created.length > 0) emit({ type: 'verwacht', transactionIds: created });
	return { expected: created.length, reservations: reserved };
}

function expectedPost(db: Conn, transactionId: string) {
	const t = db.select().from(transactions).where(eq(transactions.id, transactionId)).get();
	if (!t || t.status !== 'verwacht' || !t.recurringId)
		throw new ValidationError('Deze post wacht niet op bevestiging');
	const r = db.select().from(recurring).where(eq(recurring.id, t.recurringId)).get();
	if (!r) throw new ValidationError('Deze post wacht niet op bevestiging');
	return { t, r };
}

/**
 * Eén tik: de verwachte post wordt een gewone uitgave, eventueel met een aangepast bedrag
 * (positieve centen). Bij uitsmeren gaat de afschrijving van de reservering af; het verschil
 * telt als uitgave. Een vaste last die 2% of meer duurder is, of een wisselende boven 120% van
 * het hoogste bedrag, geeft een signaal.
 */
export function confirmExpected(
	db: DB,
	transactionId: string,
	amountCents?: number,
	today = toIsoDate(new Date())
): { signal: Signal | null } {
	let signal: Signal | null = null;
	let recurringId = '';
	db.transaction((tx) => {
		const { t, r } = expectedPost(tx, transactionId);
		recurringId = r.id;
		const amount = amountCents ?? -t.amountCents;
		if (!Number.isSafeInteger(amount) || amount <= 0)
			throw new ValidationError('Vul een bedrag in');

		const after = tx
			.update(transactions)
			.set({ status: 'bevestigd', amountCents: -amount, updatedAt: new Date().toISOString() })
			.where(eq(transactions.id, t.id))
			.returning()
			.get();
		// Gedeeld via aandelen: een percentage volgt het echte bedrag, een vast aandeel blijft
		// staan. Voorgeschoten: hun deel blijft staan, jouw deel neemt het verschil.
		applySharedSplit(tx, t.id);
		syncShareSplits(tx, t.id);

		const previous = r.lastCents;
		signal = signalFor({
			kind: r.kind,
			amountCents: amount,
			previousCents: previous,
			maxCents: r.maxCents
		});
		const patch: Partial<Recurring> = {
			...advancePast(r, t.date),
			lastCents: amount,
			minCents: Math.min(r.minCents, amount),
			maxCents: Math.max(r.maxCents, amount),
			updatedAt: new Date().toISOString()
		};
		if (signal) {
			patch.signal = signal;
			patch.signalFromCents = signal === 'prijsverhoging' ? previous : r.maxCents;
			patch.signalToCents = amount;
		}
		// Een prijsverhoging past het verwachte bedrag aan; de reserveringen schuiven vanzelf mee
		if (signal === 'prijsverhoging') patch.medianCents = amount;
		tx.update(recurring).set(patch).where(eq(recurring.id, r.id)).run();

		if (isSpread(r)) drawReserve(tx, r.id, t.date.slice(0, 7), t.id);
		recordChange(tx, 'bevestigd', 'transactions', t.id, t, after);
	});
	if (signal) emit({ type: 'signaal', recurringId, signal });
	// Na een gemiste maand kan de volgende ronde al in deze maand vallen
	generateMonth(db, today.slice(0, 7), { only: recurringId });
	return { signal };
}

/**
 * Niet afgeschreven. `gemist`: deze keer niet, de vaste last loopt door (de reservering blijft
 * staan). `opgezegd`: de vaste last stopt.
 */
export function skipExpected(
	db: DB,
	transactionId: string,
	reason: 'gemist' | 'opgezegd',
	today = toIsoDate(new Date())
): void {
	const recurringId = db.transaction((tx) => {
		const { t, r } = expectedPost(tx, transactionId);
		// Maandaandelen vervallen en wat al binnen was wordt tegoed; van een voorgeschoten
		// verdeling vervallen alleen de onbetaalde posten
		removeSharedFor(tx, t.id);
		dropSourcePosts(tx, t.id);
		tx.delete(transactions).where(eq(transactions.id, t.id)).run();
		recordChange(tx, reason, 'transactions', t.id, t, null);
		if (reason === 'gemist') {
			tx.update(recurring)
				.set({ ...advancePast(r, t.date), updatedAt: new Date().toISOString() })
				.where(eq(recurring.id, r.id))
				.run();
		}
		return r.id;
	});
	if (reason === 'opgezegd') stopRecurring(db, recurringId, today);
	else generateMonth(db, today.slice(0, 7), { only: recurringId });
}

/**
 * Stoppen: geen nieuwe posten meer, open verwachte posten vervallen en wat al gereserveerd is
 * valt vrij in deze maand.
 */
export function stopRecurring(db: DB, id: string, today = toIsoDate(new Date())): void {
	db.transaction((tx) => {
		const before = tx.select().from(recurring).where(eq(recurring.id, id)).get();
		if (!before || before.status !== 'actief')
			throw new ValidationError('Deze vaste last loopt niet');
		const open = tx
			.select({ id: transactions.id })
			.from(transactions)
			.where(and(eq(transactions.recurringId, id), eq(transactions.status, 'verwacht')))
			.all()
			.map((t) => t.id);
		for (const t of open) {
			removeSharedFor(tx, t);
			dropSourcePosts(tx, t);
		}
		if (open.length > 0) tx.delete(transactions).where(inArray(transactions.id, open)).run();
		if (isSpread(before) && reserveBalance(tx, id, today.slice(0, 7)) > 0)
			drawReserve(tx, id, today.slice(0, 7));
		const after = tx
			.update(recurring)
			.set({
				status: 'gestopt',
				stoppedAt: today,
				nextDate: null,
				updatedAt: new Date().toISOString()
			})
			.where(eq(recurring.id, id))
			.returning()
			.get();
		recordChange(tx, 'gestopt', 'recurring', id, before, after);
	});
}

export interface RecurringPatch {
	counterparty?: string;
	medianCents?: number;
	kind?: AmountKind;
	interval?: Interval;
	expectedDay?: number;
	nextDate?: string;
	categoryId?: string | null;
	spread?: boolean;
}

/**
 * Een actieve vaste last aanpassen. Open verwachte posten volgen het nieuwe bedrag, de
 * categorie en de datum; uitsmeren uitzetten laat de reservering vrijvallen, zodat de
 * afschrijfmaand gewoon de piek krijgt.
 */
export function updateRecurring(
	db: DB,
	id: string,
	patch: RecurringPatch,
	today = toIsoDate(new Date())
): void {
	if (patch.nextDate) checkNextDate(patch.nextDate, today);
	if (patch.categoryId && !categoryExists(db, patch.categoryId))
		throw new ValidationError('Onbekende categorie');
	const month = today.slice(0, 7);
	db.transaction((tx) => {
		const before = tx.select().from(recurring).where(eq(recurring.id, id)).get();
		if (!before || before.status !== 'actief')
			throw new ValidationError('Deze vaste last loopt niet');
		const interval = patch.interval ?? before.interval;
		const spread = (patch.spread ?? before.spread) && interval !== 'maand';
		if (isSpread(before) && !spread && reserveBalance(tx, id, month) > 0)
			drawReserve(tx, id, month);

		const after = tx
			.update(recurring)
			.set({
				...patch,
				...(patch.nextDate &&
					patch.expectedDay === undefined && {
						expectedDay: dayFor(patch.nextDate, before.expectedDay)
					}),
				spread,
				...(patch.medianCents !== undefined &&
					before.kind === 'vast' && {
						minCents: Math.min(before.minCents, patch.medianCents),
						maxCents: Math.max(before.maxCents, patch.medianCents)
					}),
				updatedAt: new Date().toISOString()
			})
			.where(eq(recurring.id, id))
			.returning()
			.get();

		const open = tx
			.select()
			.from(transactions)
			.where(and(eq(transactions.recurringId, id), eq(transactions.status, 'verwacht')))
			.all();
		for (const t of open) {
			if (
				after.nextDate &&
				after.nextDate.slice(0, 7) !== t.date.slice(0, 7) &&
				t.date.slice(0, 7) >= month
			) {
				// Verschoven naar een andere maand: de post komt in die maand opnieuw
				removeSharedFor(tx, t.id);
				tx.delete(transactions).where(eq(transactions.id, t.id)).run();
				continue;
			}
			tx.update(transactions)
				.set({
					amountCents: -after.medianCents,
					categoryId: after.categoryId,
					categorySource: after.categoryId ? 'handmatig' : null,
					counterparty: after.counterparty,
					...(after.nextDate &&
						after.nextDate.slice(0, 7) === t.date.slice(0, 7) && { date: after.nextDate })
				})
				.where(eq(transactions.id, t.id))
				.run();
			if (after.categoryId !== before.categoryId)
				tx.update(transactionSplits)
					.set({ categoryId: after.categoryId })
					.where(
						and(eq(transactionSplits.transactionId, t.id), eq(transactionSplits.note, MY_SHARE))
					)
					.run();
			// Gedeeld: posten en splits bij het nieuwe bedrag
			applySharedSplit(tx, t.id);
		}
		// Een andere categorie geldt vanaf deze maand; afgesloten maanden blijven zoals ze waren
		if (after.categoryId !== before.categoryId)
			tx.update(reservations)
				.set({ categoryId: after.categoryId })
				.where(and(eq(reservations.recurringId, id), gte(reservations.month, month)))
				.run();
		recordChange(tx, 'gewijzigd', 'recurring', id, before, after);
	});
	generateMonth(db, month, { only: id });
}

export function dismissSignal(db: DB, id: string): void {
	db.update(recurring)
		.set({ signal: null, signalFromCents: null, signalToCents: null })
		.where(eq(recurring.id, id))
		.run();
}

// --- Overzichten ----------------------------------------------------------------------------

export interface Awaiting {
	id: string;
	recurringId: string;
	date: string;
	amountCents: number;
	counterparty: string;
	kind: AmountKind;
	categoryName: string | null;
	categoryGroup: string | null;
	accountAlias: string;
	/** 7 dagen na de verwachte dag nog niet bevestigd */
	missed: boolean;
}

/** Verwachte vaste lasten waarvan de dag gekomen is en die op bevestiging wachten. */
export function awaitingConfirmation(db: DB, today = toIsoDate(new Date())): Awaiting[] {
	const missedBefore = addDays(today, -MISSED_AFTER_DAYS);
	return db
		.select({
			id: transactions.id,
			recurringId: recurring.id,
			date: transactions.date,
			amountCents: transactions.amountCents,
			counterparty: transactions.counterparty,
			kind: recurring.kind,
			categoryName: categories.name,
			categoryGroup: categories.group,
			accountAlias: accounts.alias
		})
		.from(transactions)
		.innerJoin(recurring, eq(recurring.id, transactions.recurringId))
		.innerJoin(accounts, eq(accounts.id, transactions.accountId))
		.leftJoin(categories, eq(categories.id, transactions.categoryId))
		.where(and(eq(transactions.status, 'verwacht'), lte(transactions.date, today)))
		.orderBy(asc(transactions.date), asc(transactions.counterparty))
		.all()
		.map((t) => ({ ...t, missed: t.date <= missedBefore }));
}

/** Verwachte posten later deze maand: tellen al mee in de planning, nog niet in je uitgaven. */
export function upcomingThisMonth(db: DB, today = toIsoDate(new Date())) {
	return db
		.select({
			id: transactions.id,
			date: transactions.date,
			amountCents: transactions.amountCents,
			counterparty: transactions.counterparty,
			categoryName: categories.name,
			categoryGroup: categories.group
		})
		.from(transactions)
		.leftJoin(categories, eq(categories.id, transactions.categoryId))
		.where(
			and(
				eq(transactions.status, 'verwacht'),
				isNotNull(transactions.recurringId),
				sql`${transactions.date} > ${today}`,
				lte(transactions.date, monthRange(today.slice(0, 7))[1])
			)
		)
		.orderBy(asc(transactions.date), asc(transactions.counterparty))
		.all();
}

export function proposalCount(db: DB): number {
	return (
		db
			.select({ n: sql<number>`count(*)` })
			.from(recurring)
			.where(eq(recurring.status, 'voorstel'))
			.get()?.n ?? 0
	);
}

export interface ReserveStatus {
	recurringId: string;
	counterparty: string;
	categoryId: string | null;
	reservedCents: number;
	expectedCents: number;
	nextDate: string | null;
}

export interface Planned {
	/** Reserveringen en verwachte of bevestigde vaste lasten in de categorie */
	plannedCents: number;
	/** Het deel daarvan dat al als uitgave telt */
	plannedSpentCents: number;
	/** Reserveringen min wat eruit gehaald is: telt als uitgave bovenop de transacties */
	reservedCents: number;
}

/**
 * Wat er per categorie gepland is in `month` (spec: Tempo met vaste lasten). Een reservering
 * telt vanaf de eerste van de maand als uitgave. Een bevestigde vaste last telt als uitgave via
 * zijn transactie; een verwachte nog niet. Bij uitsmeren komt de afschrijving uit de
 * reservering, dus is alleen het verschil met wat opzij staat gepland.
 */
export function plannedByCategory(db: DB, month: string): Map<string | null, Planned> {
	const out = new Map<string | null, Planned>();
	const at = (key: string | null) => {
		let p = out.get(key);
		if (!p) out.set(key, (p = { plannedCents: 0, plannedSpentCents: 0, reservedCents: 0 }));
		return p;
	};

	const res = db
		.select({
			recurringId: reservations.recurringId,
			amountCents: reservations.amountCents,
			drawnCents: reservations.drawnCents,
			categoryId: reservations.categoryId
		})
		.from(reservations)
		.where(eq(reservations.month, month))
		.all();
	for (const r of res) {
		const p = at(r.categoryId);
		const net = r.amountCents - r.drawnCents;
		p.reservedCents += net;
		p.plannedSpentCents += net;
		p.plannedCents += net;
	}

	const [from, to] = monthRange(month);
	const posts = db
		.select({
			id: transactions.id,
			amountCents: transactions.amountCents,
			status: transactions.status,
			categoryId: transactions.categoryId,
			recurringId: recurring.id,
			spread: recurring.spread,
			interval: recurring.interval
		})
		.from(transactions)
		.innerJoin(recurring, eq(recurring.id, transactions.recurringId))
		.where(
			and(
				gte(transactions.date, from),
				lte(transactions.date, to),
				inArray(transactions.status, ['bevestigd', 'verwacht'])
			)
		)
		.all();
	// Een gedeelde vaste last telt net als bij de uitgaven via zijn verdeling: alleen jouw deel
	// staat gepland in de categorie, het voorgeschoten deel in Terugbetaling
	const splits = Map.groupBy(
		posts.length === 0
			? []
			: db
					.select({
						transactionId: transactionSplits.transactionId,
						categoryId: transactionSplits.categoryId,
						amountCents: transactionSplits.amountCents
					})
					.from(transactionSplits)
					.where(
						inArray(
							transactionSplits.transactionId,
							posts.map((t) => t.id)
						)
					)
					.all(),
		(s) => s.transactionId
	);
	for (const t of posts) {
		const parts = splits.get(t.id) ?? [{ categoryId: t.categoryId, amountCents: t.amountCents }];
		// Bij uitsmeren komt de afschrijving uit de reservering: één keer, in de eigen categorie
		let reserve =
			t.status === 'verwacht' && isSpread(t) ? reserveBalance(db, t.recurringId, month) : 0;
		for (const part of parts) {
			const p = at(part.categoryId);
			const cents = -part.amountCents;
			if (t.status === 'bevestigd') {
				p.plannedSpentCents += cents;
				p.plannedCents += cents;
			} else if (reserve !== 0 && part.categoryId === t.categoryId) {
				p.plannedCents += cents - reserve;
				reserve = 0;
			} else {
				p.plannedCents += cents;
			}
		}
	}
	return out;
}

/** Stand van de reserveringen: "€60 van €90 opzij, afschrijving rond 1 februari". */
export function reserveStatuses(db: DB, month: string): ReserveStatus[] {
	return db
		.select()
		.from(recurring)
		.where(
			and(
				eq(recurring.status, 'actief'),
				eq(recurring.spread, true),
				ne(recurring.interval, 'maand')
			)
		)
		.orderBy(asc(recurring.nextDate))
		.all()
		.map((r) => ({
			recurringId: r.id,
			counterparty: r.counterparty,
			categoryId: r.categoryId,
			reservedCents: reserveBalance(db, r.id, month),
			// Gedeeld: alleen jouw deel gaat opzij
			expectedCents: myShareCents(db, r.id, r.medianCents, (r.nextDate ?? month).slice(0, 7)),
			nextDate: r.nextDate
		}));
}

export interface RecurringItem {
	id: string;
	counterparty: string;
	interval: Interval;
	kind: AmountKind;
	expectedDay: number;
	medianCents: number;
	minCents: number;
	maxCents: number;
	nextDate: string | null;
	lastDate: string | null;
	spread: boolean;
	status: Recurring['status'];
	categoryId: string | null;
	categoryName: string | null;
	categoryGroup: string | null;
	signal: Signal | null;
	signalFromCents: number | null;
	signalToCents: number | null;
	stoppedAt: string | null;
	perMonthCents: number;
	perYearCents: number;
	reservedCents: number;
	/** Bij een gedeelde last jouw deel van het bedrag per keer; anders null */
	mineCents: number | null;
}

/** Alle vaste lasten met bedrag per maand en per jaar, plus de open voorstellen. */
export function recurringOverview(db: DB, today = toIsoDate(new Date())) {
	const month = today.slice(0, 7);
	const rows = db
		.select({ r: recurring, categoryName: categories.name, categoryGroup: categories.group })
		.from(recurring)
		.leftJoin(categories, eq(categories.id, recurring.categoryId))
		.where(inArray(recurring.status, ['voorstel', 'actief', 'gestopt']))
		.orderBy(desc(recurring.medianCents), asc(recurring.counterparty))
		.all();
	const items: RecurringItem[] = rows.map(({ r, categoryName, categoryGroup }) => ({
		id: r.id,
		counterparty: r.counterparty,
		interval: r.interval,
		kind: r.kind,
		expectedDay: r.expectedDay,
		medianCents: r.medianCents,
		minCents: r.minCents,
		maxCents: r.maxCents,
		nextDate: r.nextDate,
		lastDate: r.lastDate,
		spread: isSpread(r),
		status: r.status,
		categoryId: r.categoryId,
		categoryName,
		categoryGroup,
		signal: r.signal,
		signalFromCents: r.signalFromCents,
		signalToCents: r.signalToCents,
		stoppedAt: r.stoppedAt,
		perMonthCents: perMonthCents(r.medianCents, r.interval),
		perYearCents: perYearCents(r.medianCents, r.interval),
		reservedCents: isSpread(r) ? reserveBalance(db, r.id, month) : 0,
		mineCents: isShared(db, r.id)
			? myShareCents(db, r.id, r.medianCents, (r.nextDate ?? today).slice(0, 7))
			: null
	}));
	const active = items.filter((i) => i.status === 'actief');
	const perYear = active.reduce((s, i) => s + i.perYearCents, 0);
	return {
		proposals: items.filter((i) => i.status === 'voorstel'),
		active,
		stopped: items.filter((i) => i.status === 'gestopt'),
		totalPerYearCents: perYear,
		totalPerMonthCents: Math.round(perYear / 12)
	};
}

export function getRecurring(db: DB, id: string, today = toIsoDate(new Date())) {
	const item = recurringOverview(db, today);
	const found = [...item.active, ...item.proposals, ...item.stopped].find((i) => i.id === id);
	if (!found) return null;
	const history = db
		.select({
			id: transactions.id,
			date: transactions.date,
			amountCents: transactions.amountCents,
			status: transactions.status
		})
		.from(transactions)
		.where(eq(transactions.recurringId, id))
		.orderBy(desc(transactions.date))
		.limit(12)
		.all();
	return { ...found, history };
}

// --- Maandjob -------------------------------------------------------------------------------

export const MONTHLY_JOB = 'vaste_lasten_maand';

/** Eerste van de volgende maand, net na middernacht lokale tijd. */
export function nextMonthStart(now: Date): Date {
	return new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 5);
}

/** De job aan het begin van de maand: voorstellen bijwerken, posten en reserveringen maken. */
export function runMonthly(db: DB, now: Date): void {
	const today = toIsoDate(now);
	refreshProposals(db, today);
	const result = generateMonth(db, today.slice(0, 7));
	log.info(
		{ job: MONTHLY_JOB, expected: result.expected, reserved: result.reservations },
		'vaste lasten'
	);
}

/**
 * Registreert de maandjob en plant hem in: bij het starten één keer meteen (idempotent, voor
 * als de server aan het begin van de maand uit stond), daarna steeds op de eerste van de maand.
 */
export function scheduleRecurringJobs(db: DB, now = new Date()): void {
	registerJob(MONTHLY_JOB, (conn, _payload, at) => {
		// Eerst de volgende inplannen: een fout hier mag de maand erna niet tegenhouden
		const next = nextMonthStart(at);
		const planned = conn
			.select({ id: jobs.id })
			.from(jobs)
			.where(
				and(
					eq(jobs.kind, MONTHLY_JOB),
					eq(jobs.status, 'wachtend'),
					gte(jobs.runAt, next.toISOString())
				)
			)
			.get();
		if (!planned) enqueue(conn, MONTHLY_JOB, next);
		runMonthly(conn, at);
	});
	ensureScheduled(db, MONTHLY_JOB, now);
}
