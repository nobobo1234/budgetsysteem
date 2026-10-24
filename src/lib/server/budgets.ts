import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import { freeThisMonth, pace, type Pace } from '../budget.ts';
import { daysInMonth } from '../dates.ts';
import { recordChange } from './audit.ts';
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
 * verdeling; verwachte posten tellen pas na bevestiging.
 */
export function spendingByCategory(db: DB, month: string): Map<string | null, number> {
	const from = `${month}-01`;
	const to = `${month}-31`;
	const rows = db.all<{ category_id: string | null; spent: number }>(sql`
		SELECT category_id, -SUM(amount) AS spent FROM (
			SELECT t.category_id, t.amount_cents AS amount
			FROM transactions t
			WHERE t.date BETWEEN ${from} AND ${to}
				AND t.status != 'verwacht'
				AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id)
			UNION ALL
			SELECT s.category_id, s.amount_cents AS amount
			FROM transaction_splits s
			JOIN transactions t ON t.id = s.transaction_id
			WHERE t.date BETWEEN ${from} AND ${to} AND t.status != 'verwacht'
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
	spentCents: number;
	spentRatio: number;
	monthRatio: number;
	pace: Pace;
}

export interface MonthOverview {
	month: string;
	freeCents: number;
	totalLimitCents: number;
	totalSpentCents: number;
	/** Uitgaven zonder categorie: tellen mee, zodat "nog vrij" nooit te rooskleurig is */
	uncategorizedCents: number;
	lines: CategoryLine[];
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

	const days = daysInMonth(month);
	const day =
		today.slice(0, 7) === month ? Number(today.slice(8, 10)) : today.slice(0, 7) > month ? days : 0;

	const lines: CategoryLine[] = cats.map((c) => {
		const limitCents = limits.get(c.id) ?? 0;
		const spentCents = spending.get(c.id) ?? 0;
		return {
			categoryId: c.id,
			name: c.name,
			group: c.group,
			limitCents,
			spentCents,
			...pace({ spentCents, limitCents, day, daysInMonth: days })
		};
	});

	// Uitgaven zonder categorie tellen als uitgave; inkomsten zonder categorie niet als ruimte
	const uncategorizedCents = Math.max(0, spending.get(null) ?? 0);
	const withLimit = lines.filter((l) => l.limitCents > 0);
	const withoutLimitSpent = lines
		.filter((l) => l.limitCents === 0)
		.reduce((sum, l) => sum + Math.max(0, l.spentCents), 0);

	return {
		month,
		freeCents: freeThisMonth(withLimit, withoutLimitSpent + uncategorizedCents),
		totalLimitCents: withLimit.reduce((s, l) => s + l.limitCents, 0),
		totalSpentCents: lines.reduce((s, l) => s + Math.max(0, l.spentCents), 0) + uncategorizedCents,
		uncategorizedCents,
		lines
	};
}
