import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	amountScore,
	dateScore,
	labelFor,
	nameScore,
	rankMatches,
	scoreMatch,
	type MatchTarget
} from './match.ts';

describe('bedrag (50%)', () => {
	it('exact is vol', () => {
		expect(amountScore(1500, 1500)).toBe(1);
		expect(amountScore(-1500, 1500)).toBe(1);
	});

	it('tot €1 of 2% verschil is gedeeltelijk, daarbuiten niets', () => {
		// €20: 2% is 40 cent, dus €1 is de marge
		expect(amountScore(2050, 2000)).toBeGreaterThan(0.5);
		expect(amountScore(2050, 2000)).toBeLessThan(1);
		expect(amountScore(2100, 2000)).toBeCloseTo(0.5);
		expect(amountScore(2101, 2000)).toBe(0);
		// €200: 2% is €4 (fooi)
		expect(amountScore(20400, 20000)).toBeCloseTo(0.5);
		expect(amountScore(20401, 20000)).toBe(0);
	});

	it('een lager bedrag: afwijking, deelbetaling of geen afwijking (retour)', () => {
		expect(amountScore(500, 2000)).toBe(0);
		expect(amountScore(500, 2000, { lower: 'deels' })).toBeCloseTo(0.125);
		// Iets minder, binnen de marge, telt als een fooiverschil en niet als deelbetaling
		expect(amountScore(1499, 1500, { lower: 'deels' })).toBeCloseTo(0.896);
		expect(amountScore(1499, 1500, { lower: 'deels' })).toBeGreaterThan(
			amountScore(1550, 1500, { lower: 'deels' })
		);
		expect(amountScore(500, 2000, { lower: 'vol' })).toBe(1);
		// Meer dan de post blijft een gewone afwijking
		expect(amountScore(3000, 2000, { lower: 'vol' })).toBe(0);
	});
});

describe('datum (30%)', () => {
	it('0 dagen vol, aflopend tot 0 bij 5 dagen', () => {
		expect(dateScore('2026-10-20', '2026-10-20')).toBe(1);
		expect(dateScore('2026-10-20', '2026-10-21')).toBeCloseTo(0.8);
		expect(dateScore('2026-10-25', '2026-10-20')).toBe(0);
		expect(dateScore('2026-10-20', '2026-11-20')).toBe(0);
	});
});

describe('naam (20%)', () => {
	it('gelijk na normaliseren is vol', () => {
		expect(nameScore('Albert Heijn', 'ALBERT HEIJN')).toBe(1);
		expect(nameScore('Café Zoë', 'cafe zoe')).toBe(1);
	});

	it('fuzzy: filiaalnummers, plaatsnamen en initialen', () => {
		expect(nameScore('AH 1234 UTRECHT', 'Albert Heijn')).toBeLessThan(0.5);
		expect(nameScore('AH', 'Albert Heijn')).toBe(0.8);
		expect(nameScore('ALBERT HEIJN 1403 UTRECHT', 'Albert Heijn')).toBe(0.9);
		expect(nameScore('tikkie sanne', 'Sanne')).toBe(0.9);
		expect(nameScore('Sanne', 'Tim')).toBeLessThan(0.3);
		expect(nameScore('', 'Tim')).toBe(0);
	});

	it('een bekende IBAN telt als volle score op naam', () => {
		const target = {
			id: 'x',
			amountCents: 2000,
			date: '2026-10-01',
			name: 'Sanne',
			ibans: ['NL91ABNA0417164300']
		};
		const s = scoreMatch(
			{
				amountCents: 2000,
				date: '2026-10-01',
				name: 'S. de Vries',
				iban: 'nl91 abna 0417 1643 00'
			},
			target
		);
		expect(s.parts.name).toBe(1);
		expect(s.score).toBe(1);
	});
});

describe('koppellijst', () => {
	const target = (id: string, amountCents: number, date: string, name: string): MatchTarget => ({
		id,
		amountCents,
		date,
		name
	});

	it('gewichten: bedrag 50%, datum 30%, naam 20%', () => {
		const q = { amountCents: 1000, date: '2026-10-20', name: 'Sanne' };
		expect(scoreMatch(q, target('a', 1000, '2026-10-20', 'Sanne')).score).toBe(1);
		expect(scoreMatch(q, target('a', 1000, '2026-11-20', 'Tim')).score).toBeCloseTo(0.5, 1);
		expect(scoreMatch(q, target('a', 9999, '2026-10-20', 'Tim')).score).toBeCloseTo(0.3, 1);
		expect(scoreMatch(q, target('a', 9999, '2026-12-20', 'Sanne')).score).toBe(0.2);
	});

	it('hoogstens vijf kandidaten, met label, beste eerst', () => {
		const targets = Array.from({ length: 8 }, (_, i) =>
			target(`t${i}`, 1000 + i * 1000, '2026-10-20', 'Winkel')
		);
		const { candidates } = rankMatches(
			{ amountCents: 1000, date: '2026-10-20', name: 'Winkel' },
			targets
		);
		expect(candidates).toHaveLength(5);
		expect(candidates[0]!.target.id).toBe('t0');
		expect(candidates[0]!.label).toBe('waarschijnlijk');
		expect(candidates[1]!.label).toBe('mogelijk');
		for (let i = 1; i < candidates.length; i++)
			expect(candidates[i - 1]!.score).toBeGreaterThanOrEqual(candidates[i]!.score);
	});

	it('voorselectie alleen boven 0,9 met 0,3 voorsprong', () => {
		const q = { amountCents: 1000, date: '2026-10-20', name: 'Sanne' };
		const clear = rankMatches(q, [
			target('a', 1000, '2026-10-20', 'Sanne'),
			target('b', 5000, '2026-10-19', 'Tim')
		]);
		expect(clear.preselect).toBe('a');
		// Te dicht bij elkaar: zelf kiezen
		const close = rankMatches(q, [
			target('a', 1000, '2026-10-20', 'Sanne'),
			target('b', 1000, '2026-10-20', 'Tim')
		]);
		expect(close.preselect).toBeNull();
		// Alleen, maar niet hoog genoeg
		expect(rankMatches(q, [target('a', 1000, '2026-10-24', 'Sanne')]).preselect).toBeNull();
		expect(rankMatches(q, []).preselect).toBeNull();
	});

	it('bij gelijke score blijft de volgorde van de invoer (oudste eerst)', () => {
		const { candidates } = rankMatches({ amountCents: 1000, date: '2026-10-20', name: 'x' }, [
			target('oud', 1000, '2026-10-20', 'Sanne'),
			target('nieuw', 1000, '2026-10-20', 'Tim')
		]);
		expect(candidates.map((c) => c.target.id)).toEqual(['oud', 'nieuw']);
	});

	it('labels', () => {
		expect(labelFor(0.95)).toBe('waarschijnlijk');
		expect(labelFor(0.5)).toBe('mogelijk');
		expect(labelFor(0.1)).toBe('onwaarschijnlijk');
	});

	it('score altijd tussen 0 en 1, wat je ook invoert', () => {
		const date = fc
			.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31'), noInvalidDate: true })
			.map((d) => d.toISOString().slice(0, 10));
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 100_000_000 }),
				fc.integer({ min: 0, max: 100_000_000 }),
				date,
				date,
				fc.string({ maxLength: 300 }),
				fc.string({ maxLength: 300 }),
				(a, b, d1, d2, n1, n2) => {
					const { score } = scoreMatch(
						{ amountCents: a, date: d1, name: n1 },
						target('x', b, d2, n2),
						{ lower: 'deels' }
					);
					expect(score).toBeGreaterThanOrEqual(0);
					expect(score).toBeLessThanOrEqual(1);
				}
			)
		);
	});
});
