import { describe, expect, it } from 'vitest';
import { formatCents } from './money.ts';
import {
	autoTagChanges,
	covers,
	formatPeriod,
	nextHue,
	periodDays,
	TAG_HUES,
	tagSegments,
	tagSentence,
	tagSpend,
	tagState,
	type TagLine
} from './tags.ts';

// Intl zet een vaste spatie na het euroteken
const euro = (cents: number) => formatCents(cents, { whole: true });

const lissabon = { id: 'lis', startDate: '2026-10-12', endDate: '2026-10-19' };
const zweden = { id: 'zwe', startDate: '2026-08-20', endDate: null };

describe('periode', () => {
	it('dekt begin- en einddatum en alles ertussen', () => {
		expect(covers(lissabon, '2026-10-12')).toBe(true);
		expect(covers(lissabon, '2026-10-15')).toBe(true);
		expect(covers(lissabon, '2026-10-19')).toBe(true);
	});

	it('dekt niets ervoor of erna', () => {
		expect(covers(lissabon, '2026-10-11')).toBe(false);
		expect(covers(lissabon, '2026-10-20')).toBe(false);
	});

	it('zonder einde loopt hij door', () => {
		expect(covers(zweden, '2026-08-19')).toBe(false);
		expect(covers(zweden, '2026-08-20')).toBe(true);
		expect(covers(zweden, '2027-02-01')).toBe(true);
	});
});

describe('automatisch toewijzen', () => {
	it('een datum in de periode krijgt de tag', () => {
		expect(autoTagChanges('2026-10-14', [lissabon, zweden], [])).toEqual({
			add: ['lis', 'zwe'],
			remove: []
		});
	});

	it('een datum ervoor of erna niet', () => {
		expect(autoTagChanges('2026-10-11', [lissabon], [])).toEqual({ add: [], remove: [] });
		expect(autoTagChanges('2026-10-20', [lissabon], [])).toEqual({ add: [], remove: [] });
	});

	it('een uitgezette tag komt niet terug', () => {
		const changes = autoTagChanges(
			'2026-10-14',
			[lissabon],
			[{ tagId: 'lis', source: 'handmatig', active: false }]
		);
		expect(changes).toEqual({ add: [], remove: [] });
	});

	it('een zelf aangezette tag blijft buiten de periode staan', () => {
		const changes = autoTagChanges(
			'2026-09-01',
			[lissabon],
			[{ tagId: 'lis', source: 'handmatig', active: true }]
		);
		expect(changes).toEqual({ add: [], remove: [] });
	});

	it('een nieuwe datum buiten de periode haalt de automatische tag weg', () => {
		const changes = autoTagChanges(
			'2026-10-25',
			[lissabon],
			[{ tagId: 'lis', source: 'automatisch', active: true }]
		);
		expect(changes).toEqual({ add: [], remove: ['lis'] });
	});

	it('een automatische tag die er al op staat blijft', () => {
		expect(
			autoTagChanges(
				'2026-10-14',
				[lissabon],
				[{ tagId: 'lis', source: 'automatisch', active: true }]
			)
		).toEqual({ add: [], remove: [] });
	});
});

const line = (over: Partial<TagLine>): TagLine => ({
	categoryId: 'eten',
	categoryName: 'Uit eten en bezorgen',
	categoryGroup: 'Dagelijks',
	countsForBudget: true,
	amountCents: -1000,
	advanced: false,
	...over
});

describe('totaal', () => {
	it('telt uitgaven als positief getal, per categorie het meeste eerst', () => {
		const spend = tagSpend([
			line({ amountCents: -2500 }),
			line({
				categoryId: 'ov',
				categoryName: 'Vervoer',
				categoryGroup: 'Onderweg',
				amountCents: -4000
			}),
			line({ amountCents: -1500 })
		]);
		expect(spend.totalCents).toBe(8000);
		expect(spend.byCategory.map((c) => [c.name, c.cents])).toEqual([
			['Uit eten en bezorgen', 4000],
			['Vervoer', 4000]
		]);
	});

	it('een retour verlaagt het totaal in zijn categorie', () => {
		const spend = tagSpend([
			line({ categoryId: 'kleding', categoryName: 'Kleding', amountCents: -9000 }),
			line({ categoryId: 'kleding', categoryName: 'Kleding', amountCents: 3000 })
		]);
		expect(spend.totalCents).toBe(6000);
	});

	it('van een gedeelde uitgave telt alleen jouw deel', () => {
		// €90 voor drie: jouw deel in de categorie, het voorgeschoten deel in Terugbetaling
		const spend = tagSpend([
			line({ amountCents: -3000 }),
			line({
				categoryId: 'terug',
				categoryName: 'Terugbetaling',
				categoryGroup: 'Buiten budget',
				countsForBudget: false,
				amountCents: -6000,
				advanced: true
			})
		]);
		expect(spend.totalCents).toBe(3000);
	});

	it('het voorgeschoten deel telt ook zonder categorie Terugbetaling niet', () => {
		const spend = tagSpend([
			line({ amountCents: -3000 }),
			line({
				categoryId: null,
				categoryName: null,
				categoryGroup: null,
				countsForBudget: null,
				amountCents: -6000,
				advanced: true
			})
		]);
		expect(spend.totalCents).toBe(3000);
	});

	it('inkomen en interne overboekingen tellen niet mee', () => {
		const spend = tagSpend([
			line({ amountCents: -2000 }),
			line({
				categoryId: 'inkomen',
				categoryName: 'Inkomen',
				countsForBudget: false,
				amountCents: 250000
			}),
			line({
				categoryId: 'intern',
				categoryName: 'Interne overboeking',
				countsForBudget: false,
				amountCents: -50000
			})
		]);
		expect(spend.totalCents).toBe(2000);
	});

	it('zonder categorie telt alleen wat er netto uitging', () => {
		const none = {
			categoryId: null,
			categoryName: null,
			categoryGroup: null,
			countsForBudget: null
		};
		expect(tagSpend([line({ ...none, amountCents: -1200 })]).totalCents).toBe(1200);
		expect(tagSpend([line({ ...none, amountCents: 5000 })]).totalCents).toBe(0);
		expect(
			tagSpend([line({ ...none, amountCents: -1200 }), line({ ...none, amountCents: 200 })])
				.totalCents
		).toBe(1000);
	});

	it('een tag zonder transacties kost niets', () => {
		expect(tagSpend([])).toEqual({ totalCents: 0, byCategory: [] });
	});
});

describe('weergave', () => {
	it('kiest een tint die nog vrij is', () => {
		expect(nextHue([])).toBe(TAG_HUES[0]);
		expect(nextHue([TAG_HUES[0], TAG_HUES[1]])).toBe(TAG_HUES[2]);
		expect(TAG_HUES).toContain(nextHue([...TAG_HUES]));
	});

	it('telt de dagen van de periode, begin en eind meegeteld', () => {
		expect(periodDays(lissabon, '2026-10-26')).toBe(8);
		expect(periodDays({ startDate: '2026-10-26', endDate: '2026-10-26' }, '2026-10-26')).toBe(1);
		// Lopend: tot en met vandaag, ook over de zomertijd heen
		expect(periodDays({ startDate: '2026-10-20', endDate: null }, '2026-10-26')).toBe(7);
	});

	it('weet of een tag komt, loopt of voorbij is', () => {
		expect(tagState(lissabon, '2026-10-01')).toBe('komt');
		expect(tagState(lissabon, '2026-10-19')).toBe('loopt');
		expect(tagState(lissabon, '2026-10-20')).toBe('voorbij');
		expect(tagState(zweden, '2030-01-01')).toBe('loopt');
	});

	it('schrijft de periode kort, met het jaar als dat niet dit jaar is', () => {
		expect(formatPeriod(lissabon, '2026-10-26')).toBe('12 okt – 19 okt');
		expect(formatPeriod(lissabon, '2027-01-02')).toBe('12 okt – 19 okt 2026');
		expect(formatPeriod(zweden, '2026-10-26')).toBe('sinds 20 aug');
		expect(formatPeriod({ startDate: '2025-12-28', endDate: '2026-01-03' }, '2026-02-01')).toBe(
			'28 dec 2025 – 3 jan'
		);
	});

	it('vertelt hoe lang de tag duurt en wat dat per dag was', () => {
		expect(tagSentence(lissabon, 33600, '2026-10-26')).toBe(
			`8 dagen, gemiddeld ${euro(4200)} per dag.`
		);
		expect(tagSentence(lissabon, 0, '2026-10-26')).toBe('8 dagen, nog niets uitgegeven.');
		expect(tagSentence(lissabon, 0, '2026-10-11')).toBe('Begint morgen.');
		expect(tagSentence(lissabon, 0, '2026-10-01')).toBe('Begint over 11 dagen.');
		expect(tagSentence({ startDate: '2026-10-20', endDate: null }, 7000, '2026-10-26')).toBe(
			`Loopt nu 7 dagen, gemiddeld ${euro(1000)} per dag.`
		);
	});

	it('zet kleine categorieën samen in de balk en laat retouren eruit', () => {
		const cats = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => ({
			categoryId: id,
			name: id.toUpperCase(),
			group: 'Dagelijks',
			cents: 600 - i * 100
		}));
		const segments = tagSegments(
			[...cats, { categoryId: 'g', name: 'G', group: 'Overig', cents: -50 }],
			4
		);
		expect(segments.map((s) => [s.label, s.cents])).toEqual([
			['A', 600],
			['B', 500],
			['C', 400],
			['Overig (3)', 600]
		]);
	});
});
