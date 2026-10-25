// Vaste lasten: herkenning, ritme, reserveringen en signalen als pure functies, zonder database.
// Bedragen zijn hier positieve centen (wat er afgaat); het teken hoort bij de transactie.

import { daysInMonth, shiftMonth } from './dates.ts';
import { normalizeCounterparty, normalizeIban } from './text.ts';

export type Interval = 'maand' | 'kwartaal' | 'halfjaar' | 'jaar';
export type AmountKind = 'vast' | 'wisselend';

export const INTERVAL_MONTHS: Record<Interval, number> = {
	maand: 1,
	kwartaal: 3,
	halfjaar: 6,
	jaar: 12
};

export const INTERVAL_LABEL: Record<Interval, string> = {
	maand: 'Elke maand',
	kwartaal: 'Elk kwartaal',
	halfjaar: 'Elk halfjaar',
	jaar: 'Elk jaar'
};

/** Hoe vaak, in een zin: "Elke maand rond de 1e". */
export function rhythmText(interval: Interval, expectedDay: number): string {
	return `${INTERVAL_LABEL[interval]} rond de ${expectedDay}e`;
}

/** Het bedrag per keer bij het ritme: "per halfjaar". */
export const PER_INTERVAL: Record<Interval, string> = {
	maand: 'per maand',
	kwartaal: 'per kwartaal',
	halfjaar: 'per halfjaar',
	jaar: 'per jaar'
};

interface Rhythm {
	interval: Interval;
	minDays: number;
	maxDays: number;
	minCount: number;
}

// Spec: Vaste lasten, tabel Ritme. Volgorde is ook de volgorde waarin we proberen.
const RHYTHMS: Rhythm[] = [
	{ interval: 'maand', minDays: 28, maxDays: 35, minCount: 3 },
	{ interval: 'kwartaal', minDays: 85, maxDays: 95, minCount: 3 },
	{ interval: 'halfjaar', minDays: 150, maxDays: 215, minCount: 2 },
	{ interval: 'jaar', minDays: 350, maxDays: 380, minCount: 2 }
];

/** Dag van de maand wijkt hooguit zoveel dagen af van de mediaan (weekend schuift soms op). */
export const DAY_TOLERANCE = 4;
/** Bij drie halfjaarlijkse afschrijvingen liggen de eerste en de derde zo ver uit elkaar. */
const HALF_YEAR_PAIR = { min: 350, max: 380 };

// --- Datums ---------------------------------------------------------------------------------

function dayNumber(iso: string): number {
	const [y, m, d] = iso.split('-').map(Number);
	return Date.UTC(y!, m! - 1, d!) / 86_400_000;
}

export function daysBetween(from: string, to: string): number {
	return dayNumber(to) - dayNumber(from);
}

/** Aantal maanden van `from` naar `to` (`YYYY-MM`); negatief als `to` eerder is. */
export function monthsBetween(from: string, to: string): number {
	const [fy, fm] = from.split('-').map(Number);
	const [ty, tm] = to.split('-').map(Number);
	return (ty! - fy!) * 12 + (tm! - fm!);
}

/** Datum in `month` op `day`, of de laatste dag van de maand als die korter is. */
export function dateInMonth(month: string, day: number): string {
	const d = Math.min(Math.max(1, day), daysInMonth(month));
	return `${month}-${String(d).padStart(2, '0')}`;
}

/** Datum `months` maanden na `iso` (`YYYY-MM-DD`). */
function addMonths(iso: string, months: number): string {
	return dateInMonth(shiftMonth(iso.slice(0, 7), months), Number(iso.slice(8, 10)));
}

/**
 * De maand waar een afschrijving bij hoort. Een huur voor de 1e die door het weekend al op
 * de 30e afgaat, hoort bij de volgende maand.
 */
export function occurrenceMonth(iso: string, expectedDay: number): string {
	const month = iso.slice(0, 7);
	const diff = Number(iso.slice(8, 10)) - expectedDay;
	if (diff > 15) return shiftMonth(month, 1);
	if (diff < -15) return shiftMonth(month, -1);
	return month;
}

/**
 * Volgende afschrijving na `current`. Halfjaarlijks volgt de maand van een jaar eerder als
 * die bekend is (`previous`), zodat ongelijke semesters (september en februari) kloppen.
 */
export function nextOccurrence(opts: {
	interval: Interval;
	expectedDay: number;
	current: string;
	previous?: string | null;
}): string {
	const { interval, expectedDay, current, previous } = opts;
	const month = occurrenceMonth(current, expectedDay);
	if (interval === 'halfjaar' && previous) {
		const yearAfter = shiftMonth(occurrenceMonth(previous, expectedDay), 12);
		const gap = monthsBetween(month, yearAfter);
		if (gap >= 4 && gap <= 8) return dateInMonth(yearAfter, expectedDay);
	}
	return dateInMonth(shiftMonth(month, INTERVAL_MONTHS[interval]), expectedDay);
}

// --- Herkennen ------------------------------------------------------------------------------

export interface HistoryItem {
	date: string;
	/** Zoals in de transactie: negatief is uitgaand. Alleen uitgaande bedragen tellen. */
	amountCents: number;
	counterparty: string;
	counterIban: string | null;
	categoryId?: string | null;
	accountId?: string | null;
}

export interface Candidate {
	/** Genormaliseerde tegenpartij en IBAN; één vaste last per sleutel */
	key: string;
	counterparty: string;
	counterIban: string | null;
	interval: Interval;
	expectedDay: number;
	medianCents: number;
	minCents: number;
	maxCents: number;
	kind: AmountKind;
	/** Laatste afschrijving in de historie, en het bedrag daarvan */
	lastDate: string;
	lastCents: number;
	nextDate: string;
	count: number;
	categoryId: string | null;
	accountId: string | null;
}

export function recurringKey(counterparty: string, iban: string | null): string {
	return `${normalizeCounterparty(counterparty)}|${iban ? normalizeIban(iban) : ''}`;
}

/** Middelste waarde, bij een even aantal naar beneden afgerond gemiddelde van de twee middelste. */
export function median(values: number[]): number {
	const s = [...values].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid]! : Math.floor((s[mid - 1]! + s[mid]!) / 2);
}

/** Vast als de spreiding (max − min) binnen 5% van de mediaan blijft. */
export function amountKind(min: number, max: number, med: number): AmountKind {
	return (max - min) * 100 <= med * 5 ? 'vast' : 'wisselend';
}

/**
 * Mediane dag van de maand, rekening houdend met de jaarwisseling van de maand: 30, 1 en 2
 * liggen dicht bij elkaar. Geeft de dag (1–31) en de grootste afwijking.
 */
function medianDay(days: number[]): { day: number; deviation: number } {
	const options = [days, days.map((d) => (d >= 16 ? d - 31 : d))].map((ds) => {
		const m = median(ds);
		return { day: m, deviation: Math.max(...ds.map((d) => Math.abs(d - m))) };
	});
	const best = options[0]!.deviation <= options[1]!.deviation ? options[0]! : options[1]!;
	return { day: best.day < 1 ? best.day + 31 : best.day, deviation: best.deviation };
}

/**
 * Langste reeks die eindigt bij `end` met intervallen binnen het ritme. Een extra betaling
 * kort na een gewone (te kort interval) wordt overgeslagen; een te lang gat stopt de reeks.
 * Zijn er minstens zoveel overgeslagen betalingen als intervallen, dan is het geen los
 * extraatje maar een korter ritme (een kwartaal is dan geen halfjaar), en past dit ritme niet.
 */
function runEndingAt<T extends { date: string }>(items: T[], end: number, r: Rhythm): T[] {
	const run = [items[end]!];
	let skipped = 0;
	let pending = 0;
	for (let i = end - 1; i >= 0; i--) {
		const gap = daysBetween(items[i]!.date, run[0]!.date);
		if (gap < r.minDays) {
			pending++;
			continue;
		}
		if (gap > r.maxDays) break;
		run.unshift(items[i]!);
		skipped += pending;
		pending = 0;
	}
	return skipped >= run.length - 1 && skipped > 0 ? [] : run;
}

/** Halfjaarlijks: elke eerste en derde afschrijving liggen een jaar uit elkaar. */
function trimHalfYear<T extends { date: string }>(run: T[]): T[] {
	for (let i = run.length - 3; i >= 0; i--) {
		const gap = daysBetween(run[i]!.date, run[i + 2]!.date);
		if (gap < HALF_YEAR_PAIR.min || gap > HALF_YEAR_PAIR.max) return run.slice(i + 1);
	}
	return run;
}

/** Welke afschrijvingen meetellen, of `null` als het ritme niet past. */
function counted<T extends { date: string }>(run: T[], r: Rhythm, asOf: string): T[] | null {
	if (run.length === 0) return null;
	switch (r.interval) {
		case 'maand': {
			// 3 keer in de laatste 6 maanden
			const from = addMonths(asOf, -6);
			const recent = run.filter((t) => t.date >= from && t.date <= asOf);
			return recent.length >= r.minCount ? recent : null;
		}
		case 'kwartaal': {
			// Spec: 3 keer in de laatste 6 maanden. Letterlijk lukt dat alleen vlak na de derde
			// afschrijving (drie kwartalen beslaan al een halfjaar). Daarom: 3 keer achter elkaar,
			// de laatste hooguit 4 maanden geleden, naar analogie van halfjaarlijks (zie PR).
			const last = run.at(-1)!;
			if (run.length < r.minCount || last.date < addMonths(asOf, -4)) return null;
			return run;
		}
		case 'halfjaar': {
			const trimmed = trimHalfYear(run);
			const last = trimmed.at(-1)!;
			if (trimmed.length < r.minCount || last.date < addMonths(asOf, -7)) return null;
			return trimmed;
		}
		case 'jaar':
			return run.length >= r.minCount ? run : null;
	}
}

function mostCommon(values: (string | null | undefined)[]): string | null {
	const counts = new Map<string, number>();
	let best: string | null = null;
	for (const v of values) {
		if (!v) continue;
		const n = (counts.get(v) ?? 0) + 1;
		counts.set(v, n);
		if (best === null || n > counts.get(best)!) best = v;
	}
	return best;
}

function detectGroup(items: HistoryItem[], key: string, asOf: string): Candidate | null {
	if (items.length < 2) return null;
	for (const rhythm of RHYTHMS) {
		// Begin bij de laatste of de voorlaatste: de laatste kan een losse extra betaling zijn
		let best: HistoryItem[] | null = null;
		for (const end of [items.length - 1, items.length - 2]) {
			if (end < 0) continue;
			const c = counted(runEndingAt(items, end, rhythm), rhythm, asOf);
			if (c && (!best || c.length > best.length)) best = c;
		}
		if (!best) continue;

		const days = medianDay(best.map((t) => Number(t.date.slice(8, 10))));
		if (days.deviation > DAY_TOLERANCE) continue;

		const amounts = best.map((t) => -t.amountCents);
		const med = median(amounts);
		const min = Math.min(...amounts);
		const max = Math.max(...amounts);
		const last = best.at(-1)!;
		const previous = best.length >= 2 ? best.at(-2)!.date : null;

		// Volgende afschrijving; ligt die al voor deze maand, dan de eerste vanaf deze maand
		const thisMonth = asOf.slice(0, 7);
		let current = last.date;
		let prev = previous;
		let next = nextOccurrence({
			interval: rhythm.interval,
			expectedDay: days.day,
			current,
			previous: prev
		});
		while (next.slice(0, 7) < thisMonth) {
			prev = current;
			current = next;
			next = nextOccurrence({
				interval: rhythm.interval,
				expectedDay: days.day,
				current,
				previous: prev
			});
		}

		const latest = items.at(-1)!;
		return {
			key,
			counterparty: latest.counterparty,
			counterIban: mostCommon(items.map((t) => t.counterIban)),
			interval: rhythm.interval,
			expectedDay: days.day,
			medianCents: med,
			minCents: min,
			maxCents: max,
			kind: amountKind(min, max, med),
			lastDate: last.date,
			lastCents: -last.amountCents,
			nextDate: next,
			count: best.length,
			categoryId: mostCommon(best.map((t) => t.categoryId)),
			accountId: mostCommon(best.map((t) => t.accountId))
		};
	}
	return null;
}

/**
 * Herkent vaste lasten in de historie: groeperen op tegenpartij en tegen-IBAN, alleen
 * uitgaande bedragen, een vast ritme rond dezelfde dag. Boekingen zonder IBAN (eigen invoer)
 * horen bij de groep met dezelfde naam als daar precies één IBAN bij hoort.
 */
export function detectRecurring(history: HistoryItem[], asOf: string): Candidate[] {
	const byName = new Map<string, HistoryItem[]>();
	for (const t of history) {
		if (t.amountCents >= 0 || t.date > asOf) continue;
		const name = normalizeCounterparty(t.counterparty);
		if (!name) continue;
		const list = byName.get(name);
		if (list) list.push(t);
		else byName.set(name, [t]);
	}

	const out: Candidate[] = [];
	for (const [name, items] of byName) {
		const byIban = new Map<string, HistoryItem[]>();
		const ibans = new Set(
			items.flatMap((t) => (t.counterIban ? [normalizeIban(t.counterIban)] : []))
		);
		const only = ibans.size === 1 ? [...ibans][0]! : '';
		for (const t of items) {
			const iban = t.counterIban ? normalizeIban(t.counterIban) : only;
			const list = byIban.get(iban);
			if (list) list.push(t);
			else byIban.set(iban, [t]);
		}
		for (const [iban, group] of byIban) {
			group.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
			const c = detectGroup(group, `${name}|${iban}`, asOf);
			if (c) out.push(c);
		}
	}
	return out.sort((a, b) => b.medianCents - a.medianCents || a.key.localeCompare(b.key));
}

// --- Reserveren -----------------------------------------------------------------------------

/**
 * Reservering voor `month` (spec: Hoe de reservering werkt): (verwacht bedrag − al
 * gereserveerd) gedeeld door het aantal maanden tot en met de afschrijfmaand, naar beneden
 * afgerond op hele centen. De afschrijfmaand neemt zo vanzelf de rest. Na de afschrijfmaand,
 * of als er al genoeg opzij staat, niets.
 */
export function reservationFor(opts: {
	expectedCents: number;
	reservedCents: number;
	month: string;
	debitMonth: string;
}): number {
	const months = monthsBetween(opts.month, opts.debitMonth) + 1;
	if (months < 1) return 0;
	const rest = Math.max(0, opts.expectedCents - opts.reservedCents);
	return months === 1 ? rest : Math.floor(rest / months);
}

/**
 * Wat een afschrijving bovenop de reservering kost: de afschrijving gaat van de reservering
 * af, het verschil telt als uitgave. Duurder is positief (extra), goedkoper negatief (terug).
 */
export function settlementCents(debitCents: number, reservedCents: number): number {
	return debitCents - reservedCents;
}

/**
 * Wat een uitgesmeerde vaste last in een maand in de categorie kost: wat er opzij ging, min
 * wat er uit de reservering werd gehaald, plus de afschrijving zelf. In de afschrijfmaand gaat
 * de hele reservering naar de afschrijving, zodat alleen het verschil telt; bij stoppen valt
 * de reservering vrij.
 */
export function spreadMonthCents(opts: {
	reservedCents: number;
	drawnCents: number;
	debitCents: number;
}): number {
	return opts.reservedCents - opts.drawnCents + opts.debitCents;
}

/** Wordt deze vaste last standaard uitgesmeerd? Maandelijkse nooit. */
export function defaultSpread(interval: Interval): boolean {
	return interval !== 'maand';
}

// --- Overzicht en signalen ------------------------------------------------------------------

/** Kosten per jaar: het bedrag keer het aantal keer per jaar. */
export function perYearCents(cents: number, interval: Interval): number {
	return cents * (12 / INTERVAL_MONTHS[interval]);
}

/** Bedrag per maand: een halfjaarlijkse last voor een zesde, afgerond op hele centen. */
export function perMonthCents(cents: number, interval: Interval): number {
	return Math.round(cents / INTERVAL_MONTHS[interval]);
}

export type Signal = 'prijsverhoging' | 'uitschieter';

/**
 * Signaal bij een bevestigde afschrijving (spec: Signalen). Vast: 2% of meer duurder dan
 * vorige keer is een prijsverhoging. Wisselend: boven 120% van het hoogste bedrag tot nu toe
 * is een uitschieter.
 */
export function signalFor(opts: {
	kind: AmountKind;
	amountCents: number;
	previousCents: number | null;
	maxCents: number;
}): Signal | null {
	if (opts.kind === 'vast') {
		const prev = opts.previousCents;
		return prev !== null && prev > 0 && opts.amountCents * 100 >= prev * 102
			? 'prijsverhoging'
			: null;
	}
	return opts.amountCents * 100 > opts.maxCents * 120 ? 'uitschieter' : null;
}
