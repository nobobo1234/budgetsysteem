// Vraag-eval op de geanonimiseerde fixture (spec: Vraagveld, Eval; Tests en CI). Draait niet in
// CI: kost API-tegoed. Na elke wijziging aan de prompt of de semantische laag opnieuw, op alle
// varianten, zodat een sneller model weer kan als het doel ook daarmee gehaald wordt. Uitleg:
// docs/vraag-eval.md.
//
//   node scripts/vraag-eval.ts [--varianten haiku,haiku-high,sonnet] [--gelijktijdig 3]
//        [--alleen id1,id2] [--uit map-buiten-de-repo] [--droog]
//
// De API-sleutel komt uit je eigen omgeving (ANTHROPIC_API_KEY of `ant auth login`); dit script
// leest of toont hem nooit. De fixture is verzonnen; er gaan geen echte gegevens naar het model.

import Anthropic from '@anthropic-ai/sdk';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { AiClient } from '../src/lib/server/ai/client.ts';
import { openDatabase } from '../src/lib/server/db/index.ts';
import {
	aggregate,
	formatReport,
	pickVariant,
	scoreQuestion,
	type EvalOutcome,
	type EvalResult
} from '../src/lib/server/question/eval.ts';
import {
	buildQuestionRequest,
	QUESTION_VARIANTS,
	translateQuestion,
	type QuestionVariant
} from '../src/lib/server/question/translator.ts';
import { catalog, runQuery } from '../src/lib/server/semantic.ts';
import type { QuestionFormat } from '../src/lib/semantic/format.ts';
import { buildFixture, FIXTURE_TODAY } from '../tests/fixtures/vraag/fixture.ts';
import { GOUDSET } from '../tests/fixtures/vraag/goudset.ts';

function fail(message: string): never {
	console.error(`vraag-eval: ${message}`);
	process.exit(1);
}

const { values } = parseArgs({
	options: {
		varianten: { type: 'string', default: QUESTION_VARIANTS.map((v) => v.name).join(',') },
		gelijktijdig: { type: 'string', default: '3' },
		alleen: { type: 'string' },
		uit: { type: 'string' },
		droog: { type: 'boolean', default: false }
	}
});

const variants: QuestionVariant[] = values.varianten.split(',').map((name) => {
	const v = QUESTION_VARIANTS.find((x) => x.name === name.trim());
	if (!v)
		fail(
			`onbekende variant "${name}"; kies uit ${QUESTION_VARIANTS.map((x) => x.name).join(', ')}`
		);
	return v;
});
const concurrency = Number(values.gelijktijdig);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
	fail('gelijktijdig moet tussen 1 en 8 liggen');
const only = values.alleen ? new Set(values.alleen.split(',')) : null;
const questions = GOUDSET.filter((g) => !only || only.has(g.id));
if (questions.length === 0) fail('geen vragen over na --alleen');

// Details (met wat het model koos) alleen in een map buiten de repo
let outDir: string | null = null;
if (values.uit) {
	const dir = resolve(values.uit);
	await mkdir(dir, { recursive: true });
	const real = await realpath(dir);
	const rel = relative(await realpath(resolve(import.meta.dirname, '..')), real);
	if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))
		fail('de map voor de resultaten moet buiten de repo staan');
	outDir = real;
}

const db = openDatabase(':memory:', 'drizzle');
buildFixture(db);
const cat = catalog(db);

if (values.droog) {
	// Alleen laten zien wat er naar het model zou gaan, zonder aanroep
	const req = buildQuestionRequest(questions[0]!.vraag, cat, FIXTURE_TODAY, {
		variant: variants[0]
	});
	console.log(JSON.stringify({ system: req.system, messages: req.messages }, null, 2));
	console.log(`\n${questions.length} vragen × ${variants.length} varianten`);
	process.exit(0);
}

const client = new Anthropic() as unknown as AiClient;

/** Wat code uitrekent bij het vraagformaat van het model, zoals in het vraagveld. */
function outcomeOf(format: QuestionFormat): EvalOutcome {
	if (format.soort !== 'vraag') return { kind: format.soort };
	const { soort: _, ...query } = format;
	const r = runQuery(db, query, FIXTURE_TODAY, { catalog: cat });
	if (!r.ok) return { kind: r.kind };
	return {
		kind: 'beantwoord',
		value: r.answer.value,
		rows: r.answer.rows?.map((x) => [x.label, x.value]) ?? null
	};
}

/** Draait `fn` over alle items met hooguit `limit` tegelijk, in volgorde van de uitkomsten. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i]!);
			}
		})
	);
	return out;
}

const reports = [];
const details: unknown[] = [];
for (const variant of variants) {
	let done = 0;
	const results = await pool(questions, concurrency, async (gold): Promise<EvalResult> => {
		const t = await translateQuestion(client, gold.vraag, cat, FIXTURE_TODAY, { variant });
		const outcome: EvalOutcome = t.ok
			? outcomeOf(t.format)
			: { kind: 'mislukt', outcome: t.outcome };
		const result = scoreQuestion(gold, outcome, {
			durationMs: t.usage.durationMs,
			costNanoUsd: t.usage.costNanoUsd
		});
		details.push({ variant: variant.name, id: gold.id, result, format: t.ok ? t.format : null });
		process.stdout.write(`\r${variant.name}: ${++done}/${questions.length}`);
		return result;
	});
	process.stdout.write('\n');
	reports.push(aggregate(variant.name, results));
}

console.log(formatReport(reports));
if (outDir) {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const file = join(outDir, `vraag-eval-${stamp}.json`);
	await writeFile(
		file,
		JSON.stringify(
			{ gemaakt: stamp, gekozen: pickVariant(reports)?.variant ?? null, reports, details },
			null,
			2
		)
	);
	console.log(`\nDetails: ${file}`);
}
