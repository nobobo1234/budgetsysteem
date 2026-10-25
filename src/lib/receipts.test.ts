import { describe, expect, it } from 'vitest';
import { formatCents } from './money.ts';
import { MAX_EDGE, scaledSize } from './receipt-upload.ts';
import { fieldList, needsYou, receiptAmount, stageSentence } from './receipts.ts';

describe('scaledSize', () => {
	it('schaalt de lange kant naar hooguit 2576 px met dezelfde verhouding', () => {
		expect(MAX_EDGE).toBe(2576);
		expect(scaledSize(4032, 3024)).toEqual({ width: 2576, height: 1932 });
		expect(scaledSize(3024, 4032)).toEqual({ width: 1932, height: 2576 });
		// Een lange bon: de lange kant bepaalt
		expect(scaledSize(1000, 6000)).toEqual({ width: 429, height: 2576 });
	});

	it('vergroot nooit en weigert onzin', () => {
		expect(scaledSize(1170, 2532)).toEqual({ width: 1170, height: 2532 });
		expect(scaledSize(1, 1)).toEqual({ width: 1, height: 1 });
		expect(() => scaledSize(0, 100)).toThrow(RangeError);
		expect(() => scaledSize(Number.NaN, 100)).toThrow(RangeError);
	});
});

describe('teksten voor bonnen', () => {
	it('noemt de velden met twijfel als zin', () => {
		expect(fieldList([])).toBe('');
		expect(fieldList(['datum'])).toBe('de datum');
		expect(fieldList(['datum', 'totaal'])).toBe('de datum en het totaal');
		expect(fieldList(['winkel', 'datum', 'totaal'])).toBe('de winkel, de datum en het totaal');
	});

	it('toont euro als bedrag en vreemde valuta met de code', () => {
		expect(receiptAmount(737, 'EUR')).toBe(formatCents(737));
		expect(receiptAmount(737, null)).toBe(formatCents(737));
		expect(receiptAmount(2000, 'USD')).toBe('USD 20,00');
		expect(receiptAmount(null, 'EUR')).toBe('');
	});

	it('zegt per stand wat er is en wat je kunt doen', () => {
		expect(stageSentence('onzeker', ['totaal'])).toBe(
			'Haiku twijfelt over het totaal. Kijk het na en verwerk hem.'
		);
		expect(stageSentence('nakijken', ['datum'])).toContain('twijfelde over de datum');
		expect(stageSentence('fout', [])).toContain('opnieuw');
		expect(needsYou('klaar')).toBe(false);
		expect(needsYou('wordt_gelezen')).toBe(false);
		expect(needsYou('kiezen')).toBe(true);
	});
});
