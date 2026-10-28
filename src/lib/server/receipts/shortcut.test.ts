import { describe, expect, it } from 'vitest';
import {
	FAKE_SHORTCUT_BYTES,
	fakeShortcut,
	fakeShortcutJson
} from '../../../../tests/fixtures/shortcut.ts';
import {
	INGEST_PATH,
	JPEG_QUALITY,
	MAX_EDGE,
	MAX_SIGNED_BYTES,
	MAX_SIGNED_FILE_BYTES,
	RENEW_DAYS,
	ingestUrlFor,
	parseSignedShortcut,
	shortcutDefinition,
	shortcutJson,
	shortcutSourceHash,
	shortcutStatus,
	signingUrl
} from './shortcut.ts';

type Dict = Record<string, unknown>;

// Een neutrale installatie; het ondertekende bestand staat in het datavolume, niet in de repo
const ORIGIN = 'https://budget.example.test';
const INGEST_URL = `${ORIGIN}/api/ingest`;
const definition = shortcutDefinition(INGEST_URL) as Dict;
const actions = definition.WFWorkflowActions as Dict[];
const id = (a: Dict) => a.WFWorkflowActionIdentifier as string;
const params = (a: Dict) => a.WFWorkflowActionParameters as Dict;
const find = (name: string) => actions.filter((a) => id(a) === `is.workflow.actions.${name}`);

describe('iOS-opdracht', () => {
	it('staat in het deelmenu en neemt alleen afbeeldingen aan', () => {
		expect(definition.WFWorkflowTypes).toEqual(['ActionExtension']);
		expect(definition.WFWorkflowInputContentItemClasses).toEqual(['WFImageContentItem']);
	});

	it('vraagt het token bij installeren op de lege tekstactie', () => {
		const [question] = definition.WFWorkflowImportQuestions as Dict[];
		const target = actions[question!.ActionIndex as number]!;
		expect(id(target)).toBe('is.workflow.actions.gettext');
		expect(question!.ParameterKey).toBe('WFTextActionText');
		expect(params(target).WFTextActionText).toBe('');
		expect(question!.DefaultValue).toBe('');
	});

	it('bevat geen token', () => {
		expect(shortcutJson(INGEST_URL)).not.toMatch(/bon_[A-Za-z0-9_-]{20,}/);
	});

	it('stuurt elke afbeelding als ruwe JPEG-body met het token als Bearer', () => {
		const [upload] = find('downloadurl');
		const p = params(upload!);
		expect(p.WFURL).toBe(INGEST_URL);
		expect(p.WFHTTPMethod).toBe('POST');
		expect(p.WFHTTPBodyType).toBe('File');
		const headers = (p.WFHTTPHeaders as { Value: { WFDictionaryFieldValueItems: Dict[] } }).Value
			.WFDictionaryFieldValueItems;
		const header = (name: string) => {
			const item = headers.find(
				(h) => (h.WFKey as { Value: { string: string } }).Value.string === name
			)!;
			return (item.WFValue as { Value: { string: string; attachmentsByRange: Dict } }).Value;
		};
		const token = params(actions[1]!).UUID;
		const auth = header('Authorization');
		expect(auth.string.startsWith('Bearer ')).toBe(true);
		expect(auth.string).toHaveLength('Bearer '.length + 1);
		expect(auth.attachmentsByRange['{7, 1}']).toMatchObject({ OutputUUID: token });
		expect(header('Content-Type').string).toBe('image/jpeg');
		// Het lichaam is de omgezette JPEG
		const [jpeg] = find('image.convert');
		expect(p.WFRequestVariable).toMatchObject({ Value: { OutputUUID: params(jpeg!).UUID } });
		expect(params(jpeg!)).toMatchObject({
			WFImageFormat: 'JPEG',
			WFImageCompressionQuality: JPEG_QUALITY,
			WFImagePreserveMetadata: false
		});
	});

	it('verkleint alleen boven 2576 px, aan de lange kant', () => {
		const resizes = find('image.resize').map(params);
		expect(resizes).toHaveLength(2);
		for (const r of resizes) {
			expect(r.WFImageResizeKey).toBe('Longest Edge');
			expect(r.WFImageResizeLength).toBe(String(MAX_EDGE));
		}
		const checks = find('conditional')
			.map(params)
			.filter((p) => p.WFControlFlowMode === 0 && p.WFNumberValue !== undefined);
		expect(checks.map((c) => [c.WFCondition, c.WFNumberValue])).toEqual([
			[2, String(MAX_EDGE)],
			[2, String(MAX_EDGE)]
		]);
	});

	it('elk blok wordt gesloten', () => {
		const open = new Map<string, number>();
		for (const a of actions) {
			const p = params(a);
			if (typeof p.GroupingIdentifier !== 'string') continue;
			if (p.WFControlFlowMode === 0) open.set(p.GroupingIdentifier, 1);
			if (p.WFControlFlowMode === 2) open.delete(p.GroupingIdentifier);
		}
		expect([...open.keys()]).toEqual([]);
	});

	it('stuurt alleen naar het upload-endpoint en bevat verder geen domein', () => {
		const json = shortcutJson(INGEST_URL);
		expect(json.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"]*/gi)).toEqual([INGEST_URL]);
		const other = 'https://ander.example.test/api/ingest';
		const [upload] = find('downloadurl');
		expect(params(upload!).WFURL).not.toBe(other);
		const otherDefinition = shortcutDefinition(other) as Dict;
		const otherUpload = (otherDefinition.WFWorkflowActions as Dict[]).find(
			(a) => id(a) === 'is.workflow.actions.downloadurl'
		)!;
		expect(params(otherUpload).WFURL).toBe(other);
		expect(shortcutSourceHash(other)).not.toBe(shortcutSourceHash(INGEST_URL));
	});
});

// TER REVIEW (Noah): het ondertekende bestand uit het datavolume (upload/ingest)
describe('ondertekend bestand inlezen', () => {
	const refused = (text: string) => {
		const result = parseSignedShortcut(text);
		return result.ok ? 'aangenomen' : result.reason;
	};

	it('neemt een bestand aan dat bij deze definitie hoort', () => {
		// Zelfde eisen als de vroegere test op het meegeleverde bestand
		const result = parseSignedShortcut(fakeShortcutJson(ORIGIN));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.shortcut.url).toBe(INGEST_URL);
		expect(result.shortcut.url).toMatch(/^https:\/\/[^/]+\/api\/ingest$/);
		expect(result.shortcut.url).toBe(signingUrl(new URL(result.shortcut.url).origin));
		expect(result.shortcut.sourceHash).toBe(shortcutSourceHash(result.shortcut.url));
		expect(result.shortcut.validUntil).toBe('2027-11-18');
		expect(result.bytes.equals(FAKE_SHORTCUT_BYTES)).toBe(true);
		expect(result.bytes.subarray(0, 4).toString('latin1')).toBe('AEA1');
	});

	it('weigert een bestand dat niet bij de huidige definitie hoort', () => {
		const other = shortcutSourceHash('https://ander.example.test/api/ingest');
		expect(refused(fakeShortcutJson(ORIGIN, { sourceHash: other }))).toBe('source');
		expect(refused(fakeShortcutJson(ORIGIN, { sourceHash: '0'.repeat(64) }))).toBe('source');
		// Hoofdletters of een andere lengte zijn geen hash zoals het script hem schrijft
		const hash = shortcutSourceHash(INGEST_URL);
		expect(refused(fakeShortcutJson(ORIGIN, { sourceHash: hash.toUpperCase() }))).toBe('schema');
		expect(refused(fakeShortcutJson(ORIGIN, { sourceHash: hash.slice(1) }))).toBe('schema');
	});

	it('weigert een URL die geen https-upload-endpoint is', () => {
		for (const url of [
			'http://budget.example.test/api/ingest',
			`${ORIGIN}/api/receipts`,
			`${ORIGIN}/api/ingest/`,
			`${ORIGIN}/api/ingest?x=1`,
			`${ORIGIN}:443/api/ingest`,
			'https://iemand:geheim@budget.example.test/api/ingest',
			'geen url'
		]) {
			// Met een kloppende hash, zodat alleen de URL het verschil maakt
			let sourceHash = '0'.repeat(64);
			try {
				sourceHash = shortcutSourceHash(url);
			} catch {
				// Geen geldige URL: de hash doet er dan niet toe
			}
			expect(refused(fakeShortcutJson(ORIGIN, { url, sourceHash })), url).toBe('url');
		}
	});

	it('weigert ongeldige JSON en een verkeerde vorm zonder te crashen', () => {
		const valid = fakeShortcut(ORIGIN);
		for (const text of ['', '{', 'null', '[]', '"tekst"', '{"url": 1}', '\u0000']) {
			expect(['json', 'schema']).toContain(refused(text));
		}
		const { base64: _, ...withoutBase64 } = valid;
		expect(refused(JSON.stringify(withoutBase64))).toBe('schema');
		expect(refused(JSON.stringify({ ...valid, extra: 'veld' }))).toBe('schema');
		expect(refused(JSON.stringify({ ...valid, validUntil: '2027-02-30' }))).toBe('schema');
		expect(refused(JSON.stringify({ ...valid, signedAt: '25-10-2026' }))).toBe('schema');
		expect(refused(JSON.stringify({ ...valid, validUntil: 20271118 }))).toBe('schema');
		expect(refused(JSON.stringify({ ...valid, validUntil: valid.signedAt }))).toBe('dates');
	});

	it('weigert inhoud die geen ondertekend archief is', () => {
		const base64 = (bytes: Buffer) => bytes.toString('base64');
		const unsigned = Buffer.from('bplist00 niet ondertekend');
		expect(refused(fakeShortcutJson(ORIGIN, { base64: base64(unsigned) }))).toBe('signature');
		// Geen canonieke base64 (Buffer.from zou de tekens stilletjes overslaan)
		const valid = base64(FAKE_SHORTCUT_BYTES);
		expect(
			refused(fakeShortcutJson(ORIGIN, { base64: `${valid.slice(0, 8)}!${valid.slice(8)}` }))
		).toBe('schema');
		expect(refused(fakeShortcutJson(ORIGIN, { base64: valid.slice(0, -1) }))).toBe('signature');
		expect(refused(fakeShortcutJson(ORIGIN, { base64: 'QUVBMQ' }))).toBe('schema');
	});

	it('weigert een te groot bestand', () => {
		const big = Buffer.concat([Buffer.from('AEA1'), Buffer.alloc(MAX_SIGNED_BYTES)]);
		// Net te veel bytes: de base64 is langer dan het schema toestaat
		expect(refused(fakeShortcutJson(ORIGIN, { base64: big.toString('base64') }))).toBe('schema');
		const justFits = Buffer.concat([Buffer.from('AEA1'), Buffer.alloc(MAX_SIGNED_BYTES - 4)]);
		expect(refused(fakeShortcutJson(ORIGIN, { base64: justFits.toString('base64') }))).toBe(
			'aangenomen'
		);
		// Een te groot bestand wordt niet eens als JSON gelezen
		expect(refused(' '.repeat(MAX_SIGNED_FILE_BYTES + 1))).toBe('size');
		const huge = 'A'.repeat(MAX_SIGNED_FILE_BYTES);
		expect(refused(fakeShortcutJson(ORIGIN, { base64: huge }))).toBe('size');
	});
});

describe('status van de opdracht', () => {
	const signed = { url: INGEST_URL, validUntil: '2027-11-16' };
	const origin = ORIGIN;
	const at = (iso: string) => new Date(iso);

	it('geldig tot een maand voor het verlopen', () => {
		expect(shortcutStatus(signed, origin, at('2027-10-16T23:59:59Z')).state).toBe('ok');
		expect(RENEW_DAYS).toBe(30);
	});

	it('herinnert vanaf een maand ervoor', () => {
		expect(shortcutStatus(signed, origin, at('2027-10-17T00:00:00Z'))).toEqual({
			state: 'expiring',
			validUntil: '2027-11-16'
		});
		expect(shortcutStatus(signed, origin, at('2027-11-15T23:59:59Z')).state).toBe('expiring');
	});

	it('verlopen vanaf het begin van de laatste dag', () => {
		expect(shortcutStatus(signed, origin, at('2027-11-16T00:00:00Z')).state).toBe('expired');
		expect(shortcutStatus(signed, origin, at('2028-03-01T12:00:00Z')).state).toBe('expired');
	});

	it('niet aanbieden als de app op een andere host draait', () => {
		const now = at('2026-11-01T12:00:00Z');
		for (const other of [
			'http://localhost:5173',
			'https://budget.example.org',
			'http://budget.example.test',
			'https://budget.example.test:8443',
			'https://ander.budget.example.test'
		]) {
			expect(shortcutStatus(signed, other, now)).toEqual({
				state: 'other-host',
				validUntil: '2027-11-16',
				host: 'budget.example.test',
				origin: new URL(other).origin
			});
		}
		// Een pad of slash aan het eind van ORIGIN maakt niet uit
		expect(shortcutStatus(signed, `${origin}/`, now).state).toBe('ok');
		expect(shortcutStatus(signed, `${origin}/een/pad`, now).state).toBe('ok');
	});

	it('alleen voor precies het upload-endpoint van deze app', () => {
		const now = at('2026-11-01T12:00:00Z');
		// Zelfde host, ander pad: ook geen download
		for (const url of [`${origin}/api/receipts`, `${origin}/api/ingest/`, `${origin}/`]) {
			expect(shortcutStatus({ ...signed, url }, origin, now).state).toBe('other-host');
		}
		// Hoofdletters en de standaardpoort maken niet uit
		expect(shortcutStatus(signed, 'https://Budget.Example.TEST:443', now).state).toBe('ok');
	});
});

describe('URL van de opdracht uit de origin', () => {
	it('volgt uit de geconfigureerde origin', () => {
		expect(INGEST_PATH).toBe('/api/ingest');
		expect(ingestUrlFor(ORIGIN)).toBe(INGEST_URL);
		expect(ingestUrlFor(`${ORIGIN}/`)).toBe(INGEST_URL);
		expect(ingestUrlFor(`${ORIGIN}/een/pad?x=1#y`)).toBe(INGEST_URL);
		expect(ingestUrlFor('http://localhost:5173')).toBe('http://localhost:5173/api/ingest');
		expect(ingestUrlFor('https://ander.example.test:8443')).toBe(
			'https://ander.example.test:8443/api/ingest'
		);
	});

	it('ondertekenen alleen voor een https-origin zonder pad', () => {
		expect(signingUrl(ORIGIN)).toBe(INGEST_URL);
		expect(signingUrl(`${ORIGIN}/`)).toBe(INGEST_URL);
		expect(signingUrl('https://BUDGET.example.test:443')).toBe(INGEST_URL);
		for (const bad of [
			'http://budget.example.test',
			'http://localhost:5173',
			`${ORIGIN}/api/ingest`,
			`${ORIGIN}/budget`,
			`${ORIGIN}?x=1`,
			`${ORIGIN}#x`,
			'https://iemand:geheim@budget.example.test',
			'budget.example.test',
			''
		]) {
			expect(() => signingUrl(bad), bad).toThrow();
		}
	});
});
