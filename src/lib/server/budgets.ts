import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import { freeThisMonth, pace, type Pace } from '../budget.ts';
import { daysInMonth } from '../dates.ts';
import { recordChange } from './audit.ts';
import { lateCorrections } from './corrections.ts';
import { plannedByCategory, reserveStatuses, type ReserveStatus } from './recurring.ts';
import type { DB } from './db/index.ts';
import { budgets, categories } from './db/schema.ts';

/** Een nieuwe maand neemt de limieten van de laatste maand met limieten over. */
export function ensureBudgets(db: DB, month: string): void {
	db.transaction((tx) => {
		const has = tx.select({ id: budgets.id }).from(budgets).where(eq(budgets.month, month)).get();
		if (has) return;
		const previous = tx
			.select({ month: budgets.month })
			.from(budgets)
			.where(lt(budgets.month, month))
			.orderBy(desc(budgets.month))
			.get();
		if (!previous) return;
		const rows = tx.select().from(budgets).where(eq(budgets.month, previous.month)).all();
		if (rows.length === 0) return;
		tx.insert(budgets)
			.values(rows.map((r) => ({ month, categoryId: r.categoryId, limitCents: r.limitCents })))
			.onConflictDoNothing()
			.run();
	});
}

export function setBudget(db: DB, month: string, categoryId: string, limitCents: number): void {
	db.transaction((tx) => {
		const before = tx
			.select()
			.from(budgets)
			.where(and(eq(budgets.month, month), eq(budgets.categoryId, categoryId)))
			.get();
		tx.insert(budgets)
			.values({ month, categoryId, limitCents })
			.onConflictDoUpdate({ target: [budgets.month, budgets.categoryId], set: { limitCents } })
			.run();
		recordChange(tx, 'limiet', 'budgets', `${month}:${categoryId}`, before ?? null, { limitCents });
	});
}

/**
 * Uitgaven per categorie in een maand, als positief getal. Gedeelde uitgaven tellen via hun
 * verdeling; verwachte posten tellen pas na bevestiging. Een terugboeking telt in de maand van
 * de boeking die hij verrekent, ook als het geld later binnenkwam.
 */
export function spendingByCategory(db: DB, month: string): Map<string | null, number> {
	const from = `${month}-01`;
	const to = `${month}-31`;
	const rows = db.all<{ category_id: string | null; spent: number }>(sql`
		WITH booked AS (
			SELECT t.id, t.category_id, t.amount_cents
			FROM transactions t
			WHERE t.date BETWEEN ${from} AND ${to}
				AND t.correction_of IS NULL
				AND t.status != 'verwacht'
			UNION ALL
			SELECT t.id, t.category_id, t.amount_cents
			FROM transactions o
			JOIN transactions t ON t.correction_of = o.id
			WHERE o.date BETWEEN ${from} AND ${to} AND t.status != 'verwacht'
		)
		SELECT category_id, -SUM(amount) AS spent FROM (
			SELECT b.category_id, b.amount_cents AS amount
			FROM booked b
			WHERE NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = b.id)
			UNION ALL
			SELECT s.category_id, s.amount_cents AS amount
			FROM transaction_splits s
			JOIN booked b ON b.id = s.transaction_id
		)
		GROUP BY category_id
	`);
	return new Map(rows.map((r) => [r.category_id, r.spent]));
}

export interface CategoryLine {
	categoryId: string;
	name: string;
	group: string;
	limitCents: number;
	/** Uitgegeven, inclusief reserveringen (die tellen vanaf de eerste van de maand) */
	spentCents: number;
	spentRatio: number;
	monthRatio: number;
	pace: Pace;
	/** Gepland: reserveringen en verwachte of bevestigde vaste lasten */
	plannedCents: number;
	plannedSpentCents: number;
	otherCents: number;
	freeLimitCents: number;
	/** Uitgesmeerde vaste lasten in deze categorie, met wat er opzij staat */
	reserves: ReserveStatus[];
}

export interface MonthOverview {
	month: string;
	freeCents: number;
	totalLimitCents: number;
	totalSpentCents: number;
	/** Uitgaven zonder categorie: tellen mee, zodat "nog vrij" nooit te rooskleurig is */
	uncategorizedCents: number;
	lines: CategoryLine[];
	/** Terugboekingen die na afloop binnenkwamen en in deze maand verrekend zijn */
	lateCorrections: ReturnType<typeof lateCorrections>;
}

export function monthOverview(db: DB, month: string, today: string): MonthOverview {
	ensureBudgets(db, month);
	const cats = db
		.select()
		.from(categories)
		.where(and(eq(categories.archived, false), eq(categories.countsForBudget, true)))
		.orderBy(asc(categories.sortOrder), asc(categories.name))
		.all();
	const limits = new Map(
		db
			.select()
			.from(budgets)
			.where(eq(budgets.month, month))
			.all()
			.map((b) => [b.categoryId, b.limitCents])
	);
	const spending = spendingByCategory(db, month);
	const planned = plannedByCategory(db, month);
	const reserves = Map.groupBy(reserveStatuses(db, month), (r) => r.categoryId);

	const days = daysInMonth(month);
	const day =
		today.slice(0, 7) === month ? Number(today.slice(8, 10)) : today.slice(0, 7) > month ? days : 0;

	const lines: CategoryLine[] = cats.map((c) => {
		const limitCents = limits.get(c.id) ?? 0;
		const p = planned.get(c.id);
		// Een reservering is geen transactie, maar telt wel als uitgave in de categorie
		const spentCents = (spending.get(c.id) ?? 0) + (p?.reservedCents ?? 0);
		const plannedCents = p?.plannedCents ?? 0;
		const plannedSpentCents = p?.plannedSpentCents ?? 0;
		return {
			categoryId: c.id,
			name: c.name,
			group: c.group,
			limitCents,
			spentCents,
			plannedCents,
			plannedSpentCents,
			reserves: reserves.get(c.id) ?? [],
			...pace({ spentCents, limitCents, plannedCents, plannedSpentCents, day, daysInMonth: days })
		};
	});

	// Uitgaven zonder categorie tellen als uitgave; inkomsten zonder categorie niet als ruimte.
	// Een reservering die vrijvalt (stoppen, goedkoper afgeschreven) geeft wel ruimte terug:
	// alleen de transacties worden op nul afgekapt, niet de reserveringen.
	const uncategorizedCents =
		Math.max(0, spending.get(null) ?? 0) + (planned.get(null)?.reservedCents ?? 0);
	const withLimit = lines.filter((l) => l.limitCents > 0);
	const withoutLimitSpent = lines
		.filter((l) => l.limitCents === 0)
		.reduce((sum, l) => {
			const reserved = planned.get(l.categoryId)?.reservedCents ?? 0;
			return sum + Math.max(0, l.spentCents - reserved) + reserved;
		}, 0);

	return {
		month,
		freeCents: freeThisMonth(withLimit, withoutLimitSpent + uncategorizedCents),
		totalLimitCents: withLimit.reduce((s, l) => s + l.limitCents, 0),
		totalSpentCents: lines.reduce((s, l) => s + Math.max(0, l.spentCents), 0) + uncategorizedCents,
		uncategorizedCents,
		lines,
		lateCorrections: lateCorrections(db, month)
	};
}
