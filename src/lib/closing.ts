// Maandafsluiting (spec: Analyses → Maandafsluiting): pure regels, zonder database. Het moment
// van de melding, de open punten, de balk, de uitschieters, de vergelijking met de maanden
// ervoor, de voorstellen voor limieten en het verschil sinds afsluiten.

import { FIXED_GROUP } from './budget.ts';
import { addDays, formatMonth, shiftMonth } from './dates.ts';
import { formatCents } from './money.ts';

// --- Moment van de melding -------------------------------------------------------------------

/** De melding volgt de klok in Nederland, ook als de server in een andere tijdzone draait. */
export const TIME_ZONE = 'Europe/Amsterdam';
export const NOTIFY_HOUR = 9;
/** Op deze dag van de nieuwe maand komt de melding ook als er nog iets openstaat. */
export const LAST_WAIT_DAY = 5;

const partsFormat = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
	let f = partsFormat.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat('en-CA', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23'
		});
		partsFormat.set(timeZone, f);
	}
	return f;
}

/** Datum (`YYYY-MM-DD`) en tijd op de klok van `timeZone` op het moment `now`. */
export function zonedParts(now: Date, timeZone = TIME_ZONE) {
	const p = Object.fromEntries(
		formatter(timeZone)
			.formatToParts(now)
			.map((x) => [x.type, x.value])
	);
	return {
		date: `${p.year}-${p.month}-${p.day}`,
		hour: Number(p.hour),
		minute: Number(p.minute),
		second: Number(p.second)
	};
}

/** Het moment waarop het in `timeZone` op `date` precies `hour` uur is. */
export function zonedTime(date: string, hour: number, timeZone = TIME_ZONE): Date {
	const [y, m, d] = date.split('-').map(Number);
	const wanted = Date.UTC(y!, m! - 1, d!, hour);
	// Twee keer bijstellen: de tweede keer klopt ook als de klok tussendoor verzet is
	let at = wanted;
	for (let i = 0; i < 2; i++) {
		const p = zonedParts(new Date(at), timeZone);
		const [py, pm, pd] = p.date.split('-').map(Number);
		const shown = Date.UTC(py!, pm! - 1, pd!, p.hour, p.minute, p.second);
		at += wanted - shown;
	}
	return new Date(at);
}

/** Het eerstvolgende moment om 9:00 in Nederland, na `now`. */
export function nextNotifyAt(now: Date, timeZone = TIME_ZONE): Date {
	const today = zonedParts(now, timeZone).date;
	const at = zonedTime(today, NOTIFY_HOUR, timeZone);
	return at > now ? at : zonedTime(addDays(today, 1), NOTIFY_HOUR, timeZone);
}

/** De maand die op `now` klaarstaat om af te sluiten: de vorige maand in Nederland. */
export function closingMonth(now: Date, timeZone = TIME_ZONE): string {
	return shiftMonth(zonedParts(now, timeZone).date.slice(0, 7), -1);
}

export type NoticeKind = 'klaar' | 'open';

/**
 * Of de melding van de maandafsluiting nu uit mag (spec: Wanneer). Vanaf 9:00 op de eerste dag
 * dat de maand voorbij is en er niets meer openstaat; staat er op de 5e nog iets open, dan toch,
 * met het aantal. Ontdubbelen per maand en "al afgesloten" regelt de aanroeper.
 */
export function closingNotice(
	now: Date,
	openCount: number,
	timeZone = TIME_ZONE
): { month: string; kind: NoticeKind } | null {
	const { date, hour } = zonedParts(now, timeZone);
	if (hour < NOTIFY_HOUR) return null;
	const month = shiftMonth(date.slice(0, 7), -1);
	if (openCount === 0) return { month, kind: 'klaar' };
	if (Number(date.slice(8, 10)) >= LAST_WAIT_DAY) return { month, kind: 'open' };
	return null;
}

// --- Open punten -----------------------------------------------------------------------------

/**
 * Wat de cijfers van een maand nog onzeker maakt. `verwacht`: een verwachte post wacht op
 * bevestiging; de inbox-soorten komen uit de review-inbox; `saldocheck`: een rekening zonder
 * saldocheck na de laatste dag. `name` is een tegenpartij, winkel, persoon of rekening, nooit
 * een IBAN of omschrijving.
 */
export type OpenKind =
	'verwacht' | 'bon' | 'boeking' | 'aandeel' | 'tegoed' | 'herinnering' | 'saldocheck';

export interface OpenItem {
	kind: OpenKind;
	id: string;
	name: string;
	date: string | null;
	amountCents: number | null;
	href: string;
}

export interface OpenSources {
	/** Verwachte vaste lasten die op bevestiging wachten, met of zonder "gemist" */
	expected: {
		id: string;
		date: string;
		counterparty: string;
		amountCents: number;
		missed: boolean;
	}[];
	/** Alles uit de review-inbox, als platte lijst met een datum */
	inbox: (Omit<OpenItem, 'kind'> & { kind: Exclude<OpenKind, 'verwacht' | 'saldocheck'> })[];
	/** Rekeningen met de eerste dag dat ze in gebruik waren en de laatste saldocheck */
	accounts: { id: string; name: string; firstUse: string | null; lastCheck: string | null }[];
}

export const lastDayOf = (month: string) => addDays(`${shiftMonth(month, 1)}-01`, -1);

const inMonth = (date: string | null, month: string) => date !== null && date.startsWith(month);

/** De open punten van `month`: alleen wat uit die maand komt, verwachte posten eerst. */
export function openItemsFor(month: string, sources: OpenSources): OpenItem[] {
	const last = lastDayOf(month);
	const expected = sources.expected
		.filter((e) => inMonth(e.date, month))
		.map((e): OpenItem => ({
			kind: 'verwacht',
			id: e.id,
			name: e.counterparty,
			date: e.date,
			amountCents: e.amountCents,
			// Gemist staat in de review-inbox, anders op het startscherm bij Te bevestigen
			href: e.missed ? '/te-controleren' : '/'
		}));
	const seen = new Set(expected.map((e) => e.id));
	const inbox = sources.inbox.filter((i) => inMonth(i.date, month) && !seen.has(i.id));
	const balance = sources.accounts
		.filter((a) => a.firstUse !== null && a.firstUse <= last)
		.filter((a) => a.lastCheck === null || a.lastCheck < last)
		.map((a): OpenItem => ({
			kind: 'saldocheck',
			id: a.id,
			name: a.name,
			date: null,
			amountCents: null,
			href: '/saldocheck'
		}));
	const byDate = (a: OpenItem, b: OpenItem) => (a.date ?? '').localeCompare(b.date ?? '');
	return [...expected.sort(byDate), ...inbox.sort(byDate), ...balance];
}

// --- Inhoud ----------------------------------------------------------------------------------

export interface ClosingLine {
	categoryId: string;
	name: string;
	group: string;
	limitCents: number;
	/** Uitgegeven, inclusief reserveringen, zoals op Budget */
	spentCents: number;
}

export interface ClosingSplit {
	fixedCents: number;
	reservedCents: number;
	dailyCents: number;
	/** Wat er van de limieten over bleef; nul als je erboven zat */
	freeCents: number;
}

/**
 * De maand als één balk, zoals op Budget, maar met de reserveringen apart: vaste lasten,
 * reserveringen, dagelijks en wat over bleef. Een afschrijving die uit een reservering komt
 * telt niet nog eens als vaste last; die maand telt alleen wat er opzij ging.
 */
export function closingSplit(
	lines: readonly (Pick<ClosingLine, 'group' | 'spentCents'> & { plannedSpentCents: number })[],
	/** Opzij gezet in de maand (bruto, zonder wat eruit gehaald is) */
	reservedCents: number,
	uncategorizedCents: number,
	freeCents: number
): ClosingSplit {
	let planned = 0;
	let dailyCents = Math.max(0, uncategorizedCents);
	for (const l of lines) {
		if (l.group === FIXED_GROUP) planned += Math.max(0, l.spentCents);
		else {
			planned += Math.max(0, l.plannedSpentCents);
			dailyCents += Math.max(0, l.spentCents - l.plannedSpentCents);
		}
	}
	return {
		fixedCents: Math.max(0, planned - reservedCents),
		reservedCents,
		dailyCents,
		freeCents: Math.max(0, freeCents)
	};
}

export interface Extreme extends ClosingLine {
	/** Hoeveel over de limiet (bij `over`) of hoeveel over (bij `left`) */
	diffCents: number;
}

/** De drie categorieën die het meest over hun limiet gingen en de drie met het meeste over. */
export function extremes(lines: readonly ClosingLine[], count = 3) {
	const withLimit = lines.filter((l) => l.limitCents > 0);
	const over = withLimit
		.filter((l) => l.spentCents > l.limitCents)
		.map((l): Extreme => ({ ...l, diffCents: l.spentCents - l.limitCents }))
		.sort((a, b) => b.diffCents - a.diffCents)
		.slice(0, count);
	const left = withLimit
		.filter((l) => l.spentCents < l.limitCents)
		.map((l): Extreme => ({ ...l, diffCents: l.limitCents - l.spentCents }))
		.sort((a, b) => b.diffCents - a.diffCents)
		.slice(0, count);
	return { over, left };
}

export interface MonthSpending {
	totalCents: number;
	byCategory: Record<string, number>;
}

export interface Comparison {
	totalCents: number;
	/** Gemiddelde van de maanden ervoor, op hele centen */
	averageCents: number;
	/** Hoeveel maanden ervoor er waren (1 tot 3) */
	months: number;
	riser: { categoryId: string; diffCents: number } | null;
	faller: { categoryId: string; diffCents: number } | null;
}

/**
 * Vergelijking met het gemiddelde van de maanden ervoor (hooguit drie, alleen maanden met data):
 * het totaal, en per categorie de grootste stijger en daler. Zonder eerdere maanden `null`.
 */
export function compareMonths(
	current: MonthSpending,
	previous: readonly MonthSpending[]
): Comparison | null {
	if (previous.length === 0) return null;
	const n = previous.length;
	const average = (values: number[]) => Math.round(values.reduce((s, v) => s + v, 0) / n);
	const ids = new Set([
		...Object.keys(current.byCategory),
		...previous.flatMap((p) => Object.keys(p.byCategory))
	]);
	let riser: Comparison['riser'] = null;
	let faller: Comparison['faller'] = null;
	for (const id of [...ids].sort()) {
		const diffCents =
			(current.byCategory[id] ?? 0) - average(previous.map((p) => p.byCategory[id] ?? 0));
		if (diffCents > 0 && (!riser || diffCents > riser.diffCents))
			riser = { categoryId: id, diffCents };
		if (diffCents < 0 && (!faller || diffCents < faller.diffCents))
			faller = { categoryId: id, diffCents };
	}
	return {
		totalCents: current.totalCents,
		averageCents: average(previous.map((p) => p.totalCents)),
		months: n,
		riser,
		faller
	};
}

// --- Volgende maand --------------------------------------------------------------------------

/** Onder dit deel van de limiet, drie maanden achter elkaar, krijgt een categorie een voorstel. */
export const UNDER_SHARE = 0.7;

export interface LimitHistory {
	categoryId: string;
	name: string;
	group: string;
	/** De limiet die nu voor de nieuwe maand staat */
	currentLimitCents: number;
	/** De afgesloten maand en de twee ervoor, de nieuwste eerst */
	months: { limitCents: number; spentCents: number }[];
}

export interface LimitProposal {
	categoryId: string;
	name: string;
	group: string;
	fromCents: number;
	toCents: number;
	reason: 'over' | 'onder';
}

/**
 * Voorstellen voor de limieten van de nieuwe maand (spec: Volgende maand): een categorie die
 * drie maanden achter elkaar over de limiet ging, of drie maanden onder 70% bleef, krijgt het
 * gemiddelde van die drie maanden, afgerond op hele euro's. Staat dat al als limiet, of komt het
 * op nul uit, dan geen voorstel.
 */
export function limitProposals(history: readonly LimitHistory[]): LimitProposal[] {
	return history.flatMap((h): LimitProposal[] => {
		if (h.months.length < 3) return [];
		const months = h.months.slice(0, 3);
		if (months.some((m) => m.limitCents <= 0)) return [];
		const over = months.every((m) => m.spentCents > m.limitCents);
		const under = months.every((m) => m.spentCents < m.limitCents * UNDER_SHARE);
		if (!over && !under) return [];
		const sum = months.reduce((s, m) => s + Math.max(0, m.spentCents), 0);
		const toCents = Math.round(sum / 300) * 100;
		if (toCents <= 0 || toCents === h.currentLimitCents) return [];
		return [
			{
				categoryId: h.categoryId,
				name: h.name,
				group: h.group,
				fromCents: h.currentLimitCents,
				toCents,
				reason: over ? 'over' : 'onder'
			}
		];
	});
}

// --- Uitkomst en momentopname ----------------------------------------------------------------

export interface Outcome {
	/** `over`: je hield geld over; `tekort`: over je budget; `zonder`: geen limieten */
	kind: 'over' | 'tekort' | 'zonder';
	cents: number;
}

export function outcomeOf(freeCents: number, totalLimitCents: number, spentCents: number): Outcome {
	if (totalLimitCents <= 0) return { kind: 'zonder', cents: Math.max(0, spentCents) };
	return freeCents >= 0
		? { kind: 'over', cents: freeCents }
		: { kind: 'tekort', cents: -freeCents };
}

/** De zin onder de kop in woorden, met het bedrag apart voor het oplopende getal. */
export function outcomeWords(outcome: Outcome): { before: string; after: string } {
	if (outcome.kind === 'over') return { before: 'Je hield', after: 'over.' };
	if (outcome.kind === 'tekort') return { before: 'Je ging', after: 'over je budget.' };
	return { before: 'Je gaf', after: 'uit, zonder limieten.' };
}

export function outcomeSentence(outcome: Outcome): string {
	const { before, after } = outcomeWords(outcome);
	return `${before} ${formatCents(outcome.cents, { whole: true })} ${after}`;
}

/** `September`: de maand zonder jaar, met een hoofdletter. */
export function monthName(month: string): string {
	const text = formatMonth(month).replace(/\s+\d{4}$/, '');
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Wat er bij het afsluiten wordt vastgelegd: totalen, geen IBANs of omschrijvingen. */
export interface ClosingSnapshot {
	version: 1;
	outcome: Outcome;
	totalLimitCents: number;
	totalSpentCents: number;
	freeCents: number;
	split: ClosingSplit;
	categories: ClosingLine[];
	comparison: Comparison | null;
	/** Wat er aan het eind van de maand nog te krijgen was */
	owedCents: number;
	/** Opzij gezet voor reserveringen, per vaste last */
	reservations: { recurringId: string; counterparty: string; amountCents: number }[];
}

export interface Change {
	/** Totaal uitgegeven nu min bij het afsluiten; positief is meer uitgegeven */
	totalCents: number;
	categories: { categoryId: string; name: string; diffCents: number }[];
}

/** Wat er sinds het afsluiten in de maand veranderd is, tegenover de momentopname. */
export function changedSince(
	snapshot: Pick<ClosingSnapshot, 'totalSpentCents' | 'categories'>,
	current: Pick<ClosingSnapshot, 'totalSpentCents' | 'categories'>
): Change {
	const before = new Map(snapshot.categories.map((c) => [c.categoryId, c]));
	const now = new Map(current.categories.map((c) => [c.categoryId, c]));
	const categories = [...new Set([...before.keys(), ...now.keys()])]
		.map((id) => ({
			categoryId: id,
			name: (now.get(id) ?? before.get(id))!.name,
			diffCents: (now.get(id)?.spentCents ?? 0) - (before.get(id)?.spentCents ?? 0)
		}))
		.filter((c) => c.diffCents !== 0)
		.sort((a, b) => Math.abs(b.diffCents) - Math.abs(a.diffCents));
	return { totalCents: current.totalSpentCents - snapshot.totalSpentCents, categories };
}
