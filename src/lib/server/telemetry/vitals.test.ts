import { describe, expect, it } from 'vitest';
import { p75, rate, vitalsBody, weekStart, weeklyP75 } from './vitals.ts';

describe('p75', () => {
	it('geeft null zonder metingen', () => {
		expect(p75([])).toBeNull();
	});

	it('is bij één meting die meting', () => {
		expect(p75([420])).toBe(420);
	});

	it('neemt de nearest-rank: de waarde waar 75% van de metingen onder of op valt', () => {
		expect(p75([1, 2, 3, 4])).toBe(3);
		expect(p75([1, 2, 3, 4, 5])).toBe(4);
		expect(p75(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(75);
		expect(p75(Array.from({ length: 101 }, (_, i) => i + 1))).toBe(76);
	});

	it('sorteert zelf en laat de invoer ongemoeid', () => {
		const values = [900, 100, 500, 300];
		expect(p75(values)).toBe(500);
		expect(values).toEqual([900, 100, 500, 300]);
	});

	it('een paar uitschieters trekken p75 niet omhoog', () => {
		expect(p75([...Array.from({ length: 9 }, () => 100), 60_000])).toBe(100);
	});
});

describe('rate', () => {
	it('volgt de grenzen van web.dev', () => {
		expect(rate('INP', 200)).toBe('goed');
		expect(rate('INP', 201)).toBe('matig');
		expect(rate('INP', 501)).toBe('slecht');
		expect(rate('LCP', 2500)).toBe('goed');
		expect(rate('LCP', 4000)).toBe('matig');
		expect(rate('LCP', 4001)).toBe('slecht');
		expect(rate('CLS', 0.1)).toBe('goed');
		expect(rate('CLS', 0.26)).toBe('slecht');
	});
});

describe('weekStart', () => {
	it('is de maandag van de week', () => {
		// zaterdag 24 oktober 2026
		expect(weekStart(new Date(2026, 9, 24, 12))).toBe('2026-10-19');
		expect(weekStart(new Date(2026, 9, 19, 0, 5))).toBe('2026-10-19');
		// zondag hoort bij de week ervoor
		expect(weekStart(new Date(2026, 9, 25, 23, 59))).toBe('2026-10-19');
		// over de jaargrens
		expect(weekStart(new Date(2027, 0, 1, 12))).toBe('2026-12-28');
	});
});

describe('weeklyP75', () => {
	const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString();

	it('groepeert per week en per meting, nieuwste week eerst', () => {
		const rows = [
			{ at: at(2026, 10, 12), name: 'INP' as const, value: 80 },
			{ at: at(2026, 10, 19), name: 'INP' as const, value: 40 },
			{ at: at(2026, 10, 20), name: 'INP' as const, value: 120 },
			{ at: at(2026, 10, 21), name: 'INP' as const, value: 60 },
			{ at: at(2026, 10, 22), name: 'INP' as const, value: 600 },
			{ at: at(2026, 10, 22), name: 'LCP' as const, value: 1800 }
		];
		expect(weeklyP75(rows)).toEqual([
			{
				weekStart: '2026-10-19',
				metrics: {
					INP: { p75: 120, count: 4, rating: 'goed' },
					LCP: { p75: 1800, count: 1, rating: 'goed' }
				}
			},
			{ weekStart: '2026-10-12', metrics: { INP: { p75: 80, count: 1, rating: 'goed' } } }
		]);
	});

	it('zonder metingen een lege lijst', () => {
		expect(weeklyP75([])).toEqual([]);
	});
});

describe('vitalsBody', () => {
	const ok = (metrics: unknown) => vitalsBody.safeParse({ metrics }).success;

	it('accepteert gewone metingen', () => {
		expect(
			ok([
				{ name: 'LCP', value: 1234.5 },
				{ name: 'INP', value: 0 },
				{ name: 'CLS', value: 0.0123 },
				{ name: 'FCP', value: 800 },
				{ name: 'TTFB', value: 0 }
			])
		).toBe(true);
	});

	it('weigert onzin-waarden', () => {
		expect(ok([{ name: 'LCP', value: 0 }])).toBe(false);
		expect(ok([{ name: 'LCP', value: -1 }])).toBe(false);
		expect(ok([{ name: 'INP', value: 60_001 }])).toBe(false);
		expect(ok([{ name: 'CLS', value: 11 }])).toBe(false);
		expect(ok([{ name: 'INP', value: Number.NaN }])).toBe(false);
		expect(ok([{ name: 'INP', value: Number.POSITIVE_INFINITY }])).toBe(false);
		expect(ok([{ name: 'INP', value: '100' }])).toBe(false);
	});

	it('weigert onbekende metingen en extra velden', () => {
		expect(ok([{ name: 'FID', value: 10 }])).toBe(false);
		expect(ok([{ name: 'INP', value: 10, url: '/transacties' }])).toBe(false);
		expect(vitalsBody.safeParse({ metrics: [{ name: 'INP', value: 1 }], id: 'x' }).success).toBe(
			false
		);
	});

	it('weigert een lege of te grote batch', () => {
		expect(ok([])).toBe(false);
		expect(ok(Array.from({ length: 11 }, () => ({ name: 'INP', value: 1 })))).toBe(false);
		expect(ok(Array.from({ length: 10 }, () => ({ name: 'INP', value: 1 })))).toBe(true);
	});
});
