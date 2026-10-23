// Weigert bidi- en zero-width-tekens in bestanden onder versiebeheer (Trojan Source, CVE-2021-42574).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FORBIDDEN = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD]/u;
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|db|sqlite)$/i;

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
	.split('\0')
	.filter((f) => f && !BINARY.test(f));

let failed = 0;
for (const file of files) {
	let text;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		continue;
	}
	const lines = text.split('\n');
	lines.forEach((line, i) => {
		// Een BOM op de allereerste positie van een bestand is geen verstopte tekst
		const check = i === 0 ? line.replace(/^\uFEFF/, '') : line;
		const m = FORBIDDEN.exec(check);
		if (m) {
			failed++;
			const code = m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
			console.error(`${file}:${i + 1}: onzichtbaar teken U+${code}`);
		}
	});
}

if (process.argv.includes('--commits')) {
	const range = process.env.COMMIT_RANGE ?? 'origin/main..HEAD';
	const log = execFileSync('git', ['log', '--format=%H%x00%B%x00', range], { encoding: 'utf8' });
	for (const [hash, body] of log.split('\0\n').map((e) => e.split('\0'))) {
		if (body && FORBIDDEN.test(body)) {
			failed++;
			console.error(`commit ${hash?.slice(0, 10)}: onzichtbaar teken in het bericht`);
		}
	}
}

if (failed > 0) {
	console.error(`\n${failed} onzichtbare teken(s) gevonden.`);
	process.exit(1);
}
console.log('Geen onzichtbare tekens gevonden.');
