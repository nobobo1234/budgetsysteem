import { describe, expect, it } from 'vitest';
import { addDays } from '../../dates.ts';
import { MAX_DURATION_MS } from '../../usage.ts';
import { MAX_ENTRIES, inFuture, median, summarizeUsage, usageBody } from './usage.ts';

// Woensdag; de week begint op maandag 26 oktober
const TODAY = '2026-10-28';
const row = (day: string, durationMs: number | null = null) => ({ day, durationMs });

describe('median', () => {
	it('geeft null zonder metingen', () => {
		expect(median([])).toBeNull();
	});

	it('neemt het middelste getal, of het gemiddelde van de twee middelste', () => {
		expect(median([5000])).toBe(5000);
		expect(median([9000, 1000, 5000])).toBe(5000);
		expect(median([1000, 2000, 4000, 8000])).toBe(3000);
		expect(median([1, 2])).toBe(2);
	});
});

describe('summarizeUsage', () => {
	it('zonder invoer: geen weken en geen reeks', () => {
		expect(summarizeUsage([], TODAY)).toEqual({
			weeks: [],
			streak: 0,
			longestStreak: 0,
			today: false
		});
	});

	it('de lopende week: dagen met invoer, en dagen die nog komen zijn null', () => {
		const { weeks } = summarizeUsage(
			[row('2026-10-26', 4000), row('2026-10-26', 6000), row('2026-10-28', null)],
			TODAY
		);
		expect(weeks).toHaveLength(1);
		expect(weeks[0]).toEqual({
			weekStart: '2026-10-26',
			days: [true, false, true, null, null, null, null],
			daysWithEntry: 2,
			daysSoFar: 3,
			entries: 3,
			timed: 2,
			medianMs: 5000,
			p75Ms: 6000
		});
	});

	it('meerdere invoeren op één dag tellen als één dag', () => {
		const rows = Array.from({ length: 5 }, () => row('2026-10-27', 3000));
		const [week] = summarizeUsage(rows, TODAY).weeks;
		expect(week!.daysWithEntry).toBe(1);
		expect(week!.entries).toBe(5);
	});

	it('weken vanaf de eerste met invoer, nieuwste eerst, ook een lege week ertussen', () => {
		const { weeks } = summarizeUsage([row('2026-10-14', 8000), row('2026-10-27', 2000)], TODAY);
		expect(weeks.map((w) => w.weekStart)).toEqual(['2026-10-26', '2026-10-19', '2026-10-12']);
		expect(weeks[1]).toMatchObject({
			days: Array(7).fill(false),
			daysWithEntry: 0,
			daysSoFar: 7,
			entries: 0,
			medianMs: null,
			p75Ms: null
		});
		expect(weeks[2]).toMatchObject({ daysWithEntry: 1, daysSoFar: 7, medianMs: 8000 });
	});

	it('toont hooguit het gevraagde aantal weken', () => {
		const rows = Array.from({ length: 70 }, (_, i) => row(addDays(TODAY, -i), 1000));
		const { weeks } = summarizeUsage(rows, TODAY, 8);
		expect(weeks).toHaveLength(8);
		expect(weeks.at(-1)!.weekStart).toBe('2026-09-07');
		expect(weeks.at(-1)!.daysWithEntry).toBe(7);
	});

	it('invoer zonder tijd telt wel als dag, niet in mediaan en p75', () => {
		const [week] = summarizeUsage([row('2026-10-27', null), row('2026-10-28', 7000)], TODAY).weeks;
		expect(week).toMatchObject({ daysWithEntry: 2, entries: 2, timed: 1, medianMs: 7000 });
	});

	it('een dag na vandaag (andere tijdzone) telt nog niet mee', () => {
		const summary = summarizeUsage([row('2026-10-29', 1000)], TODAY);
		expect(summary.weeks).toEqual([]);
		expect(summary.streak).toBe(0);
	});

	describe('reeks', () => {
		it('telt dagen op rij tot en met vandaag', () => {
			const rows = ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28'].map((d) => row(d));
			expect(summarizeUsage(rows, TODAY)).toMatchObject({ streak: 4, today: true });
		});

		it('loopt door zolang vandaag nog niets ingevoerd is', () => {
			const rows = ['2026-10-26', '2026-10-27'].map((d) => row(d));
			expect(summarizeUsage(rows, TODAY)).toMatchObject({ streak: 2, today: false });
		});

		it('is voorbij na een dag zonder invoer', () => {
			const rows = ['2026-10-24', '2026-10-25', '2026-10-26'].map((d) => row(d));
			expect(summarizeUsage(rows, TODAY)).toMatchObject({ streak: 0, longestStreak: 3 });
		});

		it('onthoudt de langste reeks, ook over een weekgrens', () => {
			const old = Array.from({ length: 9 }, (_, i) => row(addDays('2026-10-01', i)));
			const rows = [...old, row('2026-10-27'), row('2026-10-28')];
			expect(summarizeUsage(rows, TODAY)).toMatchObject({ streak: 2, longestStreak: 9 });
		});
	});
});

describe('usageBody', () => {
	const id = '0b7f3c52-6a2e-4c8e-9a43-1f2d3e4c5b6a';
	const ok = { id, day: TODAY, kind: 'snelinvoer', durationMs: 8400 };
	const parse = (entries: unknown) => usageBody.safeParse({ entries }).success;

	it('neemt dag, soort, ID en tijd aan, ook zonder tijd', () => {
		expect(parse([ok])).toBe(true);
		expect(parse([{ ...ok, kind: 'verwacht', durationMs: null }])).toBe(true);
		expect(parse([{ ...ok, kind: 'bon', durationMs: 0 }])).toBe(true);
		expect(parse([{ ...ok, durationMs: MAX_DURATION_MS }])).toBe(true);
	});

	it('weigert waarden buiten de grenzen', () => {
		expect(parse([{ ...ok, durationMs: -1 }])).toBe(false);
		expect(parse([{ ...ok, durationMs: MAX_DURATION_MS + 1 }])).toBe(false);
		expect(parse([{ ...ok, durationMs: 12.5 }])).toBe(false);
		expect(parse([{ ...ok, durationMs: Number.NaN }])).toBe(false);
		expect(parse([{ ...ok, day: '2026-02-30' }])).toBe(false);
		expect(parse([{ ...ok, day: '28-10-2026' }])).toBe(false);
		expect(parse([{ ...ok, kind: 'import' }])).toBe(false);
		expect(parse([{ ...ok, id: 'abc' }])).toBe(false);
	});

	it('alleen deze velden: geen bedrag, naam of andere inhoud', () => {
		expect(parse([{ ...ok, amountCents: -1250 }])).toBe(false);
		expect(parse([{ ...ok, counterparty: 'Albert Heijn' }])).toBe(false);
		expect(usageBody.safeParse({ entries: [ok], page: '/' }).success).toBe(false);
	});

	it('minstens één en hooguit een batch', () => {
		expect(parse([])).toBe(false);
		expect(parse(Array.from({ length: MAX_ENTRIES }, () => ok))).toBe(true);
		expect(parse(Array.from({ length: MAX_ENTRIES + 1 }, () => ok))).toBe(false);
	});
});

describe('inFuture', () => {
	const at = (day: string) => [{ id: '', day, kind: 'snelinvoer' as const, durationMs: null }];

	it('vandaag en morgen kunnen (tijdzone), overmorgen niet', () => {
		expect(inFuture(at(TODAY), TODAY)).toBe(false);
		expect(inFuture(at('2026-10-29'), TODAY)).toBe(false);
		expect(inFuture(at('2026-10-30'), TODAY)).toBe(true);
	});
});
