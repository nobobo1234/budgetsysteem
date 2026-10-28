import { describe, expect, it } from 'vitest';
import { NO_FILTERS, type Query } from '../../semantic/format.ts';
import {
	aggregate,
	formatReport,
	pickVariant,
	scoreQuestion,
	TARGET_ACCURACY,
	type GoldQuestion
} from './eval.ts';

// Scoring van de vraag-eval: juist op de vragen die passen, terecht verduidelijkt of geweigerd,
// en nooit een getal bij een vraag die niet past.

const QUERY: Query = {
	maat: 'uitgegeven',
	periode: { woord: 'dit_jaar' },
	filters: NO_FILTERS,
	groeperen: 'geen',
	sorteren: 'bedrag_aflopend',
	limiet: null,
	aannames: []
};

const FITS: GoldQuestion = {
	id: 'past',
	vraag: 'Hoeveel dit jaar?',
	verwacht: { soort: 'vraag', query: QUERY, waarde: 1000, ook: [{ query: QUERY, waarde: 900 }] }
};
const GROUPED: GoldQuestion = {
	id: 'lijst',
	vraag: 'Waar het meest?',
	verwacht: {
		soort: 'vraag',
		query: QUERY,
		waarde: 1000,
		rijen: [
			['Wonen', 800],
			['Boodschappen', 200]
		]
	}
};
const AMBIGUOUS: GoldQuestion = {
	id: 'dubbel',
	vraag: 'Aan eten?',
	verwacht: { soort: 'verduidelijken' }
};
const OUTSIDE: GoldQuestion = { id: 'past-niet', vraag: 'Saldo?', verwacht: { soort: 'kan_niet' } };
const usage = { durationMs: 800, costNanoUsd: 300_000 };

describe('één vraag scoren', () => {
	it('dezelfde uitkomst, of een andere goede lezing', () => {
		const ok = (value: number) =>
			scoreQuestion(FITS, { kind: 'beantwoord', value, rows: null }, usage).correct;
		expect(ok(1000)).toBe(true);
		expect(ok(900)).toBe(true);
		expect(ok(999)).toBe(false);
		expect(scoreQuestion(FITS, { kind: 'kan_niet' }, usage).correct).toBe(false);
	});

	it('bij een lijst tellen ook de eerste rijen, ook als het model er minder vroeg', () => {
		const score = (rows: [string, number][]) =>
			scoreQuestion(GROUPED, { kind: 'beantwoord', value: 1000, rows }, usage).correct;
		expect(score([['Wonen', 800]])).toBe(true);
		expect(score([['Boodschappen', 200]])).toBe(false);
	});

	it('een getal bij een vraag die niet past, is het ergste', () => {
		const r = scoreQuestion(OUTSIDE, { kind: 'beantwoord', value: 5, rows: null }, usage);
		expect(r).toMatchObject({ correct: false, numberWhereNone: true });
		expect(scoreQuestion(OUTSIDE, { kind: 'verduidelijken' }, usage).correct).toBe(true);
		expect(
			scoreQuestion(OUTSIDE, { kind: 'mislukt', outcome: 'ongeldig' }, usage).numberWhereNone
		).toBe(false);
	});

	it('dubbelzinnig: alleen een verduidelijking is goed', () => {
		expect(scoreQuestion(AMBIGUOUS, { kind: 'verduidelijken' }, usage).correct).toBe(true);
		expect(
			scoreQuestion(AMBIGUOUS, { kind: 'beantwoord', value: 1, rows: null }, usage).correct
		).toBe(false);
	});
});

describe('per variant', () => {
	const right = scoreQuestion(FITS, { kind: 'beantwoord', value: 1000, rows: null }, usage);
	const wrong = scoreQuestion(FITS, { kind: 'mislukt', outcome: 'afgekapt' }, usage);
	const refused = scoreQuestion(OUTSIDE, { kind: 'kan_niet' }, usage);

	it('het doel: minstens 95% juist en geen getal waar het niet past', () => {
		const pass = aggregate('haiku', [...Array(19).fill(right), wrong, refused]);
		expect(pass.inFormat).toEqual({ correct: 19, total: 20, accuracy: 0.95 });
		expect(pass.inFormat.accuracy).toBeGreaterThanOrEqual(TARGET_ACCURACY);
		expect(pass.passes).toBe(true);
		expect(pass.failures).toEqual({ afgekapt: 1 });
		expect(pass.costPer100NanoUsd).toBe(30_000_000);

		const leak = scoreQuestion(OUTSIDE, { kind: 'beantwoord', value: 5, rows: null }, usage);
		expect(aggregate('lek', [...Array(20).fill(right), leak]).passes).toBe(false);
		expect(aggregate('te-weinig', [...Array(18).fill(right), wrong, wrong]).passes).toBe(false);
	});

	it('de snelste variant die het doel haalt', () => {
		const fast = { ...right, durationMs: 400 };
		const slow = { ...right, durationMs: 2000 };
		const reports = [
			aggregate('haiku', [fast, wrong, wrong]),
			aggregate('haiku-high', [slow]),
			aggregate('sonnet', [{ ...right, durationMs: 1500 }])
		];
		expect(pickVariant(reports)?.variant).toBe('sonnet');
		expect(formatReport(reports)).toContain('Snelste variant die het doel haalt: sonnet');
		expect(pickVariant([aggregate('haiku', [wrong])])).toBeNull();
		expect(formatReport([aggregate('haiku', [wrong])])).toContain('Opus 5.5');
	});
});
