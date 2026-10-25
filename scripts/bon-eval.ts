// Haiku-eval op je eigen bonnen (spec: Testplan voordat het live gaat). Draait niet in CI: kost
// API-tegoed en heeft echte bonnen nodig, die buiten de repo blijven. Uitleg en labelformaat:
// docs/bon-eval.md.
//
//   node scripts/bon-eval.ts <map-met-bonnen> [--varianten 1600,2576,stukken] [--effort medium]
//        [--model claude-haiku-5-5] [--gelijktijdig 3] [--alleen id1,id2] [--bewaar-beelden] [--droog]
//
// De API-sleutel komt uit je eigen omgeving (ANTHROPIC_API_KEY of `ant auth login`); dit script
// leest of toont hem nooit.

import Anthropic from '@anthropic-ai/sdk';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import {
	aggregate,
	formatReport,
	labelId,
	LabelFileSchema,
	scoreBon,
	uploadMoment,
	type BonResult,
	type Label
} from '../src/lib/server/receipts/eval.ts';
import { prepareReceipt, VARIANTS, type Variant } from '../src/lib/server/receipts/images.ts';
import {
	processReceipt,
	RECEIPT_MODEL,
	type Effort,
	type ProcessResult
} from '../src/lib/server/receipts/reader.ts';
import { visualTokens } from '../src/lib/server/receipts/slicing.ts';

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function fail(message: string): never {
	console.error(`bon-eval: ${message}`);
	process.exit(1);
}

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		varianten: { type: 'string', default: VARIANTS.join(',') },
		effort: { type: 'string', default: 'medium' },
		model: { type: 'string', default: RECEIPT_MODEL },
		gelijktijdig: { type: 'string', default: '3' },
		alleen: { type: 'string' },
		'bewaar-beelden': { type: 'boolean', default: false },
		droog: { type: 'boolean', default: false }
	}
});

if (positionals.length !== 1) fail('geef precies één map met bonnen en labels.json mee');

const variants = values.varianten.split(',').map((v) => v.trim());
for (const v of variants) {
	if (!(VARIANTS as readonly string[]).includes(v)) fail(`onbekende variant "${v}"`);
}
const effort = values.effort as Effort;
if (!EFFORTS.includes(effort)) fail(`effort moet een van ${EFFORTS.join(', ')} zijn`);
const concurrency = Number(values.gelijktijdig);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
	fail('gelijktijdig moet tussen 1 en 8 liggen');
}

// Echte bonnen horen nooit in de repo: weiger een map binnen de projectmap
const dir = await realpath(resolve(positionals[0]!)).catch(() => fail('map bestaat niet'));
const repo = await realpath(resolve(import.meta.dirname, '..'));
const rel = relative(repo, dir);
if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
	fail('de map met bonnen moet buiten de repo staan');
}

const labelFile = LabelFileSchema.safeParse(
	JSON.parse(await readFile(join(dir, 'labels.json'), 'utf8').catch(() => fail('geen labels.json')))
);
if (!labelFile.success) {
	fail(
		`labels.json klopt niet:\n${labelFile.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`
	);
}
const only = values.alleen ? new Set(values.alleen.split(',')) : null;
const labels = labelFile.data.bonnen.filter((l) => !only || only.has(labelId(l)));
const ids = new Set<string>();
for (const l of labels) {
	if (ids.has(labelId(l))) fail(`dubbele id "${labelId(l)}"; geef de bon een eigen "id"`);
	ids.add(labelId(l));
}

async function loadFiles(label: Label): Promise<Buffer[]> {
	return Promise.all(label.bestanden.map((name) => readFile(join(dir, name))));
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

const client = values.droog ? null : new Anthropic();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const details: unknown[] = [];
const reports = [];

for (const variant of variants as Variant[]) {
	let done = 0;
	const results = await pool(labels, concurrency, async (label): Promise<BonResult> => {
		const parts = await prepareReceipt(await loadFiles(label), variant);
		if (values['bewaar-beelden']) {
			const out = join(dir, 'beelden', variant);
			await mkdir(out, { recursive: true });
			await Promise.all(
				parts.map((p, i) => writeFile(join(out, `${labelId(label)}-deel${i + 1}.jpg`), p.data))
			);
		}

		let result: BonResult;
		if (!client) {
			const tokens = parts.reduce((sum, p) => sum + visualTokens(p.width, p.height), 0);
			console.log(
				`${variant} ${labelId(label)}: ${parts.map((p) => `${p.width}×${p.height}`).join(' + ')} (${tokens} beeldtokens)`
			);
			result = scoreBon(label, variant, { ok: false, reason: 'fout', usage: null });
		} else {
			let processed: ProcessResult | null = null;
			try {
				processed = await processReceipt(client, parts, uploadMoment(label), {
					model: values.model,
					effort
				});
			} catch (e) {
				const status = e instanceof Anthropic.APIError ? ` (HTTP ${e.status})` : '';
				console.error(`${variant} ${labelId(label)}: aanroep mislukt${status}`);
			}
			result = processed
				? scoreBon(label, variant, processed)
				: scoreBon(label, variant, { ok: false, reason: 'fout', usage: null });
			details.push({ variant, id: labelId(label), result, uitvoer: processed });
		}
		if (client) process.stdout.write(`\r${variant}: ${++done}/${labels.length}`);
		return result;
	});
	if (client) process.stdout.write('\n');
	reports.push(aggregate(variant, results));
}

if (client) {
	console.log(formatReport(reports));
	// Details per bon (met wat Haiku las) alleen in de map buiten de repo
	const out = join(dir, 'resultaten');
	await mkdir(out, { recursive: true });
	const file = join(out, `eval-${stamp}.json`);
	await writeFile(
		file,
		JSON.stringify({ model: values.model, effort, gemaakt: stamp, reports, details }, null, 2)
	);
	console.log(`\nDetails: ${file}`);
}
