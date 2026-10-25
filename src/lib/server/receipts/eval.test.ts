import { describe, expect, it } from 'vitest';
import { checkReceipt } from './checks.ts';
import {
	aggregate,
	formatReport,
	LabelFileSchema,
	labelId,
	normalizeStore,
	scoreBon,
	storeMatches,
	uploadMoment,
	zekerPrecision,
	type BonResult,
	type Label
} from './eval.ts';
import { field, receiptOutput } from './fixtures.ts';
import type { ReadUsage } from './reader.ts';

// Verzonnen labels; echte bonnen en labels staan buiten de repo.

const label = (overrides: Partial<Label> = {}): Label =>
	LabelFileSchema.parse({
		bonnen: [
			{
				bestanden: ['bon-01.jpg'],
				winkel: 'Supermarkt Voorbeeld',
				datum: '2026-10-20',
				totaal: '7,37',
				betaalwijze: 'pin',
				...overrides
			}
		]
	}).bonnen[0]!;

const usage: ReadUsage = {
	model: 'claude-haiku-5-5',
	parts: 1,
	inputTokens: 3000,
	outputTokens: 400,
	costNanoUsd: 500_000,
	durationMs: 1200
};

function score(l: Label, output = receiptOutput()): BonResult {
	return scoreBon(l, '2576', { ok: true, checked: checkReceipt(output, uploadMoment(l)), usage });
}

describe('labels.json', () => {
	it('vult valuta aan en leidt id en uploadmoment af', () => {
		const l = label();
		expect(l.valuta).toBe('EUR');
		expect(labelId(l)).toBe('bon-01');
		expect(labelId(label({ id: 'ah-bonus' }))).toBe('ah-bonus');
		expect(uploadMoment(l)).toEqual(new Date(2026, 9, 21, 12));
		expect(uploadMoment(label({ ontvangen: '2026-10-25' }))).toEqual(new Date(2026, 9, 25, 12));
	});

	it('accepteert alleen bestandsnamen, geen paden', () => {
		for (const bad of [
			'../bon.jpg',
			'map/bon.jpg',
			'/etc/passwd.jpg',
			'.verborgen.jpg',
			'bon.heic'
		]) {
			expect(() => label({ bestanden: [bad] }), bad).toThrow();
		}
	});

	it('weigert ongeldige datums, bedragen en onbekende velden', () => {
		expect(() => label({ datum: '20-10-2026' })).toThrow();
		expect(() => label({ totaal: '7.37.1' })).toThrow();
		expect(() => label({ totaal: '0' })).toThrow();
		expect(() => LabelFileSchema.parse({ bonnen: [{ ...label(), extra: true }] })).toThrow();
	});
});

describe('storeMatches', () => {
	it('negeert hoofdletters, accenten, leestekens en rechtsvorm', () => {
		expect(normalizeStore('Café Één B.V.')).toBe('cafeeen');
		expect(storeMatches('Café Één', 'CAFE EEN BV')).toBe(true);
	});

	it('accepteert een filiaalnummer erachter en een lijst namen', () => {
		expect(storeMatches('Supermarkt Voorbeeld', 'SUPERMARKT VOORBEELD 0001')).toBe(true);
		expect(storeMatches(['SV', 'Supermarkt Voorbeeld'], 'Supermarkt Voorbeeld')).toBe(true);
	});

	it('laat korte namen niet in andere namen matchen', () => {
		expect(storeMatches('SV', 'SV Bakkerij')).toBe(false);
		expect(storeMatches('Bakker', '')).toBe(false);
		expect(storeMatches('Bakkerij Test', 'Slagerij Test')).toBe(false);
	});
});

describe('scoreBon', () => {
	it('vergelijkt elk veld met het label', () => {
		const r = score(label());
		expect(r.outcome).toBe('zeker');
		expect(r.fields.totaal).toEqual({
			labeled: true,
			filled: true,
			correct: true,
			status: 'zeker'
		});
		expect(r.fields.winkel?.correct).toBe(true);
		expect(r.fields.datum?.correct).toBe(true);
		expect(r.fields.valuta?.correct).toBe(true);
		expect(r.fields.betaalwijze?.correct).toBe(true);
	});

	it('ziet een fout totaal dat de controles toch doorkomt', () => {
		const r = score(label({ totaal: '7,73' }));
		expect(r.fields.totaal).toMatchObject({ correct: false, status: 'zeker' });
	});

	it('telt een leeg veld als niet gevuld en niet goed', () => {
		const r = score(label(), receiptOutput({ datum: field('', 'onleesbaar') }));
		expect(r.fields.datum).toMatchObject({ filled: false, correct: false, status: 'onzeker' });
	});

	it('slaat betaalwijze over als die niet gelabeld is', () => {
		const r = score(label({ betaalwijze: undefined }));
		expect(r.fields.betaalwijze?.labeled).toBe(false);
	});

	it('neemt een mislukte lezing op zonder velden', () => {
		const r = scoreBon(label(), '1600', { ok: false, reason: 'weigering', usage });
		expect(r).toMatchObject({ outcome: 'weigering', fields: {}, variant: '1600' });
	});
});

describe('aggregate', () => {
	const results = [
		score(label({ id: 'a' })),
		score(label({ id: 'b', totaal: '7,73' })), // zeker maar fout
		score(label({ id: 'c' }), receiptOutput({ totaal: field('7.37', 'twijfel') })),
		scoreBon(label({ id: 'd' }), '2576', { ok: false, reason: 'fout', usage: null })
	];
	const report = aggregate('2576', results);

	it('telt uitkomsten, mislukte lezingen en "zeker maar fout"', () => {
		expect(report.bonnen).toBe(4);
		expect(report.failed).toBe(1);
		expect(report.outcomes).toEqual({ zeker: 2, controleren: 1, onzeker: 0 });
		expect(report.outcomeZekerWrong).toBe(1);
		expect(report.zekerWrongIds).toEqual([{ id: 'b', field: 'totaal' }]);
	});

	it('meet per veld goed, gevuld en de nauwkeurigheid bij zeker', () => {
		expect(report.fields.totaal).toEqual({
			total: 4,
			correct: 2,
			filled: 3,
			zeker: 2,
			zekerWrong: 1,
			controleren: 1,
			onzeker: 1
		});
		expect(zekerPrecision(report.fields.totaal)).toBe(0.5);
		expect(report.fields.betaalwijze.total).toBe(3);
	});

	it('telt tokens, kosten en de mediane duur van de geslaagde aanroepen', () => {
		expect(report.inputTokens).toBe(9000);
		expect(report.costNanoUsd).toBe(1_500_000);
		expect(report.durationMsP50).toBe(1200);
	});

	it('geeft geen nauwkeurigheid als niets zeker was', () => {
		expect(zekerPrecision(aggregate('1600', []).fields.totaal)).toBeNull();
	});

	it('toont het doel en geen bedragen of winkelnamen in het rapport', () => {
		const text = formatReport([report]);
		expect(text).toContain('Variant 2576: 4 bonnen, 1 mislukt');
		expect(text).toContain('doel NIET gehaald');
		expect(text).toContain('b (totaal)');
		expect(text).not.toMatch(/7[.,]73|7[.,]37|Supermarkt/);
		const good = formatReport([aggregate('2576', [results[0]!])]);
		expect(good).toContain('doel gehaald');
	});
});
