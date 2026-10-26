import { describe, expect, it } from 'vitest';
import { formatCents } from './money.ts';
import { MAX_EDGE, scaledSize } from './receipt-upload.ts';
import {
	fieldList,
	itemCountText,
	itemFieldList,
	needsYou,
	receiptAmount,
	signedAmount,
	stageSentence,
	STAGE_TEXT
} from './receipts.ts';

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

describe('teksten voor een screenshot met transacties', () => {
	it('bedrag met teken, ook in vreemde valuta', () => {
		expect(signedAmount(-2345, 'EUR')).toBe(formatCents(-2345));
		expect(signedAmount(215000, 'EUR')).toBe(formatCents(215000, { sign: true }));
		expect(signedAmount(-650, 'USD')).toBe('−USD 6,50');
		expect(signedAmount(1200, 'GBP')).toBe('+GBP 12,00');
	});

	it('telt transacties en noemt velden met twijfel', () => {
		expect(itemCountText(1)).toBe('1 transactie');
		expect(itemCountText(4)).toBe('4 transacties');
		expect(itemFieldList(['bedrag'])).toBe('het bedrag');
		expect(itemFieldList(['datum', 'tegenpartij', 'valuta'])).toBe(
			'de datum, de naam en de valuta'
		);
	});

	it('een lijst vraagt iets van je', () => {
		expect(STAGE_TEXT.lijst).toBe('Lijst bevestigen');
		expect(needsYou('lijst')).toBe(true);
		expect(stageSentence('lijst', [])).toContain('er is nog niets geboekt');
	});
});
