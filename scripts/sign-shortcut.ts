// Maakt de iOS-opdracht "Bon naar Budget" opnieuw en ondertekent hem (spec: Uploaden via het
// deelmenu). Draait alleen op een Mac die met iCloud is ingelogd: `shortcuts sign` vraagt bij
// Apple een certificaat aan. Daarom draait dit niet in CI; het resultaat wordt gecommit.
// Uitleg: docs/ios-opdracht.md.
//
//   node scripts/sign-shortcut.ts [--origin https://<jouw domein>] [--bewaar <map>]
//
// De opdracht stuurt naar <origin>/api/ingest. Zonder --origin geldt ORIGIN uit de omgeving
// (dezelfde waarde als bij het bouwen), en zonder allebei de host van het huidige bestand
// (opnieuw ondertekenen voor hetzelfde domein). Het script zegt welke het gebruikt.
//
// Het bestand bevat geen token: dat vraagt de opdracht bij installeren.

import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
	SHORTCUT_NAME,
	shortcutJson,
	shortcutSourceHash,
	signingUrl
} from '../src/lib/server/receipts/shortcut.ts';
import { SIGNED_SHORTCUT } from '../src/lib/server/receipts/shortcut-signed.ts';

const OUT = resolve('src/lib/server/receipts/shortcut-signed.ts');
// Enkele aanhalingstekens, zoals Prettier ze schrijft (geen van deze waarden bevat er een)
const quote = (s: string) => `'${s}'`;

const { values } = parseArgs({
	options: { origin: { type: 'string' }, bewaar: { type: 'string' } }
});
const [origin, from] = values.origin
	? [values.origin, '--origin']
	: process.env.ORIGIN
		? [process.env.ORIGIN, 'ORIGIN']
		: [new URL(SIGNED_SHORTCUT.url).origin, 'het huidige bestand'];
let url: string;
try {
	url = signingUrl(origin);
} catch (e) {
	console.error(`Ongeldige origin (${from}): ${(e as Error).message}`);
	process.exit(1);
}
console.log(`Ondertekenen voor ${url} (origin uit ${from}).`);
if (process.platform !== 'darwin') {
	console.error('Ondertekenen kan alleen op macOS (shortcuts sign).');
	process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'opdracht-'));
try {
	const source = join(dir, 'bron.json');
	const unsigned = join(dir, 'unsigned.shortcut');
	const signed = join(dir, `${SHORTCUT_NAME}.shortcut`);
	writeFileSync(source, shortcutJson(url));
	// `shortcuts sign` leest alleen een binaire plist met de extensie .shortcut
	execFileSync('plutil', ['-convert', 'binary1', '-o', unsigned, source]);
	execFileSync('plutil', ['-lint', unsigned], { stdio: 'inherit' });
	execFileSync('shortcuts', ['sign', '--mode', 'anyone', '--input', unsigned, '--output', signed], {
		stdio: 'inherit'
	});

	const bytes = readFileSync(signed);
	if (bytes.subarray(0, 4).toString('latin1') !== 'AEA1') {
		throw new Error('Geen ondertekend bestand (AEA1) gekregen.');
	}
	// De kop van het AEA-archief bevat de certificaatketen van Apple; het eerste certificaat
	// verloopt na ongeveer een jaar. Daarna opnieuw ondertekenen.
	const authSize = bytes.readUInt32LE(8);
	const auth = join(dir, 'auth.plist');
	writeFileSync(auth, bytes.subarray(12, 12 + authSize));
	const leaf = execFileSync(
		'plutil',
		['-extract', 'SigningCertificateChain.0', 'raw', '-o', '-', auth],
		{ encoding: 'utf8' }
	).trim();
	const validUntil = new Date(new X509Certificate(Buffer.from(leaf, 'base64')).validTo);

	if (values.bewaar) {
		copyFileSync(signed, join(resolve(values.bewaar), `${SHORTCUT_NAME}.shortcut`));
		copyFileSync(source, join(resolve(values.bewaar), `${SHORTCUT_NAME}.json`));
	}

	writeFileSync(
		OUT,
		[
			'// Gegenereerd door scripts/sign-shortcut.ts; niet met de hand wijzigen.',
			'// Ondertekende iOS-opdracht zonder token (zie docs/ios-opdracht.md).',
			'',
			'export const SIGNED_SHORTCUT = {',
			`\turl: ${quote(url)},`,
			`\tsourceHash: ${quote(shortcutSourceHash(url))},`,
			`\tsignedAt: ${quote(new Date().toISOString().slice(0, 10))},`,
			`\tvalidUntil: ${quote(validUntil.toISOString().slice(0, 10))},`,
			`\tbase64:\n\t\t${quote(bytes.toString('base64'))}`,
			'} as const;',
			''
		].join('\n')
	);
	console.log(
		`Ondertekend (${bytes.length} bytes), certificaat geldig tot ${validUntil.toISOString().slice(0, 10)}.`
	);
	console.log(`Geschreven: ${OUT}`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
