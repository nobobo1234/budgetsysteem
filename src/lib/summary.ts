// Maandsamenvatting (spec: Vragen en samenvattingen met AI → Maandsamenvatting): pure regels,
// zonder database of model. Code kiest wat opviel en controleert de zinnen; het model schrijft
// alleen de zinnen, met bedragen en namen als placeholder die code invult ("deterministic
// quoting"). Geen enkel getal dat je ziet komt uit het model.

import { formatMonth } from './dates.ts';
import { formatCents } from './money.ts';
import { normalize } from './text.ts';

// --- Feiten ----------------------------------------------------------------------------------

/** Opvallend is een verschil met het gemiddelde van drie maanden van minstens € 25 én 30%. */
export const MIN_DIFF_CENTS = 2500;
export const MIN_DIFF_SHARE = 0.3;
export const MAX_FACTS = 5;
/** De reeksen kijken zes maanden terug: genoeg voor het gemiddelde van zes en voor "sinds". */
export const HISTORY_MONTHS = 6;
/** Een stijging of daling "loopt" pas als hij minstens zo veel maanden achter elkaar doorzet. */
export const MIN_RUN = 2;

export const FACT_KINDS = ['categorie', 'tegenpartij', 'tag', 'productgroep'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/**
 * Bedragen van één categorie, tegenpartij, tag of productgroep per maand, de oudste eerst en
 * de samenvattingsmaand als laatste (`HISTORY_MONTHS + 1` waarden). Uitgaven positief, een
 * maand met per saldo geld terug negatief. `null` is een maand zonder gegevens (vóór de eerste
 * import, of bij productgroepen een maand zonder bonnen met regels): die telt niet mee in een
 * gemiddelde en onderbreekt een stijging.
 */
export interface Series {
	kind: FactKind;
	/** Al veilig gemaakt voor het model (zie `modelName`), of een vaste naam zoals "huisgenoot A" */
	name: string;
	values: (number | null)[];
}

export interface Fact {
	/** `f1` tot en met `f5`, op volgorde van het verschil in euro's */
	id: string;
	soort: FactKind;
	naam: string;
	nu: number;
	/** Gemiddelde van de drie maanden ervoor (alleen maanden met gegevens), op hele centen */
	gem3: number;
	/** Gemiddelde van de zes maanden ervoor, zelfde regel */
	gem6: number;
	/** `nu - gem3` zonder teken; de richting staat apart */
	verschil: number;
	richting: 'hoger' | 'lager';
	/** De maand (`YYYY-MM`) van waaruit een stijging of daling al minstens twee maanden doorzet */
	sinds: string | null;
	/** Niets in de zes maanden ervoor */
	nieuw: boolean;
}

const average = (values: readonly number[]) =>
	values.length === 0 ? 0 : Math.round(values.reduce((s, v) => s + v, 0) / values.length);

const KIND_ORDER = Object.fromEntries(FACT_KINDS.map((k, i) => [k, i])) as Record<FactKind, number>;

/** Of een verschil met het gemiddelde opvalt: minstens € 25 én 30% van dat gemiddelde. */
export function isNotable(nu: number, gem3: number): boolean {
	const diff = Math.abs(nu - gem3);
	return diff >= MIN_DIFF_CENTS && diff >= MIN_DIFF_SHARE * Math.abs(gem3);
}

/**
 * Waar de huidige stijging (of daling) begon: terug vanaf de samenvattingsmaand, zolang elke
 * maand hoger (of lager) is dan de maand ervoor, en de eerste stap zelf opvalt (zie `isNotable`).
 * Pas vanaf twee maanden achter elkaar; anders `null`. De maand die terugkomt is het beginpunt,
 * de laatste maand vóór de eerste stap.
 */
export function runStart(
	values: readonly (number | null)[],
	months: readonly string[],
	direction: 'hoger' | 'lager'
): string | null {
	let i = values.length - 1;
	while (i > 0) {
		const now = values[i];
		const before = values[i - 1];
		if (now === null || now === undefined || before === null || before === undefined) break;
		if (direction === 'hoger' ? now > before : now < before) i--;
		else break;
	}
	// Een kleine eerste stap is ruis, geen begin: het beginpunt schuift op tot de stap opvalt
	while (values.length - 1 - i >= MIN_RUN && !isNotable(values[i + 1]!, values[i]!)) i++;
	return values.length - 1 - i >= MIN_RUN ? months[i]! : null;
}

/**
 * Wat er deze maand opviel, hooguit vijf feiten, het grootste verschil in euro's eerst. Zonder
 * een eerdere maand met gegevens valt er niets te vergelijken en zijn er geen feiten.
 *
 * @param months de maanden van de reeksen, de oudste eerst (`HISTORY_MONTHS + 1`)
 */
export function pickFacts(series: readonly Series[], months: readonly string[]): Fact[] {
	const last = months.length - 1;
	const candidates: Omit<Fact, 'id'>[] = [];
	for (const s of series) {
		const nu = s.values[last];
		if (nu === null || nu === undefined) continue;
		const before = s.values.slice(0, last);
		const prev3 = before.slice(-3).filter((v): v is number => v !== null);
		if (prev3.length === 0) continue;
		const prev6 = before.filter((v): v is number => v !== null);
		const gem3 = average(prev3);
		if (!isNotable(nu, gem3)) continue;
		const richting = nu > gem3 ? 'hoger' : 'lager';
		candidates.push({
			soort: s.kind,
			naam: s.name,
			nu,
			gem3,
			gem6: average(prev6),
			verschil: Math.abs(nu - gem3),
			richting,
			sinds: runStart(s.values, months, richting),
			nieuw: nu !== 0 && prev6.every((v) => v === 0)
		});
	}
	return candidates
		.sort(
			(a, b) =>
				b.verschil - a.verschil ||
				KIND_ORDER[a.soort] - KIND_ORDER[b.soort] ||
				a.naam.localeCompare(b.naam, 'nl')
		)
		.slice(0, MAX_FACTS)
		.map((f, i) => ({ id: `f${i + 1}`, ...f }));
}

// --- Zinnen ----------------------------------------------------------------------------------

export const MAX_SENTENCES = 4;
export const MAX_SENTENCE_CHARS = 200;
/** Hooguit zo vaak per maand een nieuwe aanroep, automatisch of met "Opnieuw". */
export const MAX_CALLS_PER_MONTH = 5;

export const NOTHING_NOTABLE = 'Geen grote verschuivingen tegenover de maanden ervoor.';

/** Een stuk van een zin: gewone tekst, of een bedrag (in beeld met tabular figures). */
export interface Segment {
	text: string;
	num: boolean;
}

export interface Sentence {
	/** Ingevuld door code: de bedragen en namen komen uit de feiten */
	tekst: string;
	/** Dezelfde zin in stukken, zodat bedragen er als getal uitzien */
	delen: Segment[];
	/** De feiten waar de zin op steunt; een tik op de zin toont ze */
	feiten: string[];
}

/** Velden die als placeholder mogen, zoals `{f3.nu}`. */
export const PLACEHOLDER_FIELDS = ['naam', 'nu', 'gem3', 'gem6', 'verschil', 'sinds'] as const;
type Field = (typeof PLACEHOLDER_FIELDS)[number];

const PLACEHOLDER = /\{(f\d{1,2})\.([a-z0-9]+)\}/g;

/** Een bedrag zoals op de afsluiting: hele euro's vanaf € 100. Voor de cijfers achter een zin. */
export const amount = (cents: number) => formatCents(cents, { whole: Math.abs(cents) >= 10_000 });
/** In een zin altijd hele euro's: "€ 800, tegenover gemiddeld € 40". */
const wholeAmount = (cents: number) => formatCents(cents, { whole: true });

/** `maart`, of `november 2025` als de maand in een ander jaar valt dan de samenvatting. */
export function sinceText(since: string, month: string): string {
	const text = formatMonth(since);
	return since.slice(0, 4) === month.slice(0, 4) ? text.replace(/\s+\d{4}$/, '') : text;
}

function fieldValue(fact: Fact, field: Field, month: string): Segment | null {
	switch (field) {
		case 'naam':
			return { text: fact.naam, num: false };
		case 'nu':
		case 'gem3':
		case 'gem6':
		case 'verschil':
			return { text: wholeAmount(fact[field]), num: true };
		case 'sinds':
			return fact.sinds === null ? null : { text: sinceText(fact.sinds, month), num: false };
	}
}

/**
 * Vult de placeholders van een zin in. `null` bij een onbekend feit, veld of een `sinds` die er
 * niet is. De eerste letter wordt een hoofdletter, ook als de zin met een naam begint.
 */
function fill(
	template: string,
	byId: ReadonlyMap<string, Fact>,
	month: string
): { delen: Segment[]; used: Set<string> } | { failure: CheckFailure } {
	const delen: Segment[] = [];
	const used = new Set<string>();
	let at = 0;
	for (const m of template.matchAll(PLACEHOLDER)) {
		const fact = byId.get(m[1]!);
		if (!fact) return { failure: 'onbekend_feit' };
		const value = (PLACEHOLDER_FIELDS as readonly string[]).includes(m[2]!)
			? fieldValue(fact, m[2] as Field, month)
			: null;
		if (value === null) return { failure: 'placeholder' };
		if (m.index > at) delen.push({ text: template.slice(at, m.index), num: false });
		delen.push(value);
		used.add(fact.id);
		at = m.index + m[0].length;
	}
	if (at < template.length) delen.push({ text: template.slice(at), num: false });
	const first = delen[0];
	if (first && !first.num)
		delen[0] = { ...first, text: first.text.charAt(0).toUpperCase() + first.text.slice(1) };
	return { delen, used };
}

const joined = (delen: readonly Segment[]) => delen.map((d) => d.text).join('');

const MONTH_NAMES = [
	'januari',
	'februari',
	'maart',
	'april',
	'mei',
	'juni',
	'juli',
	'augustus',
	'september',
	'oktober',
	'november',
	'december'
];

export type CheckFailure =
	| 'aantal'
	| 'onbekend_feit'
	| 'placeholder'
	| 'cijfer'
	| 'naam'
	| 'maand'
	| 'domein'
	| 'teken'
	| 'te_lang';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Of `name` als los woord (of woordgroep) in `text` staat, zonder hoofdletters of accenten. */
function mentions(text: string, name: string): boolean {
	const n = normalize(name);
	if (n.length < 2) return false;
	return new RegExp(`(^|[^\\p{L}\\p{N}])${escape(n)}($|[^\\p{L}\\p{N}])`, 'u').test(
		normalize(text)
	);
}

/**
 * Controleert de zinnen van het model en vult de placeholders in (spec: Controle). Het schema is
 * al door Zod gegaan; hier: elk feit-id bestaat, geen cijfers buiten de placeholders, geen naam
 * letterlijk (ook geen verzonnen naam: alleen het eerste woord mag met een hoofdletter), geen
 * maandnaam, geen `/`, `@` of iets dat op een domein lijkt, en hooguit vier zinnen van hooguit
 * 200 tekens. Bij twijfel weigeren: één fout en de hele samenvatting valt terug op de vaste tekst.
 *
 * @param names alle namen die de app kent (categorieën, tegenpartijen, tags, personen); geen van
 *   die mag letterlijk in een zin staan
 */
export function checkSentences(
	raw: readonly { tekst: string; feiten: readonly string[] }[],
	facts: readonly Fact[],
	month: string,
	names: readonly string[] = []
): { ok: true; sentences: Sentence[] } | { ok: false; failure: CheckFailure } {
	if (raw.length === 0 || raw.length > MAX_SENTENCES) return { ok: false, failure: 'aantal' };
	const byId = new Map(facts.map((f) => [f.id, f]));
	const forbidden = [...new Set([...facts.map((f) => f.naam), ...names])];
	const sentences: Sentence[] = [];
	for (const r of raw) {
		const text = r.tekst.trim();
		if (text === '' || /[\n\r<>`]/.test(text)) return { ok: false, failure: 'teken' };
		if (r.feiten.length === 0 || r.feiten.some((id) => !byId.has(id)))
			return { ok: false, failure: 'onbekend_feit' };

		const result = fill(text, byId, month);
		if ('failure' in result) return { ok: false, failure: result.failure };
		const used = new Set([...r.feiten, ...result.used]);

		// Wat het model zelf schreef, zonder de placeholders
		const own = text.replace(PLACEHOLDER, ' ');
		if (/[{}]/.test(own)) return { ok: false, failure: 'placeholder' };
		if (/\p{N}/u.test(own)) return { ok: false, failure: 'cijfer' };
		if (/[/@\\]/.test(own) || /[\p{L}\p{N}-]\.[\p{L}]{2,}/u.test(own) || /www|https?/i.test(own))
			return { ok: false, failure: 'domein' };
		if (forbidden.some((name) => mentions(own, name))) return { ok: false, failure: 'naam' };
		// Een naam die de app niet kent: in een Nederlandse zin heeft alleen het eerste woord een
		// hoofdletter. Telt op de zin zoals het model hem schreef, met de placeholders als woord.
		const words = text.split(/\s+/).filter(Boolean);
		if (words.slice(1).some((w) => !/^\{f\d/.test(w) && /^[^\p{L}]*\p{Lu}/u.test(w)))
			return { ok: false, failure: 'naam' };
		if (MONTH_NAMES.some((m) => mentions(own, m))) return { ok: false, failure: 'maand' };
		const tekst = joined(result.delen);
		if (tekst.length > MAX_SENTENCE_CHARS) return { ok: false, failure: 'te_lang' };
		sentences.push({ tekst, delen: result.delen, feiten: [...used].sort(byFactOrder) });
	}
	return { ok: true, sentences };
}

// --- Weergave --------------------------------------------------------------------------------

/** `haiku`: zinnen van het model; `vast`: de vaste tekst; `leeg`: niets viel op. */
export const SUMMARY_SOURCES = ['haiku', 'vast', 'leeg'] as const;
export type SummarySource = (typeof SUMMARY_SOURCES)[number];

/** Waarom de vaste tekst er staat: de uitkomst van de aanroep, of waarom er geen aanroep was. */
export const SUMMARY_REASONS = [
	'controle',
	'weigering',
	'afgekapt',
	'ongeldig',
	'fout',
	'budget',
	'limiet',
	'geen_sleutel'
] as const;
export type SummaryReason = (typeof SUMMARY_REASONS)[number];

export interface SummarySentence extends Sentence {
	/** Je tikte "klopt niet" */
	wrong: boolean;
}

export interface MonthSummary {
	month: string;
	source: SummarySource;
	reason: SummaryReason | null;
	facts: Fact[];
	sentences: SummarySentence[];
	/** Hoeveel keer er deze maand nog opnieuw geschreven mag worden */
	callsLeft: number;
}

/** Waarom er een vaste tekst staat, in gewone taal. */
export function reasonText(reason: SummaryReason | null): string {
	switch (reason) {
		case 'budget':
			return 'Het AI-budget van deze maand is op; dit is de vaste tekst uit de cijfers.';
		case 'geen_sleutel':
			return 'Haiku is niet ingesteld; dit is de vaste tekst uit de cijfers.';
		case 'limiet':
			return 'Deze maand is al vijf keer geschreven; dit is de vaste tekst uit de cijfers.';
		default:
			return 'Wat Haiku schreef kwam niet door de controle; dit is de vaste tekst uit de cijfers.';
	}
}

const byFactOrder = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1));

/**
 * De vaste tekst: één zin per feit, als het model niet mag, niet kan of iets schreef dat de
 * controle niet haalt. Dezelfde getallen, zonder model.
 */
export function fixedSentences(facts: readonly Fact[], month: string): Sentence[] {
	const byId = new Map(facts.map((f) => [f.id, f]));
	return facts.map((f) => {
		const p = (field: Field) => `{${f.id}.${field}}`;
		const verb = f.nu < 0 ? 'kwam uit op' : 'kostte';
		let template: string;
		if (f.nieuw) template = `${p('naam')} is nieuw en ${verb} ${p('nu')}.`;
		else {
			const more = f.richting === 'hoger' ? 'meer' : 'minder';
			template = `${p('naam')} ${verb} ${p('nu')}, ${p('verschil')} ${more} dan gemiddeld (${p('gem3')})`;
			template += f.sinds
				? `; de ${f.richting === 'hoger' ? 'stijging' : 'daling'} loopt sinds ${p('sinds')}.`
				: '.';
		}
		const result = fill(template, byId, month);
		// Kan niet falen: het sjabloon gebruikt alleen dit feit en zijn eigen velden
		const delen = 'failure' in result ? [{ text: template, num: false }] : result.delen;
		return { tekst: joined(delen), delen, feiten: [f.id] };
	});
}
