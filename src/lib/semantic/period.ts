import { TIME_ZONE, zonedParts } from '../closing.ts';
import { daysInMonth, fromIsoDate, isIsoDate, shiftMonth } from '../dates.ts';
import { PERIOD_LABEL, type Period, type PeriodWord } from './format.ts';

// Relatieve periodes in code (spec: Semantische laag): "dit jaar", "vorige maand" en "sinds de
// zomer" komen als woord uit het model; code rekent ze om met de tijdzone Europe/Amsterdam en zet
// de echte datums in de aannames. Een periode loopt nooit verder dan vandaag: wat nog moet komen,
// is er niet (verwachte posten tellen pas na bevestiging).

/** Vandaag in Nederland (`YYYY-MM-DD`), ook als de server in een andere tijdzone draait. */
export const todayIn = (now: Date, timeZone = TIME_ZONE) => zonedParts(now, timeZone).date;

/** De zomer begint op 1 juni (meteorologisch). */
const SUMMER_START = '06-01';

export interface ResolvedPeriod {
	/** Eerste dag (`YYYY-MM-DD`) */
	from: string;
	/** Laatste dag, nooit na vandaag */
	to: string;
	/** De maanden die de periode raakt, de oudste eerst */
	months: string[];
	/** De maanden die helemaal in de periode vallen en voorbij zijn */
	fullMonths: string[];
	/** "1 januari tot en met 21 oktober 2026" */
	range: string;
	/** "dit jaar = 1 januari tot en met 21 oktober 2026", of alleen de datums bij een eigen periode */
	assumption: string;
}

export type PeriodError = 'datum' | 'volgorde' | 'toekomst';

const lastDay = (month: string) => `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;

const dayMonth = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'long' });
const dayMonthYear = new Intl.DateTimeFormat('nl-NL', {
	day: 'numeric',
	month: 'long',
	year: 'numeric'
});

/** "1 januari tot en met 21 oktober 2026", of "14 maart 2026" voor één dag. */
export function formatRange(from: string, to: string): string {
	const end = dayMonthYear.format(fromIsoDate(to));
	if (from === to) return end;
	const start = (from.slice(0, 4) === to.slice(0, 4) ? dayMonth : dayMonthYear).format(
		fromIsoDate(from)
	);
	return `${start} tot en met ${end}`;
}

function monthsBetween(from: string, to: string): string[] {
	const out: string[] = [];
	for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = shiftMonth(m, 1)) out.push(m);
	return out;
}

/** Datums van een woord, vóór het afkappen op vandaag. */
function wordRange(word: PeriodWord, today: string, earliest: string): [string, string] {
	const month = today.slice(0, 7);
	const year = today.slice(0, 4);
	switch (word) {
		case 'deze_maand':
			return [`${month}-01`, today];
		case 'vorige_maand': {
			const prev = shiftMonth(month, -1);
			return [`${prev}-01`, lastDay(prev)];
		}
		case 'dit_jaar':
			return [`${year}-01-01`, today];
		case 'vorig_jaar':
			return [`${Number(year) - 1}-01-01`, `${Number(year) - 1}-12-31`];
		case 'laatste_3_maanden':
		case 'laatste_6_maanden':
		case 'laatste_12_maanden': {
			// Volle maanden vóór deze maand, zoals de gemiddelden op Analyses
			const n = Number(word.split('_')[1]);
			return [`${shiftMonth(month, -n)}-01`, lastDay(shiftMonth(month, -1))];
		}
		case 'sinds_de_zomer': {
			const start = `${year}-${SUMMER_START}`;
			return [today >= start ? start : `${Number(year) - 1}-${SUMMER_START}`, today];
		}
		case 'alles':
			return [earliest < today ? earliest : today, today];
	}
}

/**
 * Rekent een periode om naar datums. Een maand als `van` begint op de eerste, een maand als
 * `tot` eindigt op de laatste dag. Een periode die na vandaag doorloopt, stopt vandaag; een
 * periode die helemaal in de toekomst ligt, is een fout.
 *
 * @param today vandaag in Nederland (zie `todayIn`)
 * @param earliest de eerste dag met gegevens, voor `alles`
 */
export function resolvePeriod(
	period: Period,
	today: string,
	earliest = today
): ResolvedPeriod | { error: PeriodError } {
	let from: string;
	let to: string;
	if ('woord' in period) [from, to] = wordRange(period.woord, today, earliest);
	else {
		from = period.van.length === 7 ? `${period.van}-01` : period.van;
		to = period.tot.length === 7 ? lastDay(period.tot) : period.tot;
		if (!isIsoDate(from) || !isIsoDate(to)) return { error: 'datum' };
		if (from > to) return { error: 'volgorde' };
	}
	if (from > today) return { error: 'toekomst' };
	if (to > today) to = today;

	const months = monthsBetween(from, to);
	const current = today.slice(0, 7);
	const fullMonths = months.filter((m) => m < current && from <= `${m}-01` && to >= lastDay(m));
	const range = formatRange(from, to);
	const assumption =
		'woord' in period ? `${PERIOD_LABEL[period.woord]} = ${range}` : `periode = ${range}`;
	return { from, to, months, fullMonths, range, assumption };
}
