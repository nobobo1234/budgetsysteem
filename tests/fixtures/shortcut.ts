import { signingUrl, shortcutSourceHash } from '../../src/lib/server/receipts/shortcut.ts';

// Een nagemaakt "ondertekend" bestand voor tests, zoals scripts/sign-shortcut.ts het schrijft.
// Geen echte handtekening: alleen de AEA1-kop met vaste bytes erachter, zodat de app het
// herkent. Altijd voor een neutraal testdomein, nooit voor een echt domein.

export const FAKE_SHORTCUT_BYTES = Buffer.concat([
	Buffer.from('AEA1', 'latin1'),
	Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 37 + 11) % 256))
]);

export type FakeShortcut = {
	url: string;
	sourceHash: string;
	signedAt: string;
	validUntil: string;
	base64: string;
};

/** De velden van een geldig bestand voor `origin`; overschrijf er een om het ongeldig te maken. */
export function fakeShortcut(origin: string, overrides: Partial<FakeShortcut> = {}): FakeShortcut {
	const url = signingUrl(origin);
	return {
		url,
		sourceHash: shortcutSourceHash(url),
		signedAt: '2026-10-25',
		validUntil: '2027-11-18',
		base64: FAKE_SHORTCUT_BYTES.toString('base64'),
		...overrides
	};
}

/** Als JSON-tekst, precies zoals het script hem wegschrijft. */
export function fakeShortcutJson(origin: string, overrides: Partial<FakeShortcut> = {}): string {
	return `${JSON.stringify(fakeShortcut(origin, overrides), null, '\t')}\n`;
}
