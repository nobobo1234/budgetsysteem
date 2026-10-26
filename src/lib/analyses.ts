// Analyses zonder AI (spec: Analyses): pure functies over geboekte delen, zonder database.
// Een "deel" is een transactie, of bij een verdeling één regel daarvan, in een categorie die
// meetelt voor het budget of zonder categorie. Uitgaven zijn positief, zoals op Budget.

import { daysInMonth, shiftMonth } from './dates.ts';
import { displayName, normalize } from './text.ts';

export interface Part {
	/** De transactie; bij een verdeling hebben meerdere delen hetzelfde ID */
	id: string;
	/** De boekdatum; een terugboeking telt op de datum van de boeking die hij verrekent */
	date: string;
	categoryId: string | null;
	counterparty: string;
	/** Uitgave positief, inkomend (een retour) negatief */
	cents: number;
	/** Een afschrijving van een vaste last: gekoppeld, of uit de historie met dezelfde sleutel */
	fixed: boolean;
}

/** Wat er in een maand per categorie opzij ging, min wat eruit gehaald is. */
export interface Reserved {
	month: string;
	categoryId: string | null;
	cents: number;
}

export interface Cell {
	month: string;
	categoryId: string | null;
	/** Uitgegeven, inclusief reserveringen; zoals op Budget nooit onder nul */
	spentCents: number;
	/** Het deel daarvan dat vaste lasten en reserveringen zijn */
	fixedCents: number;
}

const key = (month: string, categoryId: string | null) => `${month}|${categoryId ?? ''}`;

/**
 * Uitgaven per maand en categorie. Zoals op Budget telt een reservering als uitgave in haar
 * categorie, en is een categorie (of "zonder categorie") nooit negatief: een retour die groter
 * is dan de uitgaven geeft geen ruimte terug.
 */
export function cells(parts: readonly Part[], reserved: readonly Reserved[] = []): Cell[] {
	const out = new Map<string, Cell>();
	const at = (month: string, categoryId: string | null) => {
		const k = key(month, categoryId);
		let c = out.get(k);
		if (!c) out.set(k, (c = { month, categoryId, spentCents: 0, fixedCents: 0 }));
		return c;
	};
	for (const p of parts) {
		const c = at(p.date.slice(0, 7), p.categoryId);
		c.spentCents += p.cents;
		if (p.fixed) c.fixedCents += p.cents;
	}
	for (const r of reserved) {
		const c = at(r.month, r.categoryId);
		c.spentCents += r.cents;
		c.fixedCents += r.cents;
	}
	for (const c of out.values()) {
		c.spentCents = Math.max(0, c.spentCents);
		c.fixedCents = Math.min(c.spentCents, Math.max(0, c.fixedCents));
	}
	return [...out.values()];
}

/** De maanden van `from` tot en met `to` (`YYYY-MM`). */
export function monthsFrom(from: string, to: string): string[] {
	const out: string[] = [];
	for (let m = from; m <= to; m = shiftMonth(m, 1)) out.push(m);
	return out;
}

export interface MonthTotal {
	month: string;
	spentCents: number;
	fixedCents: number;
	/** Alles behalve vaste lasten en reserveringen: hier meet de verwachting het gemiddelde */
	variableCents: number;
}

/** Totaal per maand, ook voor maanden zonder uitgaven (dan nul). */
export function monthTotals(list: readonly Cell[], months: readonly string[]): MonthTotal[] {
	const by = Map.groupBy(list, (c) => c.month);
	return months.map((month) => {
		const cs = by.get(month) ?? [];
		const spentCents = cs.reduce((s, c) => s + c.spentCents, 0);
		const fixedCents = cs.reduce((s, c) => s + c.fixedCents, 0);
		return { month, spentCents, fixedCents, variableCents: spentCents - fixedCents };
	});
}

/** Per maand de uitgaven in één categorie (`null`: zonder categorie). */
export function categorySeries(
	list: readonly Cell[],
	months: readonly string[],
	categoryId: string | null
): number[] {
	const by = new Map(
		list.filter((c) => c.categoryId === categoryId).map((c) => [c.month, c.spentCents])
	);
	return months.map((m) => by.get(m) ?? 0);
}

/** Totaal per categorie over alle cellen, hoogste eerst; categorieën zonder uitgaven vallen weg. */
export function categoryTotals(
	list: readonly Cell[]
): { categoryId: string | null; cents: number }[] {
	const sums = new Map<string | null, number>();
	for (const c of list) sums.set(c.categoryId, (sums.get(c.categoryId) ?? 0) + c.spentCents);
	return [...sums]
		.filter(([, cents]) => cents > 0)
		.map(([categoryId, cents]) => ({ categoryId, cents }))
		.sort((a, b) => b.cents - a.cents);
}

export interface Counterparty {
	/** Nette naam, zoals in de lijsten ("Albert Heijn") */
	name: string;
	cents: number;
	/** Aantal transacties */
	count: number;
	/** Deel van alle uitgaven in de periode (0–1) */
	share: number;
}

/**
 * Topuitgaven per tegenpartij (spec: Analyses). Filialen van dezelfde winkel tellen samen,
 * via de nette naam; een retour verlaagt het totaal. Alleen wie per saldo geld kreeg.
 */
export function topCounterparties(parts: readonly Part[], limit = 5): Counterparty[] {
	const groups = new Map<string, { name: string; cents: number; ids: Set<string> }>();
	for (const p of parts) {
		const name = displayName(p.counterparty) || 'Zonder naam';
		const k = normalize(name);
		let g = groups.get(k);
		if (!g) groups.set(k, (g = { name, cents: 0, ids: new Set() }));
		g.cents += p.cents;
		if (p.cents > 0) g.ids.add(p.id);
	}
	const list = [...groups.values()].filter((g) => g.cents > 0);
	const total = list.reduce((s, g) => s + g.cents, 0);
	return list
		.sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name, 'nl'))
		.slice(0, limit)
		.map((g) => ({ name: g.name, cents: g.cents, count: g.ids.size, share: g.cents / total }));
}

/** Hoeveel maanden het gemiddelde van de variabele uitgaven terugkijkt. */
export const AVERAGE_MONTHS = 3;

/**
 * Gemiddelde variabele uitgaven per dag: over de laatste volledige maanden met uitgaven (hooguit
 * drie), of, zonder die historie, over deze maand tot en met vandaag. Naar beneden op hele centen.
 */
export function dailyVariable(
	previous: readonly MonthTotal[],
	current: { variableCents: number; day: number }
): number {
	const used = previous.filter((m) => m.spentCents > 0).slice(-AVERAGE_MONTHS);
	if (used.length > 0) {
		const cents = used.reduce((s, m) => s + Math.max(0, m.variableCents), 0);
		const days = used.reduce((s, m) => s + daysInMonth(m.month), 0);
		return Math.floor(cents / days);
	}
	return current.day > 0 ? Math.floor(Math.max(0, current.variableCents) / current.day) : 0;
}

export interface ForecastInput {
	/** Uitgegeven tot nu, inclusief de reserveringen van deze maand */
	spentCents: number;
	/**
	 * Verwachte vaste lasten die nog komen. Bij een uitgesmeerde last is dat alleen het verschil
	 * met wat opzij staat: de reservering telt al als uitgave, niet de afschrijving.
	 */
	plannedLeftCents: number;
	/** Gemiddelde variabele uitgaven per dag (`dailyVariable`) */
	dailyCents: number;
	/** Dag van de maand (1–31) */
	day: number;
	daysInMonth: number;
}

export interface Forecast {
	spentCents: number;
	plannedLeftCents: number;
	/** De dagen na vandaag keer het gemiddelde per dag */
	variableLeftCents: number;
	daysLeft: number;
	totalCents: number;
}

/**
 * Verwachting einde maand (spec: Analyses): uitgegeven + verwachte vaste lasten + je gemiddelde
 * variabele uitgaven per resterende dag. Vandaag telt als voorbij: wat je vandaag uitgeeft, staat
 * al in uitgegeven.
 */
export function monthForecast(input: ForecastInput): Forecast {
	const daysLeft = Math.max(0, input.daysInMonth - input.day);
	const plannedLeftCents = Math.max(0, input.plannedLeftCents);
	const variableLeftCents = Math.max(0, input.dailyCents) * daysLeft;
	return {
		spentCents: input.spentCents,
		plannedLeftCents,
		variableLeftCents,
		daysLeft,
		totalCents: input.spentCents + plannedLeftCents + variableLeftCents
	};
}

/**
 * Uitgegeven per dag, opgeteld (dag 1 tot en met `through`), voor de lijn op Analyses. De
 * reserveringen tellen vanaf de eerste. Inkomend geld zonder categorie (zoals salaris) telt niet:
 * dat is geen retour.
 */
export function cumulativeByDay(
	parts: readonly Part[],
	reservedCents: number,
	month: string,
	through: number
): number[] {
	const perDay = new Array<number>(daysInMonth(month)).fill(0);
	for (const p of parts) {
		if (p.date.slice(0, 7) !== month) continue;
		if (p.categoryId === null && p.cents < 0) continue;
		perDay[Number(p.date.slice(8, 10)) - 1]! += p.cents;
	}
	const out: number[] = [];
	let sum = reservedCents;
	for (let d = 0; d < Math.min(through, perDay.length); d++) out.push((sum += perDay[d]!));
	return out;
}

/** Deel (0–1) zonder te delen door nul. */
export const ratio = (part: number, total: number) => (total > 0 ? part / total : 0);

/** Een deel als hele procenten: "58%". */
export const percent = (value: number) => `${Math.round(value * 100)}%`;
