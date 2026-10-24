// Markeert verwijderde testbestanden en een dalend aantal tests of asserties ten opzichte van de
// basisbranch (CLAUDE.md: tests nooit groen maken door ze af te zwakken).
// Gebruik: BASE_REF=origin/main node scripts/check-test-count.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const base = process.env.BASE_REF ?? 'origin/main';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const TEST_FILE = /(\.test\.ts|\.spec\.ts)$/;

function count(text) {
	return {
		tests: (text.match(/\b(?:it|test)(?:\.each\([^)]*\))?\s*\(/g) ?? []).length,
		assertions: (text.match(/\bexpect(?:\.soft)?\s*\(|\bassert[.(]|\bfc\.assert\s*\(/g) ?? [])
			.length,
		skipped: (text.match(/\.(?:skip|todo|only)\s*\(|\bx(?:it|describe)\s*\(/g) ?? []).length
	};
}

function sum(files, read) {
	const total = { tests: 0, assertions: 0, skipped: 0 };
	for (const f of files) {
		const c = count(read(f));
		total.tests += c.tests;
		total.assertions += c.assertions;
		total.skipped += c.skipped;
	}
	return total;
}

let mergeBase;
try {
	mergeBase = git('merge-base', base, 'HEAD').trim();
} catch {
	console.log(`Geen basis ${base} gevonden; niets te vergelijken.`);
	process.exit(0);
}

const before = git('ls-tree', '-r', '--name-only', mergeBase)
	.split('\n')
	.filter((f) => TEST_FILE.test(f));
const after = git('ls-files')
	.split('\n')
	.filter((f) => TEST_FILE.test(f));
const deleted = git('diff', '--name-only', '--diff-filter=D', mergeBase, 'HEAD')
	.split('\n')
	.filter((f) => TEST_FILE.test(f));

const old = sum(before, (f) => git('show', `${mergeBase}:${f}`));
const now = sum(after, (f) => readFileSync(f, 'utf8'));

console.log(
	`Tests: ${old.tests} → ${now.tests}, asserties: ${old.assertions} → ${now.assertions}, overgeslagen: ${old.skipped} → ${now.skipped}`
);

const problems = [];
if (deleted.length) problems.push(`Verwijderde testbestanden: ${deleted.join(', ')}`);
if (now.tests < old.tests) problems.push(`Aantal tests daalt (${old.tests} → ${now.tests})`);
if (now.assertions < old.assertions)
	problems.push(`Aantal asserties daalt (${old.assertions} → ${now.assertions})`);
if (now.skipped > old.skipped)
	problems.push(`Meer overgeslagen tests (${old.skipped} → ${now.skipped})`);

if (problems.length) {
	for (const p of problems) console.error(`::error::${p}`);
	console.error('Dit vraagt expliciete review door Noah.');
	process.exit(1);
}
