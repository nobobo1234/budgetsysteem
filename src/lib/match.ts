import { daysBetween } from './owed.ts';
import { normalizeCounterparty } from './text.ts';

// Koppellijst (spec: Bonnetjes en koppelen). Generiek: dezelfde score koppelt een betaling aan
// een openstaande post, een retour aan een uitgave en een bon aan een transactie.
//
// | Signaal | Gewicht | Hoe |
// | Bedrag  | 50%     | exact = vol; tot 2% (van het kleinste bedrag) of €1 verschil, wat het ruimst is = gedeeltelijk |
// | Datum   | 30%     | 0 dagen = vol, aflopend tot 0 bij 5 dagen verschil |
// | Naam    | 20%     | genormaliseerde tegenpartij, fuzzy; een bekende IBAN telt als vol |

export const WEIGHTS = { amount: 0.5, date: 0.3, name: 0.2 } as const;
export const MAX_CANDIDATES = 5;
/** Voorselectie alleen als de bovenste duidelijk voorloopt */
export const PRESELECT_MIN = 0.9;
export const PRESELECT_LEAD = 0.3;
const DATE_DAYS = 5;

export interface MatchQuery {
	/** Positief bedrag in centen */
	amountCents: number;
	date: string;
	name: string;
	iban?: string | null;
}

export interface MatchTarget {
	id: string;
	amountCents: number;
	date: string;
	name: string;
	/** Bekende IBANs van deze tegenpartij of persoon */
	ibans?: readonly string[];
}

export interface MatchOptions {
	/**
	 * Hoe een lager bedrag dan het doel telt. `afwijking`: als elk ander verschil.
	 * `deels`: een deelbetaling, half naar verhouding. `vol`: telt niet als afwijking (retour).
	 */
	lower?: 'afwijking' | 'deels' | 'vol';
}

export type MatchLabel = 'waarschijnlijk' | 'mogelijk' | 'onwaarschijnlijk';

export interface Scored<T> {
	target: T;
	score: number;
	label: MatchLabel;
	parts: { amount: number; date: number; name: number };
}

export function amountScore(query: number, target: number, opts: MatchOptions = {}): number {
	const a = Math.abs(query);
	const b = Math.abs(target);
	if (a === b) return 1;
	if (a < b && opts.lower === 'vol') return 1;
	if (a < b && opts.lower === 'deels') return b === 0 ? 0 : 0.5 * (a / b);
	const tolerance = Math.max(100, Math.round(Math.min(a, b) * 0.02));
	const diff = Math.abs(a - b);
	if (diff > tolerance) return 0;
	// Binnen de marge (fooi): gedeeltelijk, van bijna vol tot de helft aan de rand
	return 0.9 - 0.4 * (diff / tolerance);
}

export function dateScore(a: string, b: string): number {
	const days = Math.abs(daysBetween(a, b));
	return Math.max(0, 1 - days / DATE_DAYS);
}

function bigrams(s: string): Map<string, number> {
	const out = new Map<string, number>();
	const t = s.replaceAll(' ', '');
	for (let i = 0; i < t.length - 1; i++) {
		const g = t.slice(i, i + 2);
		out.set(g, (out.get(g) ?? 0) + 1);
	}
	return out;
}

function dice(a: string, b: string): number {
	const ga = bigrams(a);
	const gb = bigrams(b);
	let total = 0;
	for (const n of ga.values()) total += n;
	for (const n of gb.values()) total += n;
	if (total === 0) return 0;
	let overlap = 0;
	for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
	return (2 * overlap) / total;
}

const initials = (s: string) =>
	s
		.split(' ')
		.filter((w) => w.length > 0)
		.map((w) => w[0])
		.join('');

/**
 * Fuzzy overeenkomst van twee namen, 0 tot 1. Gelijk na normaliseren is vol; een hele naam als
 * woord in de ander ("tikkie sanne" en "Sanne") of initialen ("AH 1234" en "Albert Heijn")
 * tellen zwaar; verder bigram-overlap.
 */
export function nameScore(a: string, b: string): number {
	const x = normalizeCounterparty(a).slice(0, 100);
	const y = normalizeCounterparty(b).slice(0, 100);
	if (!x || !y) return 0;
	if (x === y) return 1;
	const wx = x.split(' ');
	const wy = y.split(' ');
	const contains = (outer: string[], inner: string[]) => {
		for (let i = 0; i + inner.length <= outer.length; i++) {
			if (inner.every((w, j) => outer[i + j] === w)) return true;
		}
		return false;
	};
	if (contains(wx, wy) || contains(wy, wx)) return 0.9;
	// Eerste woord gelijk ("albert heijn utrecht" en "albert heijn")
	let best = wx[0] === wy[0] && wx[0]!.length >= 3 ? 0.75 : 0;
	const ix = initials(y);
	if (wx.length === 1 && wx[0]!.length >= 2 && wy.length >= 2 && ix === wx[0]) best = 0.8;
	const iy = initials(x);
	if (wy.length === 1 && wy[0]!.length >= 2 && wx.length >= 2 && iy === wy[0]) best = 0.8;
	return Math.max(best, dice(x, y));
}

export function scoreMatch(query: MatchQuery, target: MatchTarget, opts: MatchOptions = {}) {
	const amount = amountScore(query.amountCents, target.amountCents, opts);
	const date = dateScore(query.date, target.date);
	const iban = query.iban ? query.iban.replace(/\s+/g, '').toUpperCase() : null;
	const name = iban && target.ibans?.includes(iban) ? 1 : nameScore(query.name, target.name);
	const score = WEIGHTS.amount * amount + WEIGHTS.date * date + WEIGHTS.name * name;
	return { score: Math.round(score * 1000) / 1000, parts: { amount, date, name } };
}

export function labelFor(score: number): MatchLabel {
	if (score >= 0.7) return 'waarschijnlijk';
	if (score >= 0.4) return 'mogelijk';
	return 'onwaarschijnlijk';
}

/**
 * Kandidaten gesorteerd op score, hoogstens vijf, met label. De bovenste is alleen
 * voorgeselecteerd bij een score boven 0,9 en minstens 0,3 voorsprong op de tweede.
 * Bij gelijke score blijft de volgorde van de invoer staan (bijvoorbeeld oudste eerst).
 */
export function rankMatches<T extends MatchTarget>(
	query: MatchQuery,
	targets: readonly T[],
	opts: MatchOptions & { minScore?: number; limit?: number } = {}
): { candidates: Scored<T>[]; preselect: string | null } {
	const scored = targets
		.map((target, i) => ({ target, i, ...scoreMatch(query, target, opts) }))
		.filter((s) => s.score >= (opts.minScore ?? 0))
		.sort((a, b) => b.score - a.score || a.i - b.i)
		.slice(0, opts.limit ?? MAX_CANDIDATES)
		.map(({ target, score, parts }) => ({ target, score, parts, label: labelFor(score) }));
	const [first, second] = scored;
	const preselect =
		first &&
		first.score > PRESELECT_MIN &&
		(!second || first.score - second.score >= PRESELECT_LEAD)
			? first.target.id
			: null;
	return { candidates: scored, preselect };
}
