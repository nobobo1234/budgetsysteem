import { z } from 'zod';
import { addDays, isIsoDate } from '../../dates.ts';
import { centsToInput, parseAmount, parseSignedAmount } from '../../money.ts';
import { PRODUCT_GROUPS, type ProductGroup } from '../../productGroups.ts';
import {
	LINE_TOLERANCE_CENTS,
	type CheckedList,
	type CheckedReceipt,
	type FieldStatus
} from './checks.ts';
import type { Variant } from './images.ts';
import type { ReadFailure, ReadUsage } from './reader.ts';
import { MAX_LIST_ITEMS, PAYMENT_METHODS, type ImageKind } from './schema.ts';

// Haiku-eval (spec: Testplan voordat het live gaat): per variant en per veld hoe vaak Haiku het
// goed heeft, en vooral hoe vaak "zeker" toch fout was. Een screenshot met transacties (een
// lijst) wordt per transactie gescoord: gevonden, goed of fout, en wat het model erbij verzon.
// Per bon ook of alle regels gevuld zijn en, als je de artikelen labelt, of de productgroep klopt
// (spec: Boodschappen per productgroep). Pure logica; het script in
// `scripts/bon-eval.ts` leest de bestanden en doet de aanroepen. De labels en bonnen staan
// buiten git: echte bonnen komen nooit in de repo.

/** Doel uit de spec: bij "zeker" minstens 98% goed op het totaal. */
export const TARGET_PRECISION = 0.98;

export const EVAL_FIELDS = ['winkel', 'datum', 'totaal', 'valuta', 'betaalwijze'] as const;
export type EvalField = (typeof EVAL_FIELDS)[number];

const fileName = z
	.string()
	.regex(
		/^[^/\\.][^/\\]{0,127}\.(?:jpe?g|png|webp)$/i,
		'alleen een bestandsnaam (jpg, png of webp)'
	);
const isoDate = z.string().refine(isIsoDate, 'datum als JJJJ-MM-DD');

/** Een artikel op de bon met zijn productgroep; kortingen, bonus en statiegeld label je niet. */
const LabelLineSchema = z.strictObject({
	/** Zoals je het typt: `2,49`. */
	bedrag: z
		.string()
		.refine((s) => (parseSignedAmount(s) ?? 0) !== 0, 'bedrag van het artikel, zoals 2,49'),
	groep: z.enum(PRODUCT_GROUPS),
	/** Voor jezelf; telt niet mee. */
	omschrijving: z.string().max(120).optional()
});
export type LabelLine = z.infer<typeof LabelLineSchema>;

export const LabelSchema = z.strictObject({
	/** Korte naam voor in het rapport; standaard het eerste bestand zonder extensie. */
	id: z
		.string()
		.regex(/^[\w.-]{1,64}$/)
		.optional(),
	/** Eén of meer foto's van dezelfde bon, van boven naar beneden. */
	bestanden: z.array(fileName).min(1).max(5),
	/** Winkelnaam, of een lijst namen die allemaal goed zijn ("AH", "Albert Heijn"). */
	winkel: z.union([z.string().min(1).max(100), z.array(z.string().min(1).max(100)).min(1)]),
	datum: isoDate,
	/** Zoals een mens het schrijft: `23,45` of `1.234,50`. */
	totaal: z.string().refine((s) => (parseAmount(s) ?? 0) > 0, 'positief bedrag, zoals 23,45'),
	valuta: z
		.string()
		.regex(/^[A-Z]{3}$/)
		.default('EUR'),
	betaalwijze: z.enum(PAYMENT_METHODS).optional(),
	/** Wanneer je de bon zou uploaden; standaard de dag na de aankoop. */
	ontvangen: isoDate.optional(),
	/** Vrije groep voor de uitsplitsing, zoals supermarkt, horeca, kreukel of screenshot. */
	soort: z.string().max(40).optional(),
	notitie: z.string().max(500).optional(),
	/** De artikelen met hun productgroep, van boven naar beneden; zonder telt alleen "gevuld". */
	regels: z.array(LabelLineSchema).min(1).max(150).optional()
});

const names = z.union([z.string().min(1).max(100), z.array(z.string().min(1).max(100)).min(1)]);

/** Een screenshot van een bankapp met meerdere transacties, van boven naar beneden. */
export const ListLabelSchema = z.strictObject({
	id: z
		.string()
		.regex(/^[\w.-]{1,64}$/)
		.optional(),
	bestanden: z.array(fileName).min(1).max(5),
	transacties: z
		.array(
			z.strictObject({
				datum: isoDate,
				/** Naam zoals in de app, of een lijst namen die allemaal goed zijn. */
				tegenpartij: names,
				/** Met teken zoals je het typt: `-12,50` voor een afschrijving, `250,00` voor geld dat binnenkwam. */
				bedrag: z
					.string()
					.refine(
						(s) => (parseSignedAmount(s) ?? 0) !== 0,
						'bedrag met teken, zoals -12,50 of 250,00'
					),
				valuta: z
					.string()
					.regex(/^[A-Z]{3}$/)
					.default('EUR')
			})
		)
		.min(1)
		.max(MAX_LIST_ITEMS),
	/** Wanneer je het screenshot zou uploaden; standaard de dag na de laatste transactie. */
	ontvangen: isoDate.optional(),
	soort: z.string().max(40).optional(),
	notitie: z.string().max(500).optional()
});

export const LabelFileSchema = z
	.strictObject({
		bonnen: z.array(LabelSchema).max(100).default([]),
		/** Screenshots met meerdere transacties (spec: Verwerking stap 6). */
		lijsten: z.array(ListLabelSchema).max(100).default([])
	})
	.refine((f) => f.bonnen.length + f.lijsten.length > 0, 'geen bonnen of lijsten');

export type Label = z.infer<typeof LabelSchema>;
export type ListLabel = z.infer<typeof ListLabelSchema>;

export function labelId(label: Label | ListLabel): string {
	return label.id ?? label.bestanden[0]!.replace(/\.[^.]+$/, '');
}

/** Het uploadmoment waartegen de datumcontroles gelden: midden op de dag, lokale tijd. */
export function uploadMoment(label: Label | ListLabel): Date {
	const last =
		'transacties' in label
			? label.transacties.map((t) => t.datum).reduce((a, b) => (b > a ? b : a))
			: label.datum;
	const iso = label.ontvangen ?? addDays(last, 1);
	const [y, m, d] = iso.split('-').map(Number);
	return new Date(y!, m! - 1, d!, 12);
}

/** Winkelnaam vergelijken zonder hoofdletters, accenten, leestekens en rechtsvorm. */
export function normalizeStore(name: string): string {
	return name
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/\b(?:b\.?v\.?|n\.?v\.?)(?=\s|$)/g, ' ')
		.replace(/[^\p{L}\p{N}]+/gu, '');
}

export function storeMatches(label: Label['winkel'], value: string): boolean {
	const got = normalizeStore(value);
	if (got.length === 0) return false;
	return (Array.isArray(label) ? label : [label]).some((name) => {
		const want = normalizeStore(name);
		if (want === got) return true;
		// "Albert Heijn 1234" bevat "Albert Heijn"; korte namen alleen exact
		const [short, long] = want.length <= got.length ? [want, got] : [got, want];
		return short.length >= 4 && long.includes(short);
	});
}

export interface FieldResult {
	/** Er is een label voor dit veld (betaalwijze is optioneel). */
	labeled: boolean;
	/** Het model gaf een (geldige) waarde. */
	filled: boolean;
	correct: boolean;
	status: FieldStatus;
}

export const LIST_EVAL_FIELDS = ['datum', 'tegenpartij', 'bedrag', 'valuta'] as const;
export type ListEvalField = (typeof LIST_EVAL_FIELDS)[number];

/** Eén gelabelde transactie op een screenshot. */
export interface ItemResult {
	/** Het model las een transactie die hierbij past. */
	found: boolean;
	/** Alle vier velden goed. */
	correct: boolean;
	/** Uitkomst van de gelezen transactie; `null` als hij niet gevonden is. */
	outcome: FieldStatus | null;
	fields: Partial<Record<ListEvalField, FieldResult>>;
}

export interface ListScore {
	items: ItemResult[];
	/** Transacties die het model las maar die niet in het label staan (verzonnen of dubbel). */
	extra: number;
	/** Daarvan zeker: die zouden zonder twijfel klaarstaan om te boeken. */
	extraZeker: number;
}

/** De regels van één bon. */
export interface LineScore {
	/** Alle regels gelezen, en samen het gelabelde totaal (binnen €0,05). */
	complete: boolean;
	/** Alleen als de artikelen gelabeld zijn. */
	groups: GroupScore | null;
}

export interface GroupScore {
	/** Gelabelde artikelen, en hoeveel daarvan een gelezen artikel met hetzelfde bedrag hebben. */
	labeled: number;
	matched: number;
	/** Daarvan met de goede productgroep. */
	correct: number;
	/** Hetzelfde in centen: hoeveel geld in de goede groep valt. */
	labeledCents: number;
	correctCents: number;
}

export interface BonResult {
	id: string;
	variant: Variant;
	soort: string | null;
	/** Wat het label zegt: een bon of een screenshot met transacties. */
	kind: ImageKind;
	/** Wat het model zag; `null` als lezen mislukte. */
	beeld: ImageKind | null;
	/** Uitkomst van de hele bon of lijst, of de reden dat lezen mislukte. */
	outcome: FieldStatus | ReadFailure | 'fout';
	fields: Partial<Record<EvalField, FieldResult>>;
	/** Alleen bij een lijst-label. */
	list: ListScore | null;
	/** Alleen bij een bon-label. */
	lines: LineScore | null;
	usage: ReadUsage | null;
}

type EvalInput =
	| { ok: true; checked: CheckedReceipt; list?: CheckedList | null; usage: ReadUsage }
	| { ok: false; reason: ReadFailure | 'fout'; usage: ReadUsage | null };

/** Vergelijkt de gecontroleerde uitvoer met het label. */
export function scoreBon(label: Label, variant: Variant, result: EvalInput): BonResult {
	const base = {
		id: labelId(label),
		variant,
		soort: label.soort ?? null,
		kind: 'bon' as const,
		list: null
	};
	if (!result.ok)
		return {
			...base,
			beeld: null,
			outcome: result.reason,
			fields: {},
			lines: scoreLines(label, null),
			usage: result.usage
		};

	const c = result.checked;
	const field = (
		value: unknown,
		status: FieldStatus,
		correct: boolean,
		labeled = true
	): FieldResult => ({
		labeled,
		filled: value !== null,
		correct: value !== null && correct,
		status
	});

	return {
		...base,
		beeld: result.list ? 'lijst' : 'bon',
		// Als lijst gelezen boekt de app niets: de bonvelden zijn dan leeg en onzeker
		outcome: c.outcome,
		usage: result.usage,
		lines: scoreLines(label, c),
		fields: {
			winkel: field(
				c.store.value,
				c.store.status,
				c.store.value !== null && storeMatches(label.winkel, c.store.value)
			),
			datum: field(c.date.value, c.date.status, c.date.value === label.datum),
			totaal: field(
				c.totalCents.value,
				c.totalCents.status,
				c.totalCents.value === parseAmount(label.totaal)
			),
			valuta: field(c.currency.value, c.currency.status, c.currency.value === label.valuta),
			betaalwijze: field(
				c.paymentMethod.value,
				c.paymentMethod.status,
				c.paymentMethod.value === label.betaalwijze,
				label.betaalwijze !== undefined
			)
		}
	};
}

/**
 * De regels van een bon: gevuld als ze allemaal gelezen zijn en samen het echte totaal vormen.
 * Gelabelde artikelen worden op volgorde gekoppeld aan gelezen artikelen met hetzelfde bedrag;
 * een artikel zonder paar telt als niet gevonden (en dus niet goed).
 */
export function scoreLines(label: Label, checked: CheckedReceipt | null): LineScore {
	const total = parseAmount(label.totaal);
	const complete =
		checked !== null &&
		checked.lines.length > 0 &&
		checked.linesSumCents !== null &&
		total !== null &&
		Math.abs(checked.linesSumCents - total) <= LINE_TOLERANCE_CENTS;
	if (!label.regels) return { complete, groups: null };

	const read = (checked?.lines ?? []).filter((l) => l.kind === 'artikel');
	const used = new Set<number>();
	let last = -1;
	const groups: GroupScore = {
		labeled: 0,
		matched: 0,
		correct: 0,
		labeledCents: 0,
		correctCents: 0
	};
	for (const want of label.regels) {
		const cents = parseSignedAmount(want.bedrag)!;
		groups.labeled++;
		groups.labeledCents += Math.abs(cents);
		const same = (j: number) => !used.has(j) && read[j]!.cents === cents;
		// Eerst verder op de bon dan het vorige paar, anders het eerste vrije met dat bedrag
		let j = read.findIndex((_, k) => k > last && same(k));
		if (j === -1) j = read.findIndex((_, k) => same(k));
		if (j === -1) continue;
		used.add(j);
		last = j;
		groups.matched++;
		if (read[j]!.group === want.groep) {
			groups.correct++;
			groups.correctCents += Math.abs(cents);
		}
	}
	return { complete, groups };
}

/** Wat Haiku las als label-regels, om na te kijken en in `labels.json` te zetten. */
export function conceptLines(checked: CheckedReceipt): LabelLine[] {
	return checked.lines
		.filter((l) => l.kind === 'artikel')
		.map((l) => ({
			omschrijving: l.description,
			bedrag: `${l.cents < 0 ? '-' : ''}${centsToInput(l.cents)}`,
			groep: (l.group ?? 'overig') satisfies ProductGroup
		}));
}

/**
 * Vergelijkt een gelezen lijst met het label. Elke gelabelde transactie krijgt hooguit één
 * gelezen transactie: eerst de paren die het meest overeenkomen (bedrag weegt het zwaarst), en
 * alleen als het bedrag klopt of datum én naam kloppen. Wat overblijft is gemist of extra.
 */
export function scoreList(label: ListLabel, variant: Variant, result: EvalInput): BonResult {
	const base = {
		id: labelId(label),
		variant,
		soort: label.soort ?? null,
		kind: 'lijst' as const,
		lines: null
	};
	const missing = (): ItemResult => ({ found: false, correct: false, outcome: null, fields: {} });
	if (!result.ok)
		return {
			...base,
			beeld: null,
			outcome: result.reason,
			fields: {},
			list: { items: label.transacties.map(missing), extra: 0, extraZeker: 0 },
			usage: result.usage
		};
	const read = result.list?.items ?? [];

	const checks = label.transacties.map((t) =>
		read.map((r) => ({
			datum: r.date.value === t.datum,
			tegenpartij:
				r.counterparty.value !== null && storeMatches(t.tegenpartij, r.counterparty.value),
			bedrag: r.amountCents.value === parseSignedAmount(t.bedrag),
			valuta: r.currency.value === t.valuta
		}))
	);
	const pairs: { i: number; j: number; weight: number }[] = [];
	checks.forEach((row, i) =>
		row.forEach((c, j) => {
			const weight =
				(c.bedrag ? 4 : 0) + (c.datum ? 2 : 0) + (c.tegenpartij ? 2 : 0) + (c.valuta ? 1 : 0);
			if (weight >= 4) pairs.push({ i, j, weight });
		})
	);
	pairs.sort((a, b) => b.weight - a.weight || Math.abs(a.i - a.j) - Math.abs(b.i - b.j));
	const pairOf = new Map<number, number>();
	const usedRead = new Set<number>();
	for (const p of pairs) {
		if (pairOf.has(p.i) || usedRead.has(p.j)) continue;
		pairOf.set(p.i, p.j);
		usedRead.add(p.j);
	}

	const items = label.transacties.map((_, i): ItemResult => {
		const j = pairOf.get(i);
		if (j === undefined) return missing();
		const r = read[j]!;
		const c = checks[i]![j]!;
		const one = (value: unknown, status: FieldStatus, correct: boolean): FieldResult => ({
			labeled: true,
			filled: value !== null,
			correct: value !== null && correct,
			status
		});
		const fields = {
			datum: one(r.date.value, r.date.status, c.datum),
			tegenpartij: one(r.counterparty.value, r.counterparty.status, c.tegenpartij),
			bedrag: one(r.amountCents.value, r.amountCents.status, c.bedrag),
			valuta: one(r.currency.value, r.currency.status, c.valuta)
		};
		return {
			found: true,
			correct: LIST_EVAL_FIELDS.every((f) => fields[f].correct),
			outcome: r.outcome,
			fields
		};
	});
	const extras = read.filter((_, j) => !usedRead.has(j));
	return {
		...base,
		beeld: result.list ? 'lijst' : 'bon',
		outcome: result.list ? result.list.outcome : 'onzeker',
		fields: {},
		list: {
			items,
			extra: extras.length,
			extraZeker: extras.filter((r) => r.outcome === 'zeker').length
		},
		usage: result.usage
	};
}

export interface FieldStats {
	total: number;
	correct: number;
	filled: number;
	zeker: number;
	/** Het belangrijkste getal: "zeker" maar toch fout. */
	zekerWrong: number;
	controleren: number;
	onzeker: number;
}

export interface ListReport {
	/** Screenshots met een lijst-label. */
	lijsten: number;
	/** Lezen mislukt. */
	failed: number;
	/** Lijst-labels die het model als bon las (dan staat er niets klaar om te bevestigen). */
	readAsBon: number;
	/** Bon-labels die het model als lijst las (dan boekt de app niets vanzelf). */
	bonAsList: number;
	/** Gelabelde transacties in totaal, gevonden en helemaal goed. */
	transactions: number;
	found: number;
	correct: number;
	/** Uitkomst per gevonden transactie. */
	outcomes: Record<FieldStatus, number>;
	/** Het belangrijkste getal: een transactie "zeker" maar met een fout veld. */
	zekerWrong: number;
	/** Gelezen maar niet gelabeld: verzonnen of dubbel; en daarvan zeker. */
	extra: number;
	extraZeker: number;
	fields: Record<ListEvalField, FieldStats>;
	/** Fouten bij "zeker", per lijst en transactie (1 = bovenste), om zelf na te kijken. */
	zekerWrongIds: { id: string; item: number; field: ListEvalField }[];
}

export interface LinesReport {
	/** Bonnen waarvan alle regels gevuld zijn (samen het totaal), van alle bonnen. */
	complete: number;
	bonnen: number;
	/** Bonnen met gelabelde artikelen, en de optelling van hun scores. */
	labeledBonnen: number;
	groups: GroupScore;
	/** Bonnen met een artikel in de verkeerde groep of zonder paar, om zelf na te kijken. */
	wrongIds: { id: string; wrong: number }[];
}

export interface VariantReport {
	variant: Variant;
	bonnen: number;
	/** Lezen mislukt: weigering, afgekapt, ongeldige uitvoer of API-fout. */
	failed: number;
	outcomes: Record<FieldStatus, number>;
	/** Bonnen met uitkomst zeker waarvan winkel, datum, totaal of valuta toch fout was. */
	outcomeZekerWrong: number;
	fields: Record<EvalField, FieldStats>;
	inputTokens: number;
	outputTokens: number;
	costNanoUsd: number;
	durationMsP50: number;
	/** Fouten bij "zeker", per bon, om zelf na te kijken. */
	zekerWrongIds: { id: string; field: EvalField }[];
	/** Screenshots met transacties; `null` als er geen lijst-labels zijn. */
	lists: ListReport | null;
	/** Regels en productgroepen van de bonnen. */
	lines: LinesReport;
}

const emptyStats = (): FieldStats => ({
	total: 0,
	correct: 0,
	filled: 0,
	zeker: 0,
	zekerWrong: 0,
	controleren: 0,
	onzeker: 0
});

const OUTCOME_FIELDS: EvalField[] = ['winkel', 'datum', 'totaal', 'valuta'];

export function aggregate(variant: Variant, all: BonResult[]): VariantReport {
	const results = all.filter((r) => r.kind === 'bon');
	const listResults = all.filter((r) => r.kind === 'lijst');
	const fields = Object.fromEntries(EVAL_FIELDS.map((f) => [f, emptyStats()])) as Record<
		EvalField,
		FieldStats
	>;
	const outcomes: Record<FieldStatus, number> = { zeker: 0, controleren: 0, onzeker: 0 };
	const zekerWrongIds: VariantReport['zekerWrongIds'] = [];
	const durations: number[] = [];
	let failed = 0;
	let outcomeZekerWrong = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let costNanoUsd = 0;

	for (const r of all) {
		if (!r.usage) continue;
		inputTokens += r.usage.inputTokens;
		outputTokens += r.usage.outputTokens;
		costNanoUsd += r.usage.costNanoUsd;
		durations.push(r.usage.durationMs);
	}

	for (const r of results) {
		if (r.outcome !== 'zeker' && r.outcome !== 'controleren' && r.outcome !== 'onzeker') {
			failed++;
			// Een mislukte lezing telt mee als onzeker en niet gevuld: niets zou geboekt worden
			for (const f of EVAL_FIELDS) {
				if (f === 'betaalwijze') continue;
				fields[f].total++;
				fields[f].onzeker++;
			}
			continue;
		}
		outcomes[r.outcome]++;
		if (r.outcome === 'zeker' && OUTCOME_FIELDS.some((f) => !r.fields[f]?.correct)) {
			outcomeZekerWrong++;
		}
		for (const f of EVAL_FIELDS) {
			const res = r.fields[f];
			if (!res?.labeled) continue;
			const s = fields[f];
			s.total++;
			if (res.correct) s.correct++;
			if (res.filled) s.filled++;
			s[res.status]++;
			if (res.status === 'zeker' && !res.correct) {
				s.zekerWrong++;
				zekerWrongIds.push({ id: r.id, field: f });
			}
		}
	}

	return {
		variant,
		bonnen: results.length,
		failed,
		outcomes,
		outcomeZekerWrong,
		fields,
		inputTokens,
		outputTokens,
		costNanoUsd,
		durationMsP50: median(durations),
		zekerWrongIds,
		lists:
			listResults.length > 0
				? aggregateLists(listResults, results.filter((r) => r.beeld === 'lijst').length)
				: null,
		lines: aggregateLines(results)
	};
}

function aggregateLines(results: BonResult[]): LinesReport {
	const report: LinesReport = {
		complete: 0,
		bonnen: results.length,
		labeledBonnen: 0,
		groups: { labeled: 0, matched: 0, correct: 0, labeledCents: 0, correctCents: 0 },
		wrongIds: []
	};
	for (const r of results) {
		if (r.lines?.complete) report.complete++;
		const g = r.lines?.groups;
		if (!g) continue;
		report.labeledBonnen++;
		report.groups.labeled += g.labeled;
		report.groups.matched += g.matched;
		report.groups.correct += g.correct;
		report.groups.labeledCents += g.labeledCents;
		report.groups.correctCents += g.correctCents;
		if (g.correct < g.labeled) report.wrongIds.push({ id: r.id, wrong: g.labeled - g.correct });
	}
	return report;
}

function aggregateLists(results: BonResult[], bonAsList: number): ListReport {
	const fields = Object.fromEntries(LIST_EVAL_FIELDS.map((f) => [f, emptyStats()])) as Record<
		ListEvalField,
		FieldStats
	>;
	const report: ListReport = {
		lijsten: results.length,
		failed: 0,
		readAsBon: 0,
		bonAsList,
		transactions: 0,
		found: 0,
		correct: 0,
		outcomes: { zeker: 0, controleren: 0, onzeker: 0 },
		zekerWrong: 0,
		extra: 0,
		extraZeker: 0,
		fields,
		zekerWrongIds: []
	};
	for (const r of results) {
		if (r.beeld === null) report.failed++;
		else if (r.beeld === 'bon') report.readAsBon++;
		const list = r.list;
		if (!list) continue;
		report.extra += list.extra;
		report.extraZeker += list.extraZeker;
		list.items.forEach((item, index) => {
			report.transactions++;
			for (const f of LIST_EVAL_FIELDS) fields[f].total++;
			if (!item.found || item.outcome === null) {
				// Niet gevonden: niets om aan te vinken, dus onzeker en niet gevuld
				for (const f of LIST_EVAL_FIELDS) fields[f].onzeker++;
				return;
			}
			report.found++;
			if (item.correct) report.correct++;
			report.outcomes[item.outcome]++;
			if (item.outcome === 'zeker' && !item.correct) report.zekerWrong++;
			for (const f of LIST_EVAL_FIELDS) {
				const res = item.fields[f]!;
				const s = fields[f];
				if (res.correct) s.correct++;
				if (res.filled) s.filled++;
				s[res.status]++;
				if (res.status === 'zeker' && !res.correct) {
					s.zekerWrong++;
					report.zekerWrongIds.push({ id: r.id, item: index + 1, field: f });
				}
			}
		});
	}
	return report;
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Aandeel goed bij "zeker"; `null` als het model nergens zeker was. */
export function zekerPrecision(stats: FieldStats): number | null {
	return stats.zeker === 0 ? null : (stats.zeker - stats.zekerWrong) / stats.zeker;
}

function pct(part: number, whole: number): string {
	return whole === 0 ? '–' : `${((part / whole) * 100).toFixed(1)}%`;
}

function usd(nano: number): string {
	return `$${(nano / 1e9).toFixed(4)}`;
}

/** Leesbare samenvatting voor de terminal: alleen aantallen en ID's, geen bedragen of winkels. */
export function formatReport(reports: VariantReport[]): string {
	const lines: string[] = [];
	for (const r of reports) {
		lines.push(`\nVariant ${r.variant}: ${r.bonnen} bonnen, ${r.failed} mislukt`);
		lines.push(
			`  uitkomst: zeker ${r.outcomes.zeker}, controleren ${r.outcomes.controleren}, onzeker ${r.outcomes.onzeker}; zeker maar fout: ${r.outcomeZekerWrong}`
		);
		lines.push('  veld          goed     gevuld   zeker  zeker-goed  controleren  onzeker');
		for (const f of EVAL_FIELDS) {
			const s = r.fields[f];
			if (s.total === 0) continue;
			const precision = zekerPrecision(s);
			lines.push(
				`  ${f.padEnd(12)}  ${pct(s.correct, s.total).padStart(6)}   ${pct(s.filled, s.total).padStart(6)}   ${String(s.zeker).padStart(5)}  ${(precision === null ? '–' : `${(precision * 100).toFixed(1)}%`).padStart(10)}  ${String(s.controleren).padStart(11)}  ${String(s.onzeker).padStart(7)}`
			);
		}
		const total = zekerPrecision(r.fields.totaal);
		const verdict =
			total === null
				? 'geen enkel totaal zeker'
				: total >= TARGET_PRECISION
					? `doel gehaald (≥ ${TARGET_PRECISION * 100}%)`
					: `doel NIET gehaald (< ${TARGET_PRECISION * 100}%)`;
		lines.push(`  totaal bij zeker: ${verdict}`);
		lines.push(
			`  tokens: ${r.inputTokens} in, ${r.outputTokens} uit; kosten ${usd(r.costNanoUsd)}; mediane duur ${r.durationMsP50} ms`
		);
		if (r.zekerWrongIds.length > 0) {
			lines.push(
				`  zeker maar fout: ${r.zekerWrongIds.map((w) => `${w.id} (${w.field})`).join(', ')}`
			);
		}
		lines.push(...formatLines(r.lines));
		if (r.lists) lines.push(...formatLists(r.lists));
	}
	return lines.join('\n');
}

function formatLines(l: LinesReport): string[] {
	if (l.bonnen === 0) return [];
	const out = [
		`  regels: alle regels gevuld bij ${l.complete} van ${l.bonnen} bonnen (${pct(l.complete, l.bonnen)})`
	];
	if (l.labeledBonnen === 0) {
		out.push('  productgroep: geen artikelen gelabeld ("regels" in labels.json)');
		return out;
	}
	const g = l.groups;
	out.push(
		`  productgroep: ${g.labeled} artikelen gelabeld in ${l.labeledBonnen} bonnen, ${g.matched} gevonden, ${g.correct} goede groep (${pct(g.correct, g.labeled)}); geld in de goede groep: ${pct(g.correctCents, g.labeledCents)}`
	);
	if (l.wrongIds.length > 0) {
		out.push(
			`  groep fout of niet gevonden: ${l.wrongIds.map((w) => `${w.id} (${w.wrong})`).join(', ')}`
		);
	}
	return out;
}

function formatLists(l: ListReport): string[] {
	const lines = [
		`  Lijsten: ${l.lijsten} screenshots, ${l.failed} mislukt, ${l.readAsBon} als bon gelezen; ${l.bonAsList} bonnen als lijst gelezen`,
		`  transacties: ${l.transactions} gelabeld, ${l.found} gevonden, ${l.correct} helemaal goed (${pct(l.correct, l.transactions)}); extra gelezen: ${l.extra}, waarvan zeker ${l.extraZeker}`,
		`  uitkomst: zeker ${l.outcomes.zeker}, controleren ${l.outcomes.controleren}, onzeker ${l.outcomes.onzeker}; zeker maar fout: ${l.zekerWrong}`,
		'  veld          goed     gevuld   zeker  zeker-goed  controleren  onzeker'
	];
	for (const f of LIST_EVAL_FIELDS) {
		const s = l.fields[f];
		if (s.total === 0) continue;
		const precision = zekerPrecision(s);
		lines.push(
			`  ${f.padEnd(12)}  ${pct(s.correct, s.total).padStart(6)}   ${pct(s.filled, s.total).padStart(6)}   ${String(s.zeker).padStart(5)}  ${(precision === null ? '–' : `${(precision * 100).toFixed(1)}%`).padStart(10)}  ${String(s.controleren).padStart(11)}  ${String(s.onzeker).padStart(7)}`
		);
	}
	const amount = zekerPrecision(l.fields.bedrag);
	lines.push(
		`  bedrag bij zeker: ${
			amount === null
				? 'geen enkel bedrag zeker'
				: amount >= TARGET_PRECISION
					? `doel gehaald (≥ ${TARGET_PRECISION * 100}%)`
					: `doel NIET gehaald (< ${TARGET_PRECISION * 100}%)`
		}`
	);
	if (l.zekerWrongIds.length > 0) {
		lines.push(
			`  zeker maar fout: ${l.zekerWrongIds.map((w) => `${w.id} #${w.item} (${w.field})`).join(', ')}`
		);
	}
	return lines;
}
