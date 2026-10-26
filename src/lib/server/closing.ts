import { and, asc, desc, eq, gte, inArray, lte, max, min, sql } from 'drizzle-orm';
import { z } from 'zod';
import { FIXED_GROUP } from '../budget.ts';
import {
	changedSince,
	closingSplit,
	compareMonths,
	extremes,
	lastDayOf,
	limitProposals,
	monthName,
	openItemsFor,
	outcomeOf,
	type Change,
	type ClosingLine,
	type ClosingSnapshot,
	type LimitProposal,
	type MonthSpending,
	type OpenItem,
	type OpenSources
} from '../closing.ts';
import { shiftMonth } from '../dates.ts';
import { afsluiting } from '../icons.ts';
import { recordChange } from './audit.ts';
import { monthOverview, setBudget, spendingByCategory } from './budgets.ts';
import type { Conn, DB } from './db/index.ts';
import {
	accounts,
	balanceAnchors,
	balanceChecks,
	budgets,
	categories,
	monthClosings,
	recurring,
	reservations,
	transactions
} from './db/schema.ts';
import { ValidationError } from './errors.ts';
import { awaitingConfirmation, plannedByCategory } from './recurring.ts';
import { reviewInbox, type ReviewInbox } from './review.ts';

// Maandafsluiting (spec: Analyses → Maandafsluiting). Haalt de open punten en de inhoud van een
// maand uit wat er al is (budgets, vaste lasten, te krijgen, review-inbox, saldocheck) en legt
// bij het afsluiten een momentopname vast. De rekenregels staan in `src/lib/closing.ts`.

export type { ClosingSnapshot, OpenItem };

// --- Open punten -----------------------------------------------------------------------------

/** De review-inbox als platte lijst met een datum per item, voor de open punten per maand. */
function inboxItems(inbox: ReviewInbox): OpenSources['inbox'] {
	return [
		...inbox.receipts.map((r) => ({
			kind: 'bon' as const,
			id: r.id,
			name: r.store ?? '',
			date: r.date ?? r.createdAt.slice(0, 10),
			amountCents: r.currency === null || r.currency === 'EUR' ? r.totalCents : null,
			href: `/bonnen/${r.id}`
		})),
		...inbox.transactions.map((t) => ({
			kind: 'boeking' as const,
			id: t.id,
			name: t.counterparty,
			date: t.date,
			amountCents: t.amountCents,
			href: `/transacties/${t.id}`
		})),
		...inbox.late.map((l) => ({
			kind: 'aandeel' as const,
			id: l.id,
			name: l.personName,
			date: l.dueDate,
			amountCents: l.outstandingCents,
			href: '/te-controleren'
		})),
		...inbox.credit.map((c) => ({
			kind: 'tegoed' as const,
			id: c.personId,
			name: c.personName,
			date: c.date,
			amountCents: c.creditCents,
			href: '/te-controleren'
		})),
		...inbox.reminders.map((r) => ({
			kind: 'herinnering' as const,
			id: r.id,
			name: r.personName ?? '',
			date: r.date,
			amountCents: r.outstandingCents,
			href: '/te-controleren'
		}))
	];
}

/** Rekeningen met de eerste dag dat ze in gebruik waren (anker of boeking) en de laatste check. */
function accountUse(db: Conn): OpenSources['accounts'] {
	const firstTx = new Map(
		db
			.select({ id: transactions.accountId, first: min(transactions.date) })
			.from(transactions)
			.groupBy(transactions.accountId)
			.all()
			.map((r) => [r.id, r.first])
	);
	const anchors = new Map(
		db
			.select({ id: balanceAnchors.accountId, date: balanceAnchors.date })
			.from(balanceAnchors)
			.all()
			.map((r) => [r.id, r.date])
	);
	const checks = new Map(
		db
			.select({ id: balanceChecks.accountId, last: max(balanceChecks.date) })
			.from(balanceChecks)
			.groupBy(balanceChecks.accountId)
			.all()
			.map((r) => [r.id, r.last])
	);
	return db
		.select({ id: accounts.id, name: accounts.name })
		.from(accounts)
		.orderBy(asc(accounts.createdAt))
		.all()
		.map((a) => {
			const dates = [firstTx.get(a.id), anchors.get(a.id)].filter((d): d is string => !!d);
			return {
				...a,
				firstUse: dates.length > 0 ? dates.sort()[0]! : null,
				lastCheck: checks.get(a.id) ?? null
			};
		});
}

/**
 * Wat de cijfers van `month` nog onzeker maakt. Geef de review-inbox mee als die er al is (het
 * startscherm rekent hem toch uit).
 */
export function openItems(db: DB, month: string, today: string, inbox?: ReviewInbox): OpenItem[] {
	return openItemsFor(month, {
		expected: awaitingConfirmation(db, today),
		inbox: inboxItems(inbox ?? reviewInbox(db, today)),
		accounts: accountUse(db)
	});
}

// --- Inhoud ----------------------------------------------------------------------------------

function budgetCategoryIds(db: Conn): Set<string> {
	return new Set(
		db
			.select({ id: categories.id })
			.from(categories)
			.where(and(eq(categories.archived, false), eq(categories.countsForBudget, true)))
			.all()
			.map((c) => c.id)
	);
}

/** Of er over een maand iets bekend is: een boeking of een limiet. */
export function hasMonthData(db: Conn, month: string): boolean {
	const tx = db
		.select({ id: transactions.id })
		.from(transactions)
		.where(and(gte(transactions.date, `${month}-01`), lte(transactions.date, `${month}-31`)))
		.limit(1)
		.get();
	if (tx) return true;
	return !!db.select({ id: budgets.id }).from(budgets).where(eq(budgets.month, month)).get();
}

/**
 * Uitgaven per budgetcategorie in een eerdere maand, zoals op Budget (reserveringen tellen mee),
 * zonder iets aan te maken: `monthOverview` zou ontbrekende limieten van die maand invullen.
 */
function spendingOf(db: DB, month: string, ids: Set<string>): MonthSpending {
	const spending = spendingByCategory(db, month);
	const planned = plannedByCategory(db, month);
	const byCategory: Record<string, number> = {};
	for (const id of ids) {
		const cents = (spending.get(id) ?? 0) + (planned.get(id)?.reservedCents ?? 0);
		if (cents !== 0) byCategory[id] = cents;
	}
	const uncategorized =
		Math.max(0, spending.get(null) ?? 0) + (planned.get(null)?.reservedCents ?? 0);
	const totalCents =
		Object.values(byCategory).reduce((s, c) => s + Math.max(0, c), 0) + uncategorized;
	return { totalCents, byCategory };
}

/** De limieten die in een maand golden, zonder ze aan te maken: anders die van de maand ervoor. */
function limitsAt(db: Conn, month: string): Map<string, number> {
	const source = db
		.select({ month: budgets.month })
		.from(budgets)
		.where(lte(budgets.month, month))
		.orderBy(desc(budgets.month))
		.get();
	if (!source) return new Map();
	return new Map(
		db
			.select({ categoryId: budgets.categoryId, limitCents: budgets.limitCents })
			.from(budgets)
			.where(eq(budgets.month, source.month))
			.all()
			.map((b) => [b.categoryId, b.limitCents])
	);
}

/** Wat er aan het eind van de maand nog te krijgen was: open posten min betalingen tot dan. */
function owedAt(db: Conn, last: string): number {
	const row = db.get<{ cents: number | null }>(sql`
		SELECT SUM(MAX(0, o.amount_cents - COALESCE((
			SELECT SUM(p.amount_cents)
			FROM owed_payments p
			JOIN transactions t ON t.id = p.transaction_id
			WHERE p.owed_id = o.id AND t.date <= ${last}
		), 0))) AS cents
		FROM owed o
		WHERE o.direction = 'te_krijgen' AND o.date <= ${last} AND o.status != 'kwijtgescholden'
	`);
	return row?.cents ?? 0;
}

/** De inhoud van een maand zoals hij nu is: wat bij het afsluiten de momentopname wordt. */
export function monthContent(db: DB, month: string, today: string): ClosingSnapshot {
	const overview = monthOverview(db, month, today);
	const planned = plannedByCategory(db, month);
	const res = db
		.select({
			recurringId: reservations.recurringId,
			counterparty: recurring.counterparty,
			amountCents: reservations.amountCents
		})
		.from(reservations)
		.innerJoin(recurring, eq(recurring.id, reservations.recurringId))
		.where(and(eq(reservations.month, month), sql`${reservations.amountCents} > 0`))
		.orderBy(desc(reservations.amountCents), asc(recurring.counterparty))
		.all();
	const reservedCents = res.reduce((s, r) => s + r.amountCents, 0);
	const lines = overview.lines.map((l) => ({
		...l,
		fixed: l.group === FIXED_GROUP,
		plannedSpentCents: planned.get(l.categoryId)?.plannedSpentCents ?? 0
	}));

	const ids = new Set(overview.lines.map((l) => l.categoryId));
	const previous = [1, 2, 3]
		.map((n) => shiftMonth(month, -n))
		.filter((m) => hasMonthData(db, m))
		.map((m) => spendingOf(db, m, ids));
	const byCategory: Record<string, number> = {};
	for (const l of overview.lines) if (l.spentCents !== 0) byCategory[l.categoryId] = l.spentCents;

	return {
		version: 1,
		outcome: outcomeOf(overview.freeCents, overview.totalLimitCents, overview.totalSpentCents),
		totalLimitCents: overview.totalLimitCents,
		totalSpentCents: overview.totalSpentCents,
		freeCents: overview.freeCents,
		split: closingSplit(lines, reservedCents, overview.uncategorizedCents, overview.freeCents),
		categories: overview.lines
			.filter((l) => l.limitCents > 0 || l.spentCents !== 0)
			.map((l): ClosingLine => ({
				categoryId: l.categoryId,
				name: l.name,
				group: l.group,
				limitCents: l.limitCents,
				spentCents: l.spentCents
			})),
		comparison: compareMonths({ totalCents: overview.totalSpentCents, byCategory }, previous),
		owedCents: owedAt(db, lastDayOf(month)),
		reservations: res
	};
}

/**
 * Voorstellen voor de limieten van de maand na `month`. Alleen zolang die maand nog niet
 * voorbij is: voor een oude afsluiting heeft een voorstel geen zin meer.
 */
export function proposalsFor(db: DB, month: string, today: string): LimitProposal[] {
	const next = shiftMonth(month, 1);
	if (next < today.slice(0, 7)) return [];
	const ids = budgetCategoryIds(db);
	const cats = db
		.select({ id: categories.id, name: categories.name, group: categories.group })
		.from(categories)
		.where(inArray(categories.id, [...ids]))
		.orderBy(asc(categories.sortOrder), asc(categories.name))
		.all();
	const months = [0, 1, 2].map((n) => shiftMonth(month, -n));
	const limits = months.map((m) => limitsAt(db, m));
	const spent = months.map((m) => spendingOf(db, m, ids).byCategory);
	const current = limitsAt(db, next);
	return limitProposals(
		cats.map((c) => ({
			categoryId: c.id,
			name: c.name,
			group: c.group,
			currentLimitCents: current.get(c.id) ?? 0,
			months: months.map((_, i) => ({
				limitCents: limits[i]!.get(c.id) ?? 0,
				spentCents: spent[i]![c.id] ?? 0
			}))
		}))
	);
}

/** Eén tik: het voorstel voor deze categorie wordt de limiet van de nieuwe maand. */
export function applyProposal(db: DB, month: string, categoryId: string, today: string): number {
	const proposal = proposalsFor(db, month, today).find((p) => p.categoryId === categoryId);
	if (!proposal) throw new ValidationError('Voor deze categorie is er geen voorstel meer.');
	setBudget(db, shiftMonth(month, 1), categoryId, proposal.toCents);
	return proposal.toCents;
}

// --- Afsluiten -------------------------------------------------------------------------------

const lineSchema = z.object({
	categoryId: z.string(),
	name: z.string(),
	group: z.string(),
	limitCents: z.number().int(),
	spentCents: z.number().int()
});
const cents = z.number().int();
const snapshotSchema = z.object({
	version: z.literal(1),
	outcome: z.object({ kind: z.enum(['over', 'tekort', 'zonder']), cents }),
	totalLimitCents: cents,
	totalSpentCents: cents,
	freeCents: cents,
	split: z.object({ fixedCents: cents, reservedCents: cents, dailyCents: cents, freeCents: cents }),
	categories: z.array(lineSchema),
	comparison: z
		.object({
			totalCents: cents,
			averageCents: cents,
			months: z.number().int(),
			riser: z.object({ categoryId: z.string(), diffCents: cents }).nullable(),
			faller: z.object({ categoryId: z.string(), diffCents: cents }).nullable()
		})
		.nullable(),
	owedCents: cents,
	reservations: z.array(
		z.object({ recurringId: z.string(), counterparty: z.string(), amountCents: cents })
	)
});
const openSchema = z.array(
	z.object({
		kind: z.enum(['verwacht', 'bon', 'boeking', 'aandeel', 'tegoed', 'herinnering', 'saldocheck']),
		id: z.string(),
		name: z.string(),
		date: z.string().nullable(),
		amountCents: cents.nullable(),
		href: z.string().regex(/^\/(?!\/)/)
	})
);

export interface Closing {
	month: string;
	closedAt: string;
	snapshot: ClosingSnapshot;
	openItems: OpenItem[];
}

function parseClosing(row: typeof monthClosings.$inferSelect): Closing {
	return {
		month: row.month,
		closedAt: row.closedAt,
		snapshot: snapshotSchema.parse(row.snapshot),
		openItems: openSchema.parse(row.openItems)
	};
}

export function getClosing(db: Conn, month: string): Closing | null {
	const row = db.select().from(monthClosings).where(eq(monthClosings.month, month)).get();
	return row ? parseClosing(row) : null;
}

/** Afgesloten maanden, de nieuwste eerst. */
export function closedMonths(db: Conn): Closing[] {
	return db.select().from(monthClosings).orderBy(desc(monthClosings.month)).all().map(parseClosing);
}

/**
 * De knop "Maand afsluiten": legt de momentopname en de open punten vast. Kan ook met open
 * punten. Zet niets op slot en verandert geen bedragen.
 */
export function closeMonth(db: DB, month: string, today: string): Closing {
	if (month >= today.slice(0, 7)) throw new ValidationError('Deze maand loopt nog.');
	const snapshot = monthContent(db, month, today);
	const open = openItems(db, month, today);
	return db.transaction((tx) => {
		if (getClosing(tx, month)) throw new ValidationError('Deze maand is al afgesloten.');
		const row = tx
			.insert(monthClosings)
			.values({ month, snapshot, openItems: open })
			.returning()
			.get();
		recordChange(tx, 'afgesloten', 'month_closings', month, null, {
			openItems: open.length,
			totalSpentCents: snapshot.totalSpentCents
		});
		return parseClosing(row);
	});
}

// --- Pagina en signaalkaartje ----------------------------------------------------------------

export interface ClosingPage {
	month: string;
	/** `loopt`: de maand is nog niet voorbij; `klaar`: klaar om af te sluiten */
	status: 'loopt' | 'klaar' | 'afgesloten';
	hasData: boolean;
	/** De groep van de vaste lasten, voor de kleur in de balk */
	fixedGroup: string;
	/** Bij een afgesloten maand de momentopname, anders de cijfers van nu */
	content: ClosingSnapshot;
	extremes: ReturnType<typeof extremes>;
	open: OpenItem[];
	/** Alleen bij een afgesloten maand */
	closedAt: string | null;
	openAtClose: OpenItem[];
	change: Change | null;
	proposals: LimitProposal[];
}

const EMPTY: ClosingSnapshot = {
	version: 1,
	outcome: { kind: 'zonder', cents: 0 },
	totalLimitCents: 0,
	totalSpentCents: 0,
	freeCents: 0,
	split: { fixedCents: 0, reservedCents: 0, dailyCents: 0, freeCents: 0 },
	categories: [],
	comparison: null,
	owedCents: 0,
	reservations: []
};

export function closingPage(db: DB, month: string, today: string): ClosingPage {
	const running = month >= today.slice(0, 7);
	const closing = running ? null : getClosing(db, month);
	// Een lopende of toekomstige maand rekenen we niet door: dat zou er limieten voor aanmaken
	const live = running ? EMPTY : monthContent(db, month, today);
	const content = closing?.snapshot ?? live;
	return {
		month,
		status: running ? 'loopt' : closing ? 'afgesloten' : 'klaar',
		hasData: hasMonthData(db, month),
		fixedGroup: FIXED_GROUP,
		content,
		extremes: extremes(content.categories),
		open: running ? [] : openItems(db, month, today),
		closedAt: closing?.closedAt ?? null,
		openAtClose: closing?.openItems ?? [],
		change: closing ? changedSince(closing.snapshot, live) : null,
		proposals: running ? [] : proposalsFor(db, month, today)
	};
}

/**
 * Het signaalkaartje op het startscherm: vanaf de eerste staat de vorige maand klaar tot je hem
 * afsluit. Niet voor een maand waar niets over bekend is, zoals vóór de eerste import. Het
 * kaartje komt kant-en-klaar van de server, met icoon: zo blijft de eerste JS-bundel van het
 * startscherm klein (spec: Performance-budget).
 */
export function closingSignal(db: DB, today: string, inbox?: ReviewInbox) {
	const month = shiftMonth(today.slice(0, 7), -1);
	if (getClosing(db, month) || !hasMonthData(db, month)) return null;
	const open = openItems(db, month, today, inbox).length;
	return {
		month,
		open,
		href: `/afsluiting/${month}`,
		icon: afsluiting,
		big: monthName(month),
		small:
			open === 0 ? 'afsluiten' : `afsluiten, nog ${open} open ${open === 1 ? 'punt' : 'punten'}`,
		morph: 'titel' as const
	};
}

/** Voor de lijst: de laatste maand die nog niet afgesloten is, als die er is. */
export function pendingMonth(db: DB, today: string): string | null {
	const month = shiftMonth(today.slice(0, 7), -1);
	return getClosing(db, month) || !hasMonthData(db, month) ? null : month;
}
