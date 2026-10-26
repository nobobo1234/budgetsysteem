import { and, asc, eq, gte, inArray, isNull, lte, min, or, sql } from 'drizzle-orm';
import {
	AVERAGE_MONTHS,
	categorySeries,
	categoryTotals,
	cells,
	cumulativeByDay,
	dailyVariable,
	monthForecast,
	monthTotals,
	monthsFrom,
	ratio,
	topCounterparties,
	type Cell,
	type Part,
	type Reserved
} from '../analyses.ts';
import { daysInMonth, shiftMonth } from '../dates.ts';
import { bookedParts, monthOverview } from './budgets.ts';
import type { DB } from './db/index.ts';
import { categories, recurring, reservations, transactions } from './db/schema.ts';
import { chargesFor, plannedByCategory, recurringOverview, reserveStatuses } from './recurring.ts';

// De vaste analyses (spec: Analyses → Zonder AI): alles via SQL op de eigen server en de pure
// functies in analyses.ts. Alleen categorieën die meetellen voor het budget, en wat zonder
// categorie is, net als op Budget; interne overboekingen, sparen en inkomen tellen niet.

export const NO_CATEGORY = 'Zonder categorie';

interface Category {
	id: string;
	name: string;
	group: string;
}

function budgetCategories(db: DB): Category[] {
	return db
		.select({ id: categories.id, name: categories.name, group: categories.group })
		.from(categories)
		.where(and(eq(categories.archived, false), eq(categories.countsForBudget, true)))
		.orderBy(asc(categories.sortOrder), asc(categories.name))
		.all();
}

/**
 * Geboekte delen tussen twee datums in budgetcategorieën of zonder categorie, met per deel of
 * het een afschrijving van een vaste last is: gekoppeld, of uit de historie met dezelfde sleutel
 * (zoals op de pagina van een vaste last), zodat ook maanden van voor de herkenning kloppen.
 */
export function spendingParts(db: DB, from: string, to: string): Part[] {
	const rows = db.all<{
		id: string;
		date: string;
		category_id: string | null;
		counterparty: string;
		recurring_id: string | null;
		amount: number;
	}>(sql`
		${bookedParts(from, to)}
		SELECT p.id, p.date, p.category_id, p.counterparty, p.recurring_id, p.amount
		FROM parts p
		LEFT JOIN categories c ON c.id = p.category_id
		WHERE p.category_id IS NULL OR (c.counts_for_budget = 1 AND c.archived = 0)
	`);
	const items = db
		.select({ id: recurring.id, matchKey: recurring.matchKey })
		.from(recurring)
		.where(inArray(recurring.status, ['actief', 'gestopt']))
		.all();
	const fixed = new Set(
		[...chargesFor(db, items, from, to).values()].flat().map((charge) => charge.id)
	);
	return rows.map((r) => ({
		id: r.id,
		date: r.date,
		categoryId: r.category_id,
		counterparty: r.counterparty,
		cents: -r.amount,
		fixed: r.recurring_id !== null || fixed.has(r.id)
	}));
}

/** Reserveringen per maand en categorie (opzij min eruit gehaald), van `from` tot en met `to`. */
export function reservedByMonth(db: DB, from: string, to: string): Reserved[] {
	return db
		.select({
			month: reservations.month,
			categoryId: reservations.categoryId,
			cents: sql<number>`SUM(${reservations.amountCents} - ${reservations.drawnCents})`
		})
		.from(reservations)
		.leftJoin(categories, eq(categories.id, reservations.categoryId))
		.where(
			and(
				gte(reservations.month, from),
				lte(reservations.month, to),
				or(
					isNull(reservations.categoryId),
					and(eq(categories.countsForBudget, true), eq(categories.archived, false))
				)
			)
		)
		.groupBy(reservations.month, reservations.categoryId)
		.all();
}

/** Dag van de maand voor `today`: 0 voor een maand die nog moet komen, het eind voor een oude. */
function dayOf(month: string, today: string): number {
	const current = today.slice(0, 7);
	if (month === current) return Number(today.slice(8, 10));
	return month < current ? daysInMonth(month) : 0;
}

/** Een categorie met naam en groep; zonder categorie heeft geen groep. */
function named(cats: Map<string, Category>, categoryId: string | null) {
	const c = categoryId ? cats.get(categoryId) : undefined;
	return { categoryId, name: c?.name ?? NO_CATEGORY, group: c?.group ?? null };
}

/**
 * Maandoverzicht: limiet tegenover uitgegeven per categorie (reserveringen apart), de vaste
 * lasten als deel van je uitgaven, topuitgaven per tegenpartij, de lijn van uitgegeven per dag en
 * voor de huidige maand de verwachting voor het einde.
 */
export function monthAnalysis(db: DB, month: string, today: string) {
	const overview = monthOverview(db, month, today);
	const planned = plannedByCategory(db, month);
	const first = shiftMonth(month, -AVERAGE_MONTHS);
	const parts = spendingParts(db, `${first}-01`, `${month}-31`);
	const reserved = reservedByMonth(db, first, month);
	const totals = monthTotals(cells(parts, reserved), monthsFrom(first, month));
	const total = totals.at(-1)!;
	const monthParts = parts.filter((p) => p.date.startsWith(month));
	const reservedCents = reserved.filter((r) => r.month === month).reduce((s, r) => s + r.cents, 0);

	const day = dayOf(month, today);
	const days = daysInMonth(month);
	const budgetIds = new Set<string | null>([null, ...overview.lines.map((l) => l.categoryId)]);
	const plannedLeftCents = [...planned]
		.filter(([id]) => budgetIds.has(id))
		.reduce((s, [, p]) => s + Math.max(0, p.plannedCents - p.plannedSpentCents), 0);
	const isCurrent = month === today.slice(0, 7);

	const lines = overview.lines
		.filter((l) => l.limitCents > 0 || l.spentCents !== 0)
		.map((l) => {
			const r = planned.get(l.categoryId)?.reservedCents ?? 0;
			return {
				categoryId: l.categoryId,
				name: l.name,
				group: l.group,
				limitCents: l.limitCents,
				// Reserveringen apart: wat er echt uitgegeven is, en wat opzij ging
				spentCents: Math.max(0, l.spentCents - r),
				reservedCents: r,
				pace: l.pace
			};
		});

	return {
		month,
		day,
		daysInMonth: days,
		isCurrent,
		totalLimitCents: overview.totalLimitCents,
		spentCents: total.spentCents,
		fixedCents: total.fixedCents,
		plannedLeftCents,
		reservedCents,
		uncategorizedCents: overview.uncategorizedCents,
		lines,
		reserves: reserveStatuses(db, month).filter((r) => r.reservedCents !== 0),
		fixedPerMonthCents: recurringOverview(db, today).totalPerMonthCents,
		top: topCounterparties(monthParts, 5),
		cumulative: cumulativeByDay(monthParts, reservedCents, month, day),
		forecast: isCurrent
			? monthForecast({
					spentCents: total.spentCents,
					plannedLeftCents,
					dailyCents: dailyVariable(totals.slice(0, -1), {
						variableCents: total.variableCents,
						day
					}),
					day,
					daysInMonth: days
				})
			: null,
		/** Is er vóór deze maand iets geboekt: dan heeft "vorige" zin */
		hasEarlier: earliestMonth(db, today) < month
	};
}

/** De eerste maand met een transactie, of de huidige als er nog niets is. */
export function earliestMonth(db: DB, today: string): string {
	const row = db
		.select({ first: min(transactions.date) })
		.from(transactions)
		.get();
	return (row?.first ?? today).slice(0, 7);
}

/**
 * Gemiddelde over de volledige maanden vanaf de eerste met uitgaven; een lopende maand aan het
 * eind (`running`) telt niet mee.
 */
function averageOver(values: readonly number[], spent: readonly number[], running = true): number {
	const start = spent.findIndex((v) => v > 0);
	const used = start < 0 ? [] : values.slice(start, running ? -1 : undefined);
	return used.length > 0 ? Math.round(used.reduce((s, v) => s + v, 0) / used.length) : 0;
}

/** Trend over 12 maanden: totaal met het deel vaste lasten, en per categorie. */
export function trendAnalysis(db: DB, today: string, count = 12) {
	const to = today.slice(0, 7);
	const from = shiftMonth(to, -(count - 1));
	const months = monthsFrom(from, to);
	const all: Cell[] = cells(
		spendingParts(db, `${from}-01`, `${to}-31`),
		reservedByMonth(db, from, to)
	);
	const totals = monthTotals(all, months);
	const spent = totals.map((t) => t.spentCents);
	const start = spent.findIndex((v) => v > 0);
	const complete = start < 0 ? [] : totals.slice(start, -1);
	const cats = new Map(budgetCategories(db).map((c) => [c.id, c]));
	return {
		months,
		totals,
		averageCents: averageOver(spent, spent),
		fixedShare: ratio(
			complete.reduce((s, t) => s + t.fixedCents, 0),
			complete.reduce((s, t) => s + t.spentCents, 0)
		),
		categories: categoryTotals(all).map(({ categoryId, cents }) => {
			const values = categorySeries(all, months, categoryId);
			return {
				...named(cats, categoryId),
				totalCents: cents,
				values,
				averageCents: averageOver(values, spent)
			};
		})
	};
}

/** Jaaroverzicht: per maand, per categorie, de grootste tegenpartijen en het jaar ervoor. */
export function yearAnalysis(db: DB, year: number, today: string) {
	const current = today.slice(0, 7);
	const last = String(year) === current.slice(0, 4) ? current : `${year}-12`;
	const months = monthsFrom(`${year}-01`, last);
	const prevLast = `${year - 1}${last.slice(4)}`;
	const parts = spendingParts(db, `${year - 1}-01-01`, `${last}-31`);
	const reserved = reservedByMonth(db, `${year - 1}-01`, last);
	const inYear = (date: string) => date.startsWith(String(year));
	const thisYear = cells(
		parts.filter((p) => inYear(p.date)),
		reserved.filter((r) => inYear(r.month))
	);
	const previous = monthTotals(
		cells(
			parts.filter((p) => !inYear(p.date) && p.date.slice(0, 7) <= prevLast),
			reserved.filter((r) => !inYear(r.month) && r.month <= prevLast)
		),
		monthsFrom(`${year - 1}-01`, prevLast)
	);
	const totals = monthTotals(thisYear, months);
	const spentCents = totals.reduce((s, t) => s + t.spentCents, 0);
	const fixedCents = totals.reduce((s, t) => s + t.fixedCents, 0);
	const previousCents = previous.reduce((s, t) => s + t.spentCents, 0);
	const cats = new Map(budgetCategories(db).map((c) => [c.id, c]));
	const first = earliestMonth(db, today);
	return {
		year,
		months,
		totals,
		spentCents,
		fixedCents,
		averageCents: averageOver(
			totals.map((t) => t.spentCents),
			totals.map((t) => t.spentCents),
			last === current
		),
		/** Dezelfde maanden een jaar eerder, of null zonder uitgaven toen */
		previousCents: previousCents > 0 ? previousCents : null,
		categories: categoryTotals(thisYear).map(({ categoryId, cents }) => ({
			...named(cats, categoryId),
			cents,
			share: ratio(cents, spentCents)
		})),
		top: topCounterparties(
			parts.filter((p) => inYear(p.date)),
			10
		),
		hasEarlier: Number(first.slice(0, 4)) < year,
		hasLater: year < Number(current.slice(0, 4))
	};
}
