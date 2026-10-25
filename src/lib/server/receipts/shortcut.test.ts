import { describe, expect, it } from 'vitest';
import {
	INGEST_URL,
	JPEG_QUALITY,
	MAX_EDGE,
	RENEW_DAYS,
	shortcutDefinition,
	shortcutJson,
	shortcutSourceHash,
	shortcutStatus
} from './shortcut.ts';
import { SIGNED_SHORTCUT } from './shortcut-signed.ts';

type Dict = Record<string, unknown>;

const definition = shortcutDefinition() as Dict;
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
		expect(shortcutJson()).not.toMatch(/bon_[A-Za-z0-9_-]{20,}/);
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

	it('het ondertekende bestand hoort bij deze definitie', () => {
		// Faalt dit, draai dan `node scripts/sign-shortcut.ts` op een Mac (docs/ios-opdracht.md)
		expect(SIGNED_SHORTCUT.url).toBe(INGEST_URL);
		expect(SIGNED_SHORTCUT.sourceHash).toBe(shortcutSourceHash());
		const bytes = Buffer.from(SIGNED_SHORTCUT.base64, 'base64');
		expect(bytes.subarray(0, 4).toString('latin1')).toBe('AEA1');
	});
});

describe('status van de opdracht', () => {
	const signed = { url: INGEST_URL, validUntil: '2027-11-16' };
	const origin = 'https://finance.mijndomein.nl';
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
			'http://finance.mijndomein.nl',
			'https://finance.mijndomein.nl:8443'
		]) {
			expect(shortcutStatus(signed, other, now)).toEqual({
				state: 'other-host',
				validUntil: '2027-11-16',
				host: 'finance.mijndomein.nl'
			});
		}
		// Een pad of slash aan het eind van ORIGIN maakt niet uit
		expect(shortcutStatus(signed, `${origin}/`, now).state).toBe('ok');
	});
});
