import { normalize } from '../text.ts';
import { PRODUCT_GROUP_LABEL, type ProductGroup } from '../productGroups.ts';
import {
	MAX_CHOICES,
	MAX_NAME_CHARS,
	type Filters,
	type Grouping,
	type Measure,
	type Query
} from './format.ts';
import { resolvePeriod, type PeriodError, type ResolvedPeriod } from './period.ts';

// Van vraagformaat naar iets dat code kan uitrekenen (spec: Semantische laag, Vraagformaat): een
// categorie, groep, tag of rekening moet bestaan; een tegenpartij komt als tekst en code zoekt
// hem op tussen de nette namen (één treffer gebruiken, meer treffers verduidelijken, geen treffer
// weigeren); en elke maat kent alleen de filters en groeperingen die hij echt kan uitrekenen.
// Wat code niet kent, weigert het. Puur, zonder database: de server geeft de catalogus mee.

export interface CatalogCategory {
	id: string;
	name: string;
	group: string;
	/** Telt mee voor het budget: daar meten uitgaven, limieten en vaste lasten */
	countsForBudget: boolean;
	/** Inkomend geld hier telt als inkomen (niet: interne overboeking, terugbetaling, budget) */
	income: boolean;
}

export interface Catalog {
	categories: CatalogCategory[];
	tags: { id: string; name: string }[];
	accounts: { id: string; name: string; alias: string }[];
	/** Alle nette namen van tegenpartijen, uniek en ingekort zoals in een antwoord (`modelName`) */
	counterparties: string[];
}

/** Waarom code een vraag weigert; de tekst erbij staat in `answer.ts`. */
export type Refusal =
	| 'categorie'
	| 'groep'
	| 'tag'
	| 'rekening'
	| 'tegenpartij'
	| 'tegenpartij_vaag'
	| 'filter'
	| 'groepering'
	| 'productgroep'
	| 'een_maand'
	| 'geen_volle_maand'
	| `periode_${PeriodError}`;

export interface ResolvedQuery {
	query: Query;
	period: ResolvedPeriod;
	/** Categorieën uit de filters (categorieën en groepen samen); `null` is geen filter */
	categories: CatalogCategory[] | null;
	/** Hoe de filters op categorie heten in een zin: "Boodschappen", "de groep Dagelijks" */
	categoryLabels: string[];
	/** De nette naam van de gekozen tegenpartij */
	counterparty: string | null;
	tag: { id: string; name: string } | null;
	account: { id: string; name: string } | null;
	productGroup: ProductGroup | null;
	/** Wat code aannam bij het opzoeken, zoals "tegenpartij = Albert Heijn" */
	assumptions: string[];
}

export type Resolution =
	| { ok: true; resolved: ResolvedQuery }
	| { ok: false; kind: 'kan_niet'; refusal: Refusal; detail: string | null }
	| { ok: false; kind: 'verduidelijken'; refusal: 'tegenpartij'; choices: string[] };

type FilterKey = keyof Filters;

/** Welke filters een maat kan uitrekenen. */
export const MEASURE_FILTERS: Record<Measure, readonly FilterKey[]> = {
	uitgegeven: ['categorieen', 'groepen', 'tegenpartij', 'tag', 'rekening', 'productgroep'],
	aantal: ['categorieen', 'groepen', 'tegenpartij', 'tag', 'rekening'],
	gemiddeld_per_maand: ['categorieen', 'groepen'],
	vaste_lasten: ['categorieen', 'groepen'],
	limiet: ['categorieen', 'groepen'],
	resterend: ['categorieen', 'groepen'],
	inkomsten: ['categorieen', 'tegenpartij', 'rekening'],
	netto: [],
	te_krijgen: []
};

/** Welke groeperingen een maat kan uitrekenen. */
export const MEASURE_GROUPINGS: Record<Measure, readonly Grouping[]> = {
	uitgegeven: ['geen', 'maand', 'categorie', 'tegenpartij', 'tag', 'productgroep'],
	aantal: ['geen', 'maand', 'categorie', 'tegenpartij'],
	gemiddeld_per_maand: ['geen', 'categorie'],
	vaste_lasten: ['geen', 'maand', 'categorie'],
	limiet: ['geen', 'maand', 'categorie'],
	resterend: ['geen', 'categorie'],
	inkomsten: ['geen', 'maand', 'categorie', 'tegenpartij'],
	netto: ['geen', 'maand'],
	te_krijgen: ['geen']
};

const used = (f: Filters): FilterKey[] =>
	(Object.keys(f) as FilterKey[]).filter((k) => {
		const v = f[k];
		return Array.isArray(v) ? v.length > 0 : v !== null;
	});

/**
 * Een eigen naam (categorie, groep, tag, rekening) zoals hij naar het model gaat: alleen letters,
 * cijfers, spaties en `&.'-`, hooguit 60 tekens. Anders dan bij tegenpartijen blijven woorden
 * staan: deze namen koos je zelf.
 */
export const ownName = (name: string) =>
	name
		.normalize('NFC')
		.replace(/[^\p{L}\p{N} &.'-]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_NAME_CHARS);

/** Een naam om te vergelijken: het model geeft de namen terug zoals het ze kreeg. */
const nameKey = (name: string) => normalize(ownName(name));

const refuse = (refusal: Refusal, detail: string | null = null): Resolution => ({
	ok: false,
	kind: 'kan_niet',
	refusal,
	detail
});

/**
 * Zoekt een tegenpartij op tussen de nette namen: eerst een gelijke naam, anders de namen waarin
 * de tekst aan het begin van een woord staat ("heijn" vindt "Albert Heijn").
 */
export function findCounterparties(text: string, names: readonly string[]): string[] {
	const q = normalize(text);
	if (q === '') return [];
	const exact = names.filter((n) => normalize(n) === q);
	if (exact.length > 0) return exact.slice(0, 1);
	return names
		.filter((n) => ` ${normalize(n)} `.includes(` ${q}`))
		.sort((a, b) => a.localeCompare(b, 'nl'));
}

/**
 * Controleert een vraag tegen de catalogus en rekent de periode om.
 *
 * @param choice bij een eerdere verduidelijking: welke tegenpartij uit de keuzes
 */
export function resolveQuery(
	query: Query,
	catalog: Catalog,
	today: string,
	opts: { earliest?: string; choice?: number } = {}
): Resolution {
	const { maat, filters, groeperen } = query;
	const assumptions: string[] = [];

	const extra = used(filters).find((k) => !MEASURE_FILTERS[maat].includes(k));
	if (extra) return refuse('filter', extra);
	if (!MEASURE_GROUPINGS[maat].includes(groeperen)) return refuse('groepering', groeperen);
	// Productgroepen bestaan alleen voor boodschappen met bonregels, zonder andere filters
	if (
		(filters.productgroep !== null || groeperen === 'productgroep') &&
		used(filters).some((k) => k !== 'productgroep')
	)
		return refuse('productgroep');
	// Een tag telt zoals op de pagina van de tag: per regel, zonder tegenpartij of rekening
	if (
		(filters.tag !== null || groeperen === 'tag') &&
		(filters.tegenpartij !== null || filters.rekening !== null || groeperen === 'tegenpartij')
	)
		return refuse('filter', 'tag');

	const byName = new Map(catalog.categories.map((c) => [nameKey(c.name), c]));
	let categories: CatalogCategory[] | null = null;
	const categoryLabels: string[] = [];
	if (filters.categorieen.length > 0 || filters.groepen.length > 0) {
		const picked = new Map<string, CatalogCategory>();
		for (const name of filters.categorieen) {
			const c = byName.get(nameKey(name));
			if (!c) return refuse('categorie', name);
			picked.set(c.id, c);
			categoryLabels.push(c.name);
		}
		for (const name of filters.groepen) {
			const list = catalog.categories.filter((c) => nameKey(c.group) === nameKey(name));
			if (list.length === 0) return refuse('groep', name);
			for (const c of list) picked.set(c.id, c);
			categoryLabels.push(`de groep ${list[0]!.group}`);
		}
		categories = [...picked.values()];
		// Inkomsten bestaan alleen in categorieën voor inkomen; uitgaven alleen in budgetcategorieën
		const fits = (c: CatalogCategory) => (maat === 'inkomsten' ? c.income : c.countsForBudget);
		const misfit = categories.find((c) => !fits(c));
		if (misfit) return refuse('categorie', misfit.name);
	}

	let tag: ResolvedQuery['tag'] = null;
	if (filters.tag !== null) {
		const t = catalog.tags.find((x) => nameKey(x.name) === nameKey(filters.tag!));
		if (!t) return refuse('tag', filters.tag);
		tag = t;
	}

	let account: ResolvedQuery['account'] = null;
	if (filters.rekening !== null) {
		const q = nameKey(filters.rekening);
		const a = catalog.accounts.find((x) => nameKey(x.name) === q || nameKey(x.alias) === q);
		if (!a) return refuse('rekening', filters.rekening);
		account = { id: a.id, name: a.name };
	}

	let counterparty: string | null = null;
	if (filters.tegenpartij !== null) {
		const hits = findCounterparties(filters.tegenpartij, catalog.counterparties);
		if (opts.choice !== undefined) {
			counterparty = hits[opts.choice] ?? null;
			if (!counterparty) return refuse('tegenpartij', filters.tegenpartij);
		} else if (hits.length === 0) return refuse('tegenpartij', filters.tegenpartij);
		else if (hits.length > MAX_CHOICES) return refuse('tegenpartij_vaag', filters.tegenpartij);
		else if (hits.length > 1)
			return { ok: false, kind: 'verduidelijken', refusal: 'tegenpartij', choices: hits };
		else counterparty = hits[0]!;
		// De tekst van het model zelf staat niet in beeld, alleen de naam die code vond
		assumptions.push(`tegenpartij = ${counterparty}`);
	}

	const period = resolvePeriod(query.periode, today, opts.earliest);
	if ('error' in period) return refuse(`periode_${period.error}`);
	if (maat === 'resterend' && period.months.length > 1) return refuse('een_maand');
	if (maat === 'gemiddeld_per_maand' && period.fullMonths.length === 0)
		return refuse('geen_volle_maand');

	const productGroup = filters.productgroep;
	if (productGroup) assumptions.push(`productgroep = ${PRODUCT_GROUP_LABEL[productGroup]}`);

	return {
		ok: true,
		resolved: {
			query,
			period,
			categories,
			categoryLabels,
			counterparty,
			tag,
			account,
			productGroup,
			assumptions
		}
	};
}
