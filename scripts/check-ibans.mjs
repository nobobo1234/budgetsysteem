// Zoekt naar echte IBANs in bestanden onder versiebeheer. Alleen IBANs uit
// scripts/test-ibans.txt mogen voorkomen (spec: Tests en CI, Afspraken).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const allowed = new Set(
	readFileSync('scripts/test-ibans.txt', 'utf8')
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith('#'))
);

function valid(iban) {
	const r = iban.slice(4) + iban.slice(0, 4);
	let rest = 0;
	for (const ch of r) {
		const digits = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
		for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
	}
	return rest === 1;
}

// IBAN met of zonder spaties in groepjes van vier
const PATTERN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g;
const SKIP =
	/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf)$|^pnpm-lock\.yaml$|^scripts\/test-ibans\.txt$/;

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
	.split('\0')
	.filter((f) => f && !SKIP.test(f));

let found = 0;
for (const file of files) {
	let text;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		continue;
	}
	for (const m of text.matchAll(PATTERN)) {
		const iban = m[0].replace(/ /g, '');
		if (iban.length < 15 || iban.length > 34 || !valid(iban) || allowed.has(iban)) continue;
		const line = text.slice(0, m.index).split('\n').length;
		console.error(`${file}:${line}: IBAN die niet op de testlijst staat (${iban.slice(0, 4)}…)`);
		found++;
	}
}

if (found > 0) {
	console.error(`\n${found} mogelijk echte IBAN(s). Gebruik een IBAN uit scripts/test-ibans.txt.`);
	process.exit(1);
}
console.log('Geen onbekende IBANs gevonden.');
