import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	checkCorrection,
	correctionRoom,
	distributeCorrection,
	largestSplit,
	postEffect
} from './correction.ts';

describe('ruimte voor terugboekingen', () => {
	it('origineel min wat er al terugkwam', () => {
		expect(correctionRoom(-9000, [])).toBe(9000);
		expect(correctionRoom(-9000, [2500, 1500])).toBe(5000);
		expect(correctionRoom(-9000, [9000])).toBe(0);
	});

	it('werkt ook voor een storno van inkomend geld', () => {
		expect(correctionRoom(5000, [-2000])).toBe(3000);
	});
});

describe('een terugboeking controleren', () => {
	it('gedeeltelijk en meerdere keren mag', () => {
		expect(checkCorrection(-9000, 3000).ok).toBe(true);
		expect(checkCorrection(-9000, 3000, [3000, 3000]).ok).toBe(true);
	});

	it('samen meer dan het origineel wordt geweigerd', () => {
		expect(checkCorrection(-9000, 9001)).toMatchObject({ ok: false });
		expect(checkCorrection(-9000, 3001, [3000, 3000])).toMatchObject({ ok: false });
	});

	it('hetzelfde teken of nul is geen terugboeking', () => {
		expect(checkCorrection(-9000, -1000)).toMatchObject({ ok: false });
		expect(checkCorrection(-9000, 0)).toMatchObject({ ok: false });
		expect(checkCorrection(0, 1000)).toMatchObject({ ok: false });
	});
});

describe('naar verhouding verdelen', () => {
	it('voorbeeld uit de spec: €30 terug op €90 voor drie, elk deel €10 lager', () => {
		expect(distributeCorrection(3000, { mineCents: 3000, othersCents: [3000, 3000] })).toEqual({
			mine: 1000,
			others: [1000, 1000]
		});
	});

	it('aandelen van anderen naar beneden, de restcent naar jouw deel', () => {
		// €10 op €90 voor drie: anderen elk 333, jij 334
		expect(distributeCorrection(1000, { mineCents: 3000, othersCents: [3000, 3000] })).toEqual({
			mine: 334,
			others: [333, 333]
		});
	});

	it('ongelijke delen gaan naar verhouding', () => {
		// €20 op €100: jij 50, Sanne 30, Tim 20
		expect(distributeCorrection(2000, { mineCents: 5000, othersCents: [3000, 2000] })).toEqual({
			mine: 1000,
			others: [600, 400]
		});
	});

	it('past de restcent niet in jouw deel, dan gaat hij naar de anderen', () => {
		// Jouw deel is nul: alles naar de anderen, de restcent naar de eerste
		expect(distributeCorrection(33, { mineCents: 0, othersCents: [50, 50] })).toEqual({
			mine: 0,
			others: [17, 16]
		});
	});

	it('het hele bedrag terug maakt elk deel nul', () => {
		expect(distributeCorrection(9000, { mineCents: 3000, othersCents: [3000, 3000] })).toEqual({
			mine: 3000,
			others: [3000, 3000]
		});
	});

	it('zonder anderen gaat alles van jouw deel af', () => {
		expect(distributeCorrection(1500, { mineCents: 4500, othersCents: [] })).toEqual({
			mine: 1500,
			others: []
		});
	});

	it('meer dan de delen samen past niet', () => {
		expect(distributeCorrection(9001, { mineCents: 3000, othersCents: [3000, 3000] })).toBeNull();
	});

	it('grote bedragen rekenen zonder afrondfouten', () => {
		const r = distributeCorrection(99_999_999, {
			mineCents: 33_333_334,
			othersCents: [33_333_333, 33_333_333]
		})!;
		expect(r.mine + r.others[0]! + r.others[1]!).toBe(99_999_999);
		// De restcenten passen niet in jouw deel; de overgebleven cent gaat naar de eerste
		expect(r).toEqual({ mine: 33_333_334, others: [33_333_333, 33_333_332] });
	});
});

describe('alleen van mijn deel', () => {
	it('gaat helemaal van jouw deel af als het past', () => {
		expect(
			distributeCorrection(2000, { mineCents: 3000, othersCents: [3000, 3000] }, 'mijn_deel')
		).toEqual({ mine: 2000, others: [0, 0] });
	});

	it('jouw deel gaat niet onder nul; de rest naar verhouding over de anderen', () => {
		// €50 terug, jouw deel €30: €20 over Sanne (30) en Tim (30)
		expect(
			distributeCorrection(5000, { mineCents: 3000, othersCents: [3000, 3000] }, 'mijn_deel')
		).toEqual({ mine: 3000, others: [1000, 1000] });
	});

	it('restcenten één voor één naar de anderen in volgorde', () => {
		// €1 over drie anderen van gelijke grootte: 34, 33, 33
		expect(
			distributeCorrection(1100, { mineCents: 1000, othersCents: [500, 500, 500] }, 'mijn_deel')
		).toEqual({ mine: 1000, others: [34, 33, 33] });
	});

	it('meer dan de delen samen past niet', () => {
		expect(
			distributeCorrection(6001, { mineCents: 3000, othersCents: [3000] }, 'mijn_deel')
		).toBeNull();
	});
});

describe('eigenschappen van het verdelen', () => {
	const state = fc
		.tuple(
			fc.integer({ min: 0, max: 1_000_000 }),
			fc.array(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 6 })
		)
		.map(([mineCents, othersCents]) => ({ mineCents, othersCents }));

	it('samen precies het bedrag, en geen deel onder nul of boven zijn aandeel', () => {
		fc.assert(
			fc.property(
				state,
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.constantFrom('verhouding' as const, 'mijn_deel' as const),
				(s, f, mode) => {
					const total = s.mineCents + s.othersCents.reduce((a, b) => a + b, 0);
					const amount = Math.floor(total * f);
					const r = distributeCorrection(amount, s, mode);
					expect(r).not.toBeNull();
					expect(r!.mine + r!.others.reduce((a, b) => a + b, 0)).toBe(amount);
					expect(r!.mine).toBeGreaterThanOrEqual(0);
					expect(r!.mine).toBeLessThanOrEqual(s.mineCents);
					r!.others.forEach((c, i) => {
						expect(c).toBeGreaterThanOrEqual(0);
						expect(c).toBeLessThanOrEqual(s.othersCents[i]!);
					});
				}
			)
		);
	});

	it('naar verhouding: geen ander krijgt meer dan zijn eerlijke deel plus één cent', () => {
		fc.assert(
			fc.property(state, fc.double({ min: 0, max: 1, noNaN: true }), (s, f) => {
				const total = s.mineCents + s.othersCents.reduce((a, b) => a + b, 0);
				fc.pre(total > 0);
				const amount = Math.floor(total * f);
				const r = distributeCorrection(amount, s)!;
				r.others.forEach((c, i) => {
					expect(c).toBeLessThanOrEqual(Math.ceil((amount * s.othersCents[i]!) / total) + 1);
				});
			})
		);
	});
});

describe('effect op de post van een ander', () => {
	it('een lagere post blijft open voor de rest', () => {
		expect(postEffect(1000, 3000)).toEqual({ coverCents: 1000, payBackCents: 0 });
	});

	it('al meer betaald dan het nieuwe aandeel: het verschil wordt te betalen', () => {
		// Sanne betaalde €25 van €30; het aandeel wordt €20
		expect(postEffect(1000, 500)).toEqual({ coverCents: 500, payBackCents: 500 });
		// Alles al betaald
		expect(postEffect(1000, 0)).toEqual({ coverCents: 0, payBackCents: 1000 });
	});
});

describe('grootste deel van een verdeling', () => {
	it('kiest het grootste bedrag, bij gelijkspel het eerste', () => {
		const splits = [
			{ id: 'a', amountCents: -1000 },
			{ id: 'b', amountCents: -4000 },
			{ id: 'c', amountCents: -4000 }
		];
		expect(largestSplit(splits)?.id).toBe('b');
		expect(largestSplit([])).toBeNull();
	});
});
