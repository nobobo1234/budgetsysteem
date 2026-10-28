// Maakt de iOS-opdracht "Bon naar Budget" opnieuw en ondertekent hem (spec: Uploaden via het
// deelmenu). Draait alleen op een Mac die met iCloud is ingelogd: `shortcuts sign` vraagt bij
// Apple een certificaat aan. Daarom draait dit niet in CI. Het resultaat is een JSON-bestand dat
// je in het datavolume van de app zet; het hoort niet in de repo. Uitleg: docs/ios-opdracht.md.
//
//   node scripts/sign-shortcut.ts --origin https://<jouw domein> [--uit <pad>] [--bewaar <map>]
//
// De opdracht stuurt naar <origin>/api/ingest. Zonder --origin geldt ORIGIN uit de omgeving
// (dezelfde waarde als bij het bouwen); zonder allebei stopt het script. Het schrijft naar
// ./shortcut-signed.json, of naar --uit.
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
	parseSignedShortcut,
	shortcutJson,
	shortcutSourceHash,
	signingUrl
} from '../src/lib/server/receipts/shortcut.ts';

const { values } = parseArgs({
	options: { origin: { type: 'string' }, uit: { type: 'string' }, bewaar: { type: 'string' } }
});
const OUT = resolve(values.uit ?? 'shortcut-signed.json');
const [origin, from] = values.origin
	? [values.origin, '--origin']
	: process.env.ORIGIN
		? [process.env.ORIGIN, 'ORIGIN']
		: [undefined, undefined];
if (origin === undefined) {
	console.error(
		'Geef de origin van je app: node scripts/sign-shortcut.ts --origin https://<jouw domein>'
	);
	process.exit(1);
}
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

	const json = `${JSON.stringify(
		{
			url,
			sourceHash: shortcutSourceHash(url),
			signedAt: new Date().toISOString().slice(0, 10),
			validUntil: validUntil.toISOString().slice(0, 10),
			base64: bytes.toString('base64')
		},
		null,
		'\t'
	)}\n`;
	// Dezelfde controle als de app bij het inlezen: wat hier niet door komt, biedt de app niet aan
	const check = parseSignedShortcut(json);
	if (!check.ok) throw new Error(`De app zou dit bestand weigeren (${check.reason}).`);
	writeFileSync(OUT, json, { mode: 0o644 });
	console.log(
		`Ondertekend (${bytes.length} bytes), certificaat geldig tot ${validUntil.toISOString().slice(0, 10)}.`
	);
	console.log(`Geschreven: ${OUT}`);
	console.log(
		'Zet dit bestand in het datavolume van de app (docs/ios-opdracht.md); niet committen.'
	);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
