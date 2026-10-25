import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	allocatePayment,
	daysBetween,
	formatOpenFor,
	owedStatus,
	remindProgress,
	reminderText,
	splitByAmounts,
	splitEqually
} from './owed.ts';

describe('gelijk verdelen', () => {
	it('voorbeeld uit de spec: €10 voor 3 met Sanne en Tim', () => {
		expect(splitEqually(1000, 3)).toEqual({ mine: 333, others: [334, 333] });
	});

	it('restcenten één voor één in genoemde volgorde', () => {
		// 1001 over 4: jij 250, rest 751 over 3 = 250 met 1 restcent
		expect(splitEqually(1001, 4)).toEqual({ mine: 250, others: [251, 250, 250] });
		// 1003 over 4: jij 250, rest 753 over 3 = 251 zonder rest
		expect(splitEqually(1003, 4)).toEqual({ mine: 250, others: [251, 251, 251] });
		// 5 cent over 4: jij 1, rest 4 over 3
		expect(splitEqually(5, 4)).toEqual({ mine: 1, others: [2, 1, 1] });
	});

	it('voor 3 met €45: iedereen 15', () => {
		expect(splitEqually(4500, 3)).toEqual({ mine: 1500, others: [1500, 1500] });
	});

	it('kleine bedragen: jouw deel kan nul zijn', () => {
		expect(splitEqually(2, 3)).toEqual({ mine: 0, others: [1, 1] });
	});

	it('weigert onzin', () => {
		expect(() => splitEqually(-1, 2)).toThrow(RangeError);
		expect(() => splitEqually(100, 0)).toThrow(RangeError);
		expect(() => splitEqually(1.5, 2)).toThrow(RangeError);
	});

	it('samen altijd precies het totaal; jouw deel naar beneden afgerond', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 100_000_000 }),
				fc.integer({ min: 1, max: 50 }),
				(total, n) => {
					const { mine, others } = splitEqually(total, n);
					expect(others).toHaveLength(n - 1);
					expect(mine + others.reduce((s, x) => s + x, 0)).toBe(total);
					expect(mine).toBe(Math.floor(total / n));
					// De anderen verschillen hooguit één cent, de grotere vooraan
					for (let i = 1; i < others.length; i++) {
						expect(others[i - 1]! - others[i]!).toBeGreaterThanOrEqual(0);
						expect(others[0]! - others[i]!).toBeLessThanOrEqual(1);
					}
				}
			)
		);
	});
});

describe('bedrag per persoon', () => {
	it('jouw deel is wat overblijft', () => {
		expect(splitByAmounts(4500, [2000, 1000])).toEqual({
			ok: true,
			share: { mine: 1500, others: [2000, 1000] }
		});
	});

	it('jouw deel mag nul zijn', () => {
		expect(splitByAmounts(3000, [1500, 1500])).toEqual({
			ok: true,
			share: { mine: 0, others: [1500, 1500] }
		});
	});

	it('samen meer dan het totaal wordt geweigerd', () => {
		expect(splitByAmounts(3000, [2000, 1001])).toEqual({
			ok: false,
			reason: 'Samen meer dan het totaal'
		});
	});

	it('nul, negatief, gebroken of geen enkel bedrag wordt geweigerd', () => {
		expect(splitByAmounts(3000, [0]).ok).toBe(false);
		expect(splitByAmounts(3000, [-100]).ok).toBe(false);
		expect(splitByAmounts(3000, [10.5]).ok).toBe(false);
		expect(splitByAmounts(3000, []).ok).toBe(false);
	});
});

describe('toewijzen: oudste eerst, rest is tegoed', () => {
	const items = [
		{ id: 'jan', outstandingCents: 2000 },
		{ id: 'feb', outstandingCents: 2000 },
		{ id: 'mrt', outstandingCents: 2000 }
	];

	it('precies één post', () => {
		expect(allocatePayment(2000, items)).toEqual({
			allocations: [{ id: 'jan', cents: 2000 }],
			creditCents: 0
		});
	});

	it('een deelbetaling laat de rest open', () => {
		expect(allocatePayment(500, items)).toEqual({
			allocations: [{ id: 'jan', cents: 500 }],
			creditCents: 0
		});
	});

	it('één betaling dekt meer posten', () => {
		expect(allocatePayment(5000, items)).toEqual({
			allocations: [
				{ id: 'jan', cents: 2000 },
				{ id: 'feb', cents: 2000 },
				{ id: 'mrt', cents: 1000 }
			],
			creditCents: 0
		});
	});

	it('meer dan er openstaat wordt tegoed', () => {
		expect(allocatePayment(7000, items).creditCents).toBe(1000);
		expect(allocatePayment(1500, [])).toEqual({ allocations: [], creditCents: 1500 });
	});

	it('slaat posten zonder openstaand bedrag over', () => {
		expect(allocatePayment(100, [{ id: 'x', outstandingCents: 0 }, ...items]).allocations).toEqual([
			{ id: 'jan', cents: 100 }
		]);
	});

	it('nooit meer toegewezen dan betaald of dan er openstaat', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1_000_000 }),
				fc.array(fc.integer({ min: 0, max: 100_000 }), { maxLength: 20 }),
				(amount, outstanding) => {
					const list = outstanding.map((o, i) => ({ id: String(i), outstandingCents: o }));
					const { allocations, creditCents } = allocatePayment(amount, list);
					const sum = allocations.reduce((s, a) => s + a.cents, 0);
					expect(sum + creditCents).toBe(amount);
					expect(creditCents).toBeGreaterThanOrEqual(0);
					for (const a of allocations) {
						expect(a.cents).toBeGreaterThan(0);
						expect(a.cents).toBeLessThanOrEqual(list[Number(a.id)]!.outstandingCents);
					}
					// Tegoed alleen als alles betaald is
					if (creditCents > 0) expect(sum).toBe(outstanding.reduce((s, o) => s + o, 0));
				}
			)
		);
	});
});

describe('status en duur', () => {
	it('status volgt uit wat betaald is', () => {
		expect(owedStatus(1500, 0)).toBe('open');
		expect(owedStatus(1500, 500)).toBe('deels');
		expect(owedStatus(1500, 1500)).toBe('betaald');
		expect(owedStatus(1500, 2000)).toBe('betaald');
		expect(owedStatus(1500, 0, true)).toBe('kwijtgescholden');
	});

	it('dagen tussen datums, ook over de zomertijd heen', () => {
		expect(daysBetween('2026-10-20', '2026-10-23')).toBe(3);
		expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
		expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
		expect(daysBetween('2026-10-23', '2026-10-20')).toBe(-3);
	});

	it('hoe lang open, in gewone taal', () => {
		expect(formatOpenFor(0)).toBe('vandaag');
		expect(formatOpenFor(1)).toBe('1 dag');
		expect(formatOpenFor(13)).toBe('13 dagen');
		expect(formatOpenFor(14)).toBe('2 weken');
		expect(formatOpenFor(45)).toBe('6 weken');
		expect(formatOpenFor(65)).toBe('2 maanden');
	});
});

describe('herinneren', () => {
	const euro = (c: number) => `€ ${(c / 100).toFixed(2).replace('.', ',')}`;

	it('de kleur verloopt in 14 dagen naar de herinnering', () => {
		expect(remindProgress(0)).toBe(0);
		expect(remindProgress(7)).toBe(0.5);
		expect(remindProgress(14)).toBe(1);
		expect(remindProgress(40)).toBe(1);
		expect(remindProgress(-2)).toBe(0);
	});

	it('één zin met het totaal, waarvoor en een Tikkie-link als die er is', () => {
		expect(
			reminderText(
				'Sanne',
				[
					{ description: 'Etentje', outstandingCents: 1500, tikkieUrl: null },
					{ description: 'Bioscoop', outstandingCents: 920, tikkieUrl: 'https://tikkie.me/x' }
				],
				euro
			)
		).toBe(
			'Hoi Sanne, je moet me nog € 24,20 voor Etentje en Bioscoop. Tikkie: https://tikkie.me/x'
		);
	});

	it('zonder omschrijving geen lege "voor"', () => {
		expect(
			reminderText('Tim', [{ description: ' ', outstandingCents: 333, tikkieUrl: null }], euro)
		).toBe('Hoi Tim, je moet me nog € 3,33.');
	});
});
