import type { Query } from '../../semantic/format.ts';
import { medianOf } from '../telemetry/ai.ts';
import type { TranslateFailure } from './translator.ts';

// De vraag-eval (spec: Vraagveld, Eval; Tests en CI, Vraag-eval): pure scoring, zonder model of
// database. Het script scripts/vraag-eval.ts stelt de vragen uit de goudset aan elke variant,
// rekent uit wat het model koos en geeft de uitkomst hier. Doel: minstens 95% juist op de
// vragen die in het vraagformaat passen, en geen enkel getal bij een vraag die er niet in past.

/** Minstens zo veel juist op de vragen die in het vraagformaat passen. */
export const TARGET_ACCURACY = 0.95;

export interface GoldAnswer {
	soort: 'vraag';
	/** De query die de vraag bedoelt */
	query: Query;
	/** De uitkomst op de fixture: centen, of een aantal bij `aantal` */
	waarde: number;
	/** Bij een groepering: de eerste rijen (label en waarde), in volgorde */
	rijen?: [string, number][];
	/** Andere lezingen die ook goed zijn, met hun uitkomst */
	ook?: { query: Query; waarde: number }[];
}

export interface GoldQuestion {
	id: string;
	vraag: string;
	/**
	 * `vraag`: past in het formaat en heeft één goede uitkomst. `verduidelijken`: dubbelzinnig;
	 * goed is een verduidelijking (van het model of van code). `kan_niet`: past niet; goed is
	 * elke uitkomst zonder getal.
	 */
	verwacht: GoldAnswer | { soort: 'verduidelijken' } | { soort: 'kan_niet' };
	/** Welke valkuil deze vraag test */
	valkuil?: string;
}

/** Wat er van één vraag terechtkwam. */
export type EvalOutcome =
	| { kind: 'beantwoord'; value: number; rows: [string, number][] | null }
	| { kind: 'verduidelijken' }
	| { kind: 'kan_niet' }
	| { kind: 'mislukt'; outcome: TranslateFailure };

export interface EvalResult {
	id: string;
	soort: GoldQuestion['verwacht']['soort'];
	outcome: EvalOutcome;
	correct: boolean;
	/** Een getal bij een vraag die niet in het formaat past: het ergste wat kan */
	numberWhereNone: boolean;
	durationMs: number;
	costNanoUsd: number;
}

function rowsMatch(expected: readonly [string, number][], got: readonly [string, number][] | null) {
	if (!got) return false;
	const n = Math.min(expected.length, got.length);
	if (n === 0) return expected.length === got.length;
	return expected.slice(0, n).every(([l, v], i) => got[i]![0] === l && got[i]![1] === v);
}

/** Of de uitkomst goed is volgens de goudset. */
export function scoreQuestion(
	gold: GoldQuestion,
	outcome: EvalOutcome,
	usage: { durationMs: number; costNanoUsd: number }
): EvalResult {
	const v = gold.verwacht;
	let correct = false;
	if (v.soort === 'vraag') {
		if (outcome.kind === 'beantwoord') {
			const main = outcome.value === v.waarde && (!v.rijen || rowsMatch(v.rijen, outcome.rows));
			correct = main || (v.ook ?? []).some((alt) => alt.waarde === outcome.value);
		}
	} else if (v.soort === 'verduidelijken') correct = outcome.kind === 'verduidelijken';
	else correct = outcome.kind !== 'beantwoord';
	return {
		id: gold.id,
		soort: v.soort,
		outcome,
		correct,
		numberWhereNone: v.soort === 'kan_niet' && outcome.kind === 'beantwoord',
		...usage
	};
}

export interface VariantReport {
	variant: string;
	/** Juist op de vragen die in het formaat passen */
	inFormat: { correct: number; total: number; accuracy: number };
	/** Terecht verduidelijkt bij een dubbelzinnige vraag */
	clarified: { correct: number; total: number };
	/** Terecht geen getal bij een vraag die niet past */
	refused: { correct: number; total: number };
	numbersWhereNone: number;
	/** Hoe vaak het model geen bruikbaar antwoord gaf, per soort */
	failures: Partial<Record<TranslateFailure, number>>;
	medianMs: number | null;
	costNanoUsd: number;
	/** Wat honderd vragen zouden kosten, gemiddeld over deze run */
	costPer100NanoUsd: number;
	passes: boolean;
	wrong: string[];
}

export function aggregate(variant: string, results: readonly EvalResult[]): VariantReport {
	const of = (soort: EvalResult['soort']) => results.filter((r) => r.soort === soort);
	const count = (list: readonly EvalResult[]) => ({
		correct: list.filter((r) => r.correct).length,
		total: list.length
	});
	const inFormat = count(of('vraag'));
	const accuracy = inFormat.total === 0 ? 0 : inFormat.correct / inFormat.total;
	const numbersWhereNone = results.filter((r) => r.numberWhereNone).length;
	const failures: VariantReport['failures'] = {};
	for (const r of results)
		if (r.outcome.kind === 'mislukt')
			failures[r.outcome.outcome] = (failures[r.outcome.outcome] ?? 0) + 1;
	const costNanoUsd = results.reduce((s, r) => s + r.costNanoUsd, 0);
	return {
		variant,
		inFormat: { ...inFormat, accuracy },
		clarified: count(of('verduidelijken')),
		refused: count(of('kan_niet')),
		numbersWhereNone,
		failures,
		medianMs: medianOf(results.map((r) => r.durationMs)),
		costNanoUsd,
		costPer100NanoUsd: results.length === 0 ? 0 : Math.round((costNanoUsd / results.length) * 100),
		passes: accuracy >= TARGET_ACCURACY && numbersWhereNone === 0,
		wrong: results.filter((r) => !r.correct).map((r) => r.id)
	};
}

/** De snelste variant die het doel haalt (spec: Vraagveld, Model), of `null` als geen het haalt. */
export function pickVariant(reports: readonly VariantReport[]): VariantReport | null {
	return (
		reports
			.filter((r) => r.passes && r.medianMs !== null)
			.sort((a, b) => a.medianMs! - b.medianMs!)[0] ?? null
	);
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (nano: number) => `$ ${(nano / 1e9).toFixed(4)}`;

export function formatReport(reports: readonly VariantReport[]): string {
	const lines: string[] = [];
	for (const r of reports) {
		lines.push(
			`\n${r.variant} ${r.passes ? '(haalt het doel)' : '(haalt het doel niet)'}`,
			`  juist in het formaat: ${r.inFormat.correct}/${r.inFormat.total} (${pct(r.inFormat.accuracy)}, doel ${pct(TARGET_ACCURACY)})`,
			`  getal bij een vraag die niet past: ${r.numbersWhereNone} (doel 0)`,
			`  terecht geen getal: ${r.refused.correct}/${r.refused.total}; terecht verduidelijkt: ${r.clarified.correct}/${r.clarified.total}`,
			`  mediane duur: ${r.medianMs === null ? '–' : `${r.medianMs} ms`}; kosten: ${usd(r.costNanoUsd)} (${usd(r.costPer100NanoUsd)} per 100 vragen)`
		);
		const failures = Object.entries(r.failures);
		if (failures.length > 0)
			lines.push(`  niet te lezen: ${failures.map(([k, n]) => `${k} ${n}`).join(', ')}`);
		if (r.wrong.length > 0) lines.push(`  fout: ${r.wrong.join(', ')}`);
	}
	const best = pickVariant(reports);
	lines.push(
		'',
		best
			? `Snelste variant die het doel haalt: ${best.variant}`
			: 'Geen variant haalt het doel: eerst de prompt en de semantische laag aanscherpen, daarna Claude Opus 5.5 meten.'
	);
	return lines.join('\n');
}
