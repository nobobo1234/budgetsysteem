// Zet het totaal uit coverage/coverage-summary.json (Vitest, `--coverage`) als tabel in de
// job-samenvatting van GitHub Actions. Buiten Actions alleen naar stdout.
import { appendFileSync, readFileSync } from 'node:fs';

const { total } = JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf8'));
const rows = ['lines', 'statements', 'functions', 'branches'].map(
	(key) => `| ${key} | ${total[key].pct}% | ${total[key].covered}/${total[key].total} |`
);
const table = [
	'### Coverage (unit-tests)',
	'',
	'| | % | gedekt |',
	'| --- | --: | --: |',
	...rows,
	''
].join('\n');

console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table + '\n');
