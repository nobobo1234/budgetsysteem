import { z } from 'zod';
import { addDays, isIsoDate } from '../../dates.ts';
import { parseAmount } from '../../money.ts';
import type { CheckedReceipt, FieldStatus } from './checks.ts';
import type { Variant } from './images.ts';
import type { ReadFailure, ReadUsage } from './reader.ts';
import { PAYMENT_METHODS } from './schema.ts';

// Haiku-eval (spec: Testplan voordat het live gaat): per variant en per veld hoe vaak Haiku het
// goed heeft, en vooral hoe vaak "zeker" toch fout was. Pure logica; het script in
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
	notitie: z.string().max(500).optional()
});

export const LabelFileSchema = z.strictObject({
	bonnen: z.array(LabelSchema).min(1).max(100)
});

export type Label = z.infer<typeof LabelSchema>;

export function labelId(label: Label): string {
	return label.id ?? label.bestanden[0]!.replace(/\.[^.]+$/, '');
}

/** Het uploadmoment waartegen de datumcontroles gelden: midden op de dag, lokale tijd. */
export function uploadMoment(label: Label): Date {
	const iso = label.ontvangen ?? addDays(label.datum, 1);
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

export interface BonResult {
	id: string;
	variant: Variant;
	soort: string | null;
	/** Uitkomst van de hele bon, of de reden dat lezen mislukte. */
	outcome: FieldStatus | ReadFailure | 'fout';
	fields: Partial<Record<EvalField, FieldResult>>;
	usage: ReadUsage | null;
}

/** Vergelijkt de gecontroleerde uitvoer met het label. */
export function scoreBon(
	label: Label,
	variant: Variant,
	result:
		| { ok: true; checked: CheckedReceipt; usage: ReadUsage }
		| { ok: false; reason: ReadFailure | 'fout'; usage: ReadUsage | null }
): BonResult {
	const base = { id: labelId(label), variant, soort: label.soort ?? null };
	if (!result.ok) return { ...base, outcome: result.reason, fields: {}, usage: result.usage };

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
		outcome: c.outcome,
		usage: result.usage,
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

export function aggregate(variant: Variant, results: BonResult[]): VariantReport {
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

	for (const r of results) {
		if (r.usage) {
			inputTokens += r.usage.inputTokens;
			outputTokens += r.usage.outputTokens;
			costNanoUsd += r.usage.costNanoUsd;
			durations.push(r.usage.durationMs);
		}
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
		zekerWrongIds
	};
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
	}
	return lines.join('\n');
}
