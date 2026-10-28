import { z } from 'zod';
import { PRODUCT_GROUPS } from '../productGroups.ts';

// Het vraagformaat van de semantische laag (spec: Vragen en samenvattingen met AI → Semantische
// laag): een vaste set maten, filters en groeperingen. Code vertaalt het naar queries met
// parameters en weigert wat het niet kent; er is geen vrije SQL, ook niet als terugval. Een
// losse module met een eigen schema, zodat het vraagveld en later een MCP-server dezelfde
// interface gebruiken en geen eigen rekenwijze krijgen.

/** Wat er gemeten kan worden. Alles telt zoals Budget en Analyses. */
export const MEASURES = [
	'uitgegeven',
	'inkomsten',
	'netto',
	'aantal',
	'gemiddeld_per_maand',
	'limiet',
	'resterend',
	'vaste_lasten',
	'te_krijgen'
] as const;
export type Measure = (typeof MEASURES)[number];

/** Waarop een antwoord in rijen uiteen kan vallen; `geen` is één getal. */
export const GROUPINGS = [
	'geen',
	'maand',
	'categorie',
	'tegenpartij',
	'tag',
	'productgroep'
] as const;
export type Grouping = (typeof GROUPINGS)[number];

export const SORTS = ['bedrag_aflopend', 'bedrag_oplopend', 'naam', 'periode'] as const;
export type Sort = (typeof SORTS)[number];

/**
 * Relatieve periodes komen als woord; code rekent ze om met de klok van Nederland (zie
 * `period.ts`) en zet de echte datums in de aannames.
 */
export const PERIOD_WORDS = [
	'deze_maand',
	'vorige_maand',
	'dit_jaar',
	'vorig_jaar',
	'laatste_3_maanden',
	'laatste_6_maanden',
	'laatste_12_maanden',
	'sinds_de_zomer',
	'alles'
] as const;
export type PeriodWord = (typeof PERIOD_WORDS)[number];

/** Hooguit zo veel rijen in een antwoord (spec: Filters en groepering). */
export const MAX_ROWS = 1000;
/** Hooguit zo lang is een vraag (spec: Vraagveld, Wat naar Haiku gaat). */
export const MAX_QUESTION_CHARS = 300;
export const MAX_NAME_CHARS = 60;
/** Een aanname, verduidelijking of reden van het model: kort en gewone tekst. */
export const MAX_MODEL_TEXT_CHARS = 200;
export const MAX_CHOICE_CHARS = 60;
export const MAX_CHOICES = 4;
export const MAX_ASSUMPTIONS = 4;

/** Een maand (`2026-03`) of een dag (`2026-03-14`). */
const MONTH_OR_DATE = /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/;

const name = z.string().trim().min(1).max(MAX_NAME_CHARS);

export const PeriodSchema = z.union([
	z.strictObject({ woord: z.enum(PERIOD_WORDS) }),
	z.strictObject({ van: z.string().regex(MONTH_OR_DATE), tot: z.string().regex(MONTH_OR_DATE) })
]);
export type Period = z.infer<typeof PeriodSchema>;

export const FiltersSchema = z.strictObject({
	/** Namen van eigen categorieën; elke naam moet bestaan */
	categorieen: z.array(name).max(20),
	groepen: z.array(name).max(10),
	/** Tekst; code zoekt hem op tussen de nette namen */
	tegenpartij: name.nullable(),
	tag: name.nullable(),
	/** Naam of alias van een rekening */
	rekening: name.nullable(),
	/** Alleen boodschappen met bonregels */
	productgroep: z.enum(PRODUCT_GROUPS).nullable()
});
export type Filters = z.infer<typeof FiltersSchema>;

export const NO_FILTERS: Filters = {
	categorieen: [],
	groepen: [],
	tegenpartij: null,
	tag: null,
	rekening: null,
	productgroep: null
};

/** De variant `vraag`: wat code uitrekent. */
export const QuerySchema = z.strictObject({
	maat: z.enum(MEASURES),
	periode: PeriodSchema,
	filters: FiltersSchema,
	groeperen: z.enum(GROUPINGS),
	sorteren: z.enum(SORTS),
	/** `null` is alle rijen, tot `MAX_ROWS` */
	limiet: z.number().int().min(1).max(MAX_ROWS).nullable(),
	/** Wat het model aannam, in gewone tekst; code zet er de echte datums en definities bij */
	aannames: z.array(z.string().trim().min(1).max(MAX_MODEL_TEXT_CHARS)).max(MAX_ASSUMPTIONS)
});
export type Query = z.infer<typeof QuerySchema>;

/**
 * Het vraagformaat (spec: Vraagformaat): een vraag, één vraag terug met hooguit vier keuzes, of
 * waarom het niet kan.
 */
export const QuestionFormatSchema = z.discriminatedUnion('soort', [
	QuerySchema.extend({ soort: z.literal('vraag') }),
	z.strictObject({
		soort: z.literal('verduidelijken'),
		vraag: z.string().trim().min(1).max(MAX_MODEL_TEXT_CHARS),
		keuzes: z.array(z.string().trim().min(1).max(MAX_CHOICE_CHARS)).min(2).max(MAX_CHOICES)
	}),
	z.strictObject({
		soort: z.literal('kan_niet'),
		reden: z.string().trim().min(1).max(MAX_MODEL_TEXT_CHARS)
	})
]);
export type QuestionFormat = z.infer<typeof QuestionFormatSchema>;
export type QuestionKind = QuestionFormat['soort'];
export const QUESTION_KINDS = ['vraag', 'verduidelijken', 'kan_niet'] as const;

// --- Gewone tekst van het model ------------------------------------------------------------------

export type TextFailure = 'leeg' | 'cijfer' | 'teken' | 'domein' | 'te_lang';

/**
 * Of een tekst van het model (een aanname, verduidelijking, keuze of reden) als gewone tekst in
 * beeld mag. Zoals bij de maandsamenvatting: geen cijfers (geen enkel getal dat je ziet komt uit
 * het model), geen opmaak, links, e-mailadressen of iets dat op een domein lijkt. `null` als het
 * mag, anders de soort fout. Bij twijfel weigeren.
 */
export function modelTextFailure(text: string, max = MAX_MODEL_TEXT_CHARS): TextFailure | null {
	const t = text.trim();
	if (t === '') return 'leeg';
	if (t.length > max) return 'te_lang';
	if (/\p{N}/u.test(t)) return 'cijfer';
	if (/[\n\r<>{}[\]`*_#|]/.test(t)) return 'teken';
	if (/[/@\\]/.test(t) || /[\p{L}\p{N}-]\.[\p{L}]{2,}/u.test(t) || /www|https?/i.test(t))
		return 'domein';
	return null;
}

// --- Weergave ------------------------------------------------------------------------------------

export const MEASURE_LABEL: Record<Measure, string> = {
	uitgegeven: 'uitgegeven',
	inkomsten: 'inkomsten',
	netto: 'netto (inkomsten min uitgaven)',
	aantal: 'aantal uitgaven',
	gemiddeld_per_maand: 'gemiddeld per maand',
	limiet: 'limiet',
	resterend: 'resterend van de limiet',
	vaste_lasten: 'vaste lasten',
	te_krijgen: 'nog te krijgen'
};

export const PERIOD_LABEL: Record<PeriodWord, string> = {
	deze_maand: 'deze maand',
	vorige_maand: 'vorige maand',
	dit_jaar: 'dit jaar',
	vorig_jaar: 'vorig jaar',
	laatste_3_maanden: 'de laatste drie maanden',
	laatste_6_maanden: 'de laatste zes maanden',
	laatste_12_maanden: 'de laatste twaalf maanden',
	sinds_de_zomer: 'sinds de zomer',
	alles: 'alles'
};

export const GROUPING_LABEL: Record<Grouping, string> = {
	geen: 'geen',
	maand: 'per maand',
	categorie: 'per categorie',
	tegenpartij: 'per tegenpartij',
	tag: 'per tag',
	productgroep: 'per productgroep'
};

export const SORT_LABEL: Record<Sort, string> = {
	bedrag_aflopend: 'hoogste bedrag eerst',
	bedrag_oplopend: 'laagste bedrag eerst',
	naam: 'op naam',
	periode: 'op tijd'
};

/** Drie voorbeeldvragen als chips onder het veld. */
export const EXAMPLE_QUESTIONS = [
	'Hoeveel gaf ik dit jaar uit aan uit eten?',
	'Waar gaf ik vorige maand het meest uit?',
	'Hoeveel heb ik deze maand nog vrij?'
] as const;
