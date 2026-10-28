import { and, asc, eq, sql } from 'drizzle-orm';
import { MAX_CENTS } from '../money.ts';
import {
	historyMonths,
	median,
	MIN_HISTORY_MONTHS,
	proposeLimit,
	type Proposal
} from '../startLimits.ts';
import { recordChange } from './audit.ts';
import { bookedParts, ensureBudgets } from './budgets.ts';
import type { Conn, DB } from './db/index.ts';
import { budgets, categories } from './db/schema.ts';
import { INTERNAL_TRANSFER } from './db/seed.ts';
import { ValidationError } from './errors.ts';
import { REFUND_CATEGORY } from './owed.ts';
import { plannedByCategory } from './recurring.ts';

// Startlimieten uit historie (spec: Analyses → Startlimieten uit historie): per categorie zonder
// limiet een eerste limiet uit de mediaan van de laatste volle maanden. Alles via SQL op de
// eigen server; de berekening zelf staat in startLimits.ts.

/**
 * Waar de historie begint: de vroegste periode van een import, of anders de vroegste geboekte
 * transactie. Verwachte posten tellen niet: die liggen in de toekomst.
 */
export function historyStart(db: Conn): string | null {
	const row = db.get<{ start: string | null }>(sql`
		SELECT MIN(start) AS start FROM (
			SELECT MIN(period_start) AS start FROM import_batches
			UNION ALL
			SELECT MIN(date) FROM transactions WHERE status != 'verwacht'
		)
	`);
	return row?.start ?? null;
}

/** Of er genoeg volle maanden historie zijn voor een voorstel. */
export function hasEnoughHistory(db: Conn, today: string): boolean {
	return historyMonths(today.slice(0, 7), historyStart(db)).length >= MIN_HISTORY_MONTHS;
}

const range = (months: readonly string[]) => [`${months[0]}-01`, `${months.at(-1)}-31`] as const;

/**
 * Uitgaven per categorie per maand die niet bij een vaste last horen, met splits en verrekende
 * terugboekingen zoals op Budget (`bookedParts`). Als positief getal.
 */
function monthlySpending(db: DB, months: readonly string[]): Map<string, Map<string, number>> {
	const [from, to] = range(months);
	const rows = db.all<{ month: string; category_id: string; spent: number }>(sql`
		${bookedParts(from, to)}
		SELECT substr(date, 1, 7) AS month, category_id, -SUM(amount) AS spent
		FROM parts
		WHERE recurring_id IS NULL AND category_id IS NOT NULL
		GROUP BY month, category_id
	`);
	const out = new Map<string, Map<string, number>>();
	for (const r of rows) {
		let byMonth = out.get(r.category_id);
		if (!byMonth) out.set(r.category_id, (byMonth = new Map()));
		byMonth.set(r.month, r.spent);
	}
	return out;
}

/** Eén inkomende transactie, zonder wat anderen ermee terugbetaalden. */
export interface IncomeRow {
	id: string;
	date: string;
	counterparty: string;
	categoryId: string | null;
	accountId: string;
	cents: number;
}

/**
 * Inkomen tussen twee datums, per transactie: inkomend geld zonder interne overboekingen,
 * terugboekingen en wat anderen terugbetaalden (`owed_payments`, en de categorie Terugbetaling).
 * Inkomend geld in een categorie die meetelt voor budget telt ook niet: dat verlaagt de uitgaven
 * daar al. Gedeeld met de semantische laag, zodat inkomen overal hetzelfde telt.
 */
export function incomeRows(db: Conn, from: string, to: string): IncomeRow[] {
	return db
		.all<{
			id: string;
			date: string;
			counterparty: string;
			category_id: string | null;
			account_id: string;
			income: number;
		}>(
			sql`
		SELECT t.id, t.date, t.counterparty, t.category_id, t.account_id,
			MAX(0, t.amount_cents - COALESCE(
				(SELECT SUM(p.amount_cents) FROM owed_payments p WHERE p.transaction_id = t.id), 0
			)) AS income
		FROM transactions t
		LEFT JOIN categories c ON c.id = t.category_id
		WHERE t.date BETWEEN ${from} AND ${to}
			AND t.amount_cents > 0
			AND t.status != 'verwacht'
			AND t.correction_of IS NULL
			AND (t.category_source IS NULL OR t.category_source != 'intern')
			AND (c.id IS NULL OR (c.counts_for_budget = 0 AND c.name NOT IN (${INTERNAL_TRANSFER}, ${REFUND_CATEGORY})))
	`
		)
		.map((r) => ({
			id: r.id,
			date: r.date,
			counterparty: r.counterparty,
			categoryId: r.category_id,
			accountId: r.account_id,
			cents: r.income
		}));
}

/** Of inkomend geld in deze categorie als inkomen telt (zie `incomeRows`). */
export const isIncomeCategory = (c: { name: string; countsForBudget: boolean }) =>
	!c.countsForBudget && c.name !== INTERNAL_TRANSFER && c.name !== REFUND_CATEGORY;

/** Inkomen per maand (zie `incomeRows`). */
export function monthlyIncome(db: DB, months: readonly string[]): number[] {
	const [from, to] = range(months);
	const byMonth = new Map<string, number>();
	for (const r of incomeRows(db, from, to)) {
		const m = r.date.slice(0, 7);
		byMonth.set(m, (byMonth.get(m) ?? 0) + r.cents);
	}
	return months.map((m) => byMonth.get(m) ?? 0);
}

export interface StartLimitLine {
	categoryId: string;
	name: string;
	group: string;
	proposal: Proposal;
}

export interface StartLimitsPage {
	/** De lopende maand: daar komen de limieten in */
	month: string;
	/** De volle maanden waar het voorstel uit komt, oudste eerst */
	months: string[];
	enoughHistory: boolean;
	/** Mediaan van het inkomen over dezelfde maanden, op hele centen */
	incomeCents: number;
	/** Som van de limieten die er al zijn */
	existingLimitsCents: number;
	withLimitCount: number;
	/** Categorieën zonder limiet, in de volgorde van Budget */
	lines: StartLimitLine[];
}

function budgetCategories(db: Conn) {
	return db
		.select({ id: categories.id, name: categories.name, group: categories.group })
		.from(categories)
		.where(and(eq(categories.archived, false), eq(categories.countsForBudget, true)))
		.orderBy(asc(categories.sortOrder), asc(categories.name))
		.all();
}

function limitsFor(db: Conn, month: string): Map<string, number> {
	return new Map(
		db
			.select({ categoryId: budgets.categoryId, limitCents: budgets.limitCents })
			.from(budgets)
			.where(eq(budgets.month, month))
			.all()
			.map((b) => [b.categoryId, b.limitCents])
	);
}

export function startLimitsPage(db: DB, today: string): StartLimitsPage {
	const month = today.slice(0, 7);
	ensureBudgets(db, month);
	const months = historyMonths(month, historyStart(db));
	const enoughHistory = months.length >= MIN_HISTORY_MONTHS;
	const cats = budgetCategories(db);
	const limits = limitsFor(db, month);
	const withLimit = cats.filter((c) => (limits.get(c.id) ?? 0) > 0);
	const existingLimitsCents = withLimit.reduce((s, c) => s + limits.get(c.id)!, 0);
	const base = {
		month,
		months,
		enoughHistory,
		existingLimitsCents,
		withLimitCount: withLimit.length
	};
	if (!enoughHistory) return { ...base, incomeCents: 0, lines: [] };

	const spending = monthlySpending(db, months);
	const planned = plannedByCategory(db, month);
	const lines = cats
		.filter((c) => (limits.get(c.id) ?? 0) === 0)
		.map((c) => {
			const byMonth = spending.get(c.id);
			const monthly = months.map((m) => byMonth?.get(m) ?? 0);
			return {
				categoryId: c.id,
				name: c.name,
				group: c.group,
				proposal: proposeLimit(monthly, planned.get(c.id)?.plannedCents ?? 0)
			};
		});
	return { ...base, incomeCents: Math.round(median(monthlyIncome(db, months))), lines };
}

export interface StartLimitEntry {
	categoryId: string;
	limitCents: number;
}

/**
 * Zet de gekozen limieten voor de lopende maand, in één database-transactie; volgende maanden
 * nemen ze over zoals elke limiet. Een bestaande limiet wordt nooit overschreven. Elke limiet
 * komt in het audit-log, zodat hij ongedaan te maken is.
 */
export function applyStartLimits(
	db: DB,
	today: string,
	entries: readonly StartLimitEntry[]
): { set: number; skipped: number } {
	const month = today.slice(0, 7);
	if (entries.length === 0) throw new ValidationError('Vink minstens één categorie aan.');
	const ids = new Set(entries.map((e) => e.categoryId));
	if (ids.size !== entries.length)
		throw new ValidationError('Een categorie staat er twee keer in.');
	for (const e of entries) {
		if (!Number.isSafeInteger(e.limitCents) || e.limitCents <= 0 || e.limitCents > MAX_CENTS)
			throw new ValidationError('Een limiet moet meer dan € 0 zijn.');
	}
	ensureBudgets(db, month);
	return db.transaction((tx) => {
		const known = new Set(budgetCategories(tx).map((c) => c.id));
		if (entries.some((e) => !known.has(e.categoryId)))
			throw new ValidationError('Een van deze categorieën telt niet mee voor het budget.');
		const limits = limitsFor(tx, month);
		let set = 0;
		let skipped = 0;
		for (const e of entries) {
			if ((limits.get(e.categoryId) ?? 0) > 0) {
				skipped++;
				continue;
			}
			const before = tx
				.select()
				.from(budgets)
				.where(and(eq(budgets.month, month), eq(budgets.categoryId, e.categoryId)))
				.get();
			tx.insert(budgets)
				.values({ month, categoryId: e.categoryId, limitCents: e.limitCents })
				.onConflictDoUpdate({
					target: [budgets.month, budgets.categoryId],
					set: { limitCents: e.limitCents }
				})
				.run();
			recordChange(tx, 'startlimiet', 'budgets', `${month}:${e.categoryId}`, before ?? null, {
				limitCents: e.limitCents
			});
			set++;
		}
		return { set, skipped };
	});
}
