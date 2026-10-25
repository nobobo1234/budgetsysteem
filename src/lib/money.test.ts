import { describe, expect, it } from 'vitest';
import {
	centsToInput,
	formatCents,
	MAX_CENTS,
	parseAmount,
	parseDecimal,
	parseSignedAmount
} from './money.ts';

describe('parseAmount', () => {
	it.each([
		['12', 1200],
		['12,5', 1250],
		['12,50', 1250],
		['12.50', 1250],
		['0,01', 1],
		['1.234', 123400],
		['1.234,56', 123456],
		['123.456', 12345600],
		['1.000.000', 100000000],
		['999999', 99999900]
	])('%s wordt %i cent', (input, cents) => {
		expect(parseAmount(input)).toBe(cents);
	});

	// Dubbelzinnig of geen bedrag: weigeren in plaats van raden
	it.each([
		'',
		'abc',
		'12,345',
		'1,234.56',
		'1,2,3',
		'12.5.0',
		'-12',
		'+12',
		'12,',
		',50',
		'1e3',
		'0x10',
		'12 50',
		'١٢',
		'12,505',
		'Infinity'
	])('weigert %j', (input) => {
		expect(parseAmount(input)).toBeNull();
	});

	it('weigert bedragen boven het maximum', () => {
		expect(parseAmount('1000001')).toBeNull();
		expect(parseAmount('12.345.678')).toBeNull();
		expect(parseAmount('1000000')).toBe(MAX_CENTS);
	});

	it('weigert lange invoer zonder te parsen', () => {
		expect(parseAmount('1'.repeat(17))).toBeNull();
	});
});

describe('parseSignedAmount', () => {
	it.each([
		['1.234,56', 123456],
		['-12,50', -1250],
		['−12,50', -1250],
		['- 3', -300],
		[' 0 ', 0],
		['-0', 0]
	])('%s wordt %i cent', (input, cents) => {
		expect(parseSignedAmount(input)).toBe(cents);
	});

	it.each(['', '-', '--5', '+5', '12,345', '5-', '1e3'])('weigert %s', (input) => {
		expect(parseSignedAmount(input)).toBeNull();
	});
});

describe('parseDecimal', () => {
	it.each([
		['238.45', 23845],
		['-43.90', -4390],
		['0.5', 50],
		['1250', 125000],
		[' 12.00 ', 1200]
	])('%s wordt %i cent', (input, cents) => {
		expect(parseDecimal(input)).toBe(cents);
	});

	it.each(['12,50', '1.234.56', '--1', '12.345', 'NaN', ''])('weigert %j', (input) => {
		expect(parseDecimal(input)).toBeNull();
	});
});

describe('formatCents', () => {
	// Intl zet een harde spatie tussen € en het bedrag; voor de vergelijking maakt dat niet uit
	const f = (...args: Parameters<typeof formatCents>) => formatCents(...args).replace(/\s/g, ' ');

	it('formatteert als euro met een echt minteken', () => {
		expect(f(1250)).toBe('€ 12,50');
		expect(f(-1250)).toBe('−€ 12,50');
		expect(f(1250, { sign: true })).toBe('+€ 12,50');
		expect(f(123456, { whole: true })).toBe('€ 1.235');
	});
});

describe('centsToInput', () => {
	it('schrijft een bedrag voor een invoerveld', () => {
		expect(centsToInput(1250)).toBe('12,50');
		expect(centsToInput(-5)).toBe('0,05');
	});
});
