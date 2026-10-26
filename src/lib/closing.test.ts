import { describe, expect, it } from 'vitest';
import {
	changedSince,
	closingMonth,
	closingNotice,
	closingSplit,
	compareMonths,
	extremes,
	lastDayOf,
	limitProposals,
	monthName,
	nextNotifyAt,
	openItemsFor,
	outcomeOf,
	outcomeSentence,
	zonedParts,
	zonedTime,
	type ClosingLine,
	type LimitHistory,
	type OpenSources
} from './closing.ts';

const utc = (iso: string) => new Date(iso);

describe('moment van de melding', () => {
	it('9:00 in Nederland is 8:00 UTC in de winter en 7:00 UTC in de zomer', () => {
		expect(zonedTime('2026-11-01', 9)).toEqual(utc('2026-11-01T08:00:00Z'));
		expect(zonedTime('2026-10-01', 9)).toEqual(utc('2026-10-01T07:00:00Z'));
	});

	it('de dag waarop de klok verzet wordt, telt goed', () => {
		// Zomertijd begint op 29 maart 2026, eindigt op 25 oktober 2026 (om 3:00 / 2:00)
		expect(zonedTime('2026-03-29', 9)).toEqual(utc('2026-03-29T07:00:00Z'));
		expect(zonedTime('2026-10-25', 9)).toEqual(utc('2026-10-25T08:00:00Z'));
	});

	it('de volgende ronde is de eerstvolgende 9:00 in Nederland', () => {
		// 30 september 23:30 UTC is al 1 oktober 1:30 in Nederland: vandaag om 9:00
		expect(nextNotifyAt(utc('2026-09-30T23:30:00Z'))).toEqual(utc('2026-10-01T07:00:00Z'));
		// Precies 9:00: de volgende dag
		expect(nextNotifyAt(utc('2026-10-01T07:00:00Z'))).toEqual(utc('2026-10-02T07:00:00Z'));
		// Over de wisseling naar wintertijd heen
		expect(nextNotifyAt(utc('2026-10-24T12:00:00Z'))).toEqual(utc('2026-10-25T08:00:00Z'));
	});

	it('de maand volgt de klok in Nederland, niet die van UTC', () => {
		// In UTC is het nog 31 oktober, in Nederland al 1 november
		const now = utc('2026-10-31T23:30:00Z');
		expect(zonedParts(now).date).toBe('2026-11-01');
		expect(closingMonth(now)).toBe('2026-10');
		// In New York is het dan nog 31 oktober: daar staat september klaar
		expect(closingMonth(now, 'America/New_York')).toBe('2026-09');
	});

	it('niet voor 9:00', () => {
		expect(closingNotice(utc('2026-10-01T06:59:00Z'), 0)).toBeNull();
		expect(closingNotice(utc('2026-10-01T07:00:00Z'), 0)).toEqual({
			month: '2026-09',
			kind: 'klaar'
		});
	});

	it('zodra er niets meer openstaat, ook op de 1e', () => {
		expect(closingNotice(utc('2026-10-02T07:30:00Z'), 0)).toEqual({
			month: '2026-09',
			kind: 'klaar'
		});
	});

	it('met open punten wacht hij tot de 5e en komt dan toch', () => {
		for (const day of ['01', '02', '03', '04'])
			expect(closingNotice(utc(`2026-10-${day}T09:00:00Z`), 2), day).toBeNull();
		expect(closingNotice(utc('2026-10-05T07:00:00Z'), 2)).toEqual({
			month: '2026-09',
			kind: 'open'
		});
		// Gemist op de 5e (server uit): later alsnog
		expect(closingNotice(utc('2026-10-08T07:00:00Z'), 2)?.kind).toBe('open');
	});

	it('de 5e om 8:59 in Nederland is nog te vroeg, ook al is het in UTC later dan 9:00 elders', () => {
		// Wintertijd: 8:59 in Nederland is 7:59 UTC
		expect(closingNotice(utc('2026-12-05T07:59:00Z'), 1)).toBeNull();
		expect(closingNotice(utc('2026-12-05T08:00:00Z'), 1)).toEqual({
			month: '2026-11',
			kind: 'open'
		});
	});

	it('januari sluit december van het jaar ervoor af', () => {
		expect(closingNotice(utc('2027-01-01T08:00:00Z'), 0)?.month).toBe('2026-12');
	});
});

describe('open punten', () => {
	const sources = (over: Partial<OpenSources> = {}): OpenSources => ({
		expected: [],
		inbox: [],
		accounts: [],
		...over
	});

	it('alleen verwachte posten uit die maand, met de goede link', () => {
		const items = openItemsFor(
			'2026-09',
			sources({
				expected: [
					{
						id: 'a',
						date: '2026-09-28',
						counterparty: 'Vattenfall',
						amountCents: -8420,
						missed: false
					},
					{ id: 'b', date: '2026-09-10', counterparty: 'Ziggo', amountCents: -5000, missed: true },
					{ id: 'c', date: '2026-10-01', counterparty: 'Huur', amountCents: -90000, missed: false },
					{ id: 'd', date: '2026-08-31', counterparty: 'Oud', amountCents: -100, missed: true }
				]
			})
		);
		expect(items.map((i) => [i.id, i.href])).toEqual([
			['b', '/te-controleren'],
			['a', '/']
		]);
	});

	it('inbox-items uit die maand, zonder een verwachte post dubbel te tellen', () => {
		const items = openItemsFor(
			'2026-09',
			sources({
				expected: [
					{ id: 'x', date: '2026-09-02', counterparty: 'Huur', amountCents: -1, missed: true }
				],
				inbox: [
					{
						kind: 'boeking',
						id: 'x',
						name: 'Huur',
						date: '2026-09-02',
						amountCents: -1,
						href: '/t'
					},
					{ kind: 'bon', id: 'r', name: 'AH', date: '2026-09-15', amountCents: 1234, href: '/b' },
					{
						kind: 'herinnering',
						id: 'h',
						name: 'Sanne',
						date: '2026-10-02',
						amountCents: 1,
						href: '/'
					}
				]
			})
		);
		expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual(['verwacht:x', 'bon:r']);
	});

	it('een rekening in gebruik zonder saldocheck op of na de laatste dag', () => {
		const items = openItemsFor(
			'2026-09',
			sources({
				accounts: [
					{ id: 'sns', name: 'SNS', firstUse: '2026-01-01', lastCheck: '2026-09-20' },
					{ id: 'rev', name: 'Revolut', firstUse: '2026-02-01', lastCheck: '2026-09-30' },
					{ id: 'nieuw', name: 'Nieuw', firstUse: '2026-10-03', lastCheck: null },
					{ id: 'leeg', name: 'Leeg', firstUse: null, lastCheck: null },
					{ id: 'nooit', name: 'Nooit', firstUse: '2026-09-01', lastCheck: null },
					{ id: 'later', name: 'Later', firstUse: '2026-09-01', lastCheck: '2026-10-04' }
				]
			})
		);
		expect(items.map((i) => i.id)).toEqual(['sns', 'nooit']);
		expect(items.every((i) => i.kind === 'saldocheck' && i.href === '/saldocheck')).toBe(true);
	});

	it('de laatste dag van de maand, ook in februari en een schrikkeljaar', () => {
		expect(lastDayOf('2026-09')).toBe('2026-09-30');
		expect(lastDayOf('2026-02')).toBe('2026-02-28');
		expect(lastDayOf('2028-02')).toBe('2028-02-29');
		expect(lastDayOf('2026-12')).toBe('2026-12-31');
	});
});

describe('balk en uitschieters', () => {
	it('reserveringen apart; een afschrijving uit de reservering telt niet nog eens', () => {
		const split = closingSplit(
			[
				// Huur: bevestigde vaste last in de groep Vaste lasten
				{ group: 'Vaste lasten', spentCents: 90000, plannedSpentCents: 90000 },
				// Contributie, halfjaarlijks uitgesmeerd: afgeschreven (9000) uit de reservering
				// (1500 deze maand opzij, 9000 eruit), dus netto 1500 uitgegeven
				{ group: 'Vrije tijd', spentCents: 1500 + 4000, plannedSpentCents: 1500 },
				{ group: 'Dagelijks', spentCents: 30000, plannedSpentCents: 0 }
			],
			1500,
			2500,
			20000
		);
		expect(split).toEqual({
			fixedCents: 90000,
			reservedCents: 1500,
			dailyCents: 4000 + 30000 + 2500,
			freeCents: 20000
		});
	});

	it('over je limieten: niets over', () => {
		expect(closingSplit([], 0, 0, -3800).freeCents).toBe(0);
	});

	const line = (name: string, limitCents: number, spentCents: number): ClosingLine => ({
		categoryId: name,
		name,
		group: 'Dagelijks',
		limitCents,
		spentCents
	});

	it('drie over de limiet en drie met het meeste over', () => {
		const { over, left } = extremes([
			line('a', 10000, 15000),
			line('b', 10000, 11000),
			line('c', 10000, 30000),
			line('d', 10000, 12000),
			line('e', 50000, 1000),
			line('f', 20000, 19000),
			line('g', 0, 9000),
			line('h', 30000, 0),
			line('i', 40000, 35000)
		]);
		expect(over.map((l) => [l.name, l.diffCents])).toEqual([
			['c', 20000],
			['a', 5000],
			['d', 2000]
		]);
		expect(left.map((l) => l.name)).toEqual(['e', 'h', 'i']);
	});
});

describe('vergelijking met de maanden ervoor', () => {
	it('totaal tegenover het gemiddelde, en de grootste stijger en daler', () => {
		const cmp = compareMonths({ totalCents: 30000, byCategory: { a: 20000, b: 5000, c: 5000 } }, [
			{ totalCents: 24000, byCategory: { a: 12000, b: 9000, c: 3000 } },
			{ totalCents: 27000, byCategory: { a: 15000, b: 9000, c: 3000 } },
			{ totalCents: 21000, byCategory: { a: 9000, b: 9000, c: 3000 } }
		]);
		expect(cmp).toEqual({
			totalCents: 30000,
			averageCents: 24000,
			months: 3,
			riser: { categoryId: 'a', diffCents: 8000 },
			faller: { categoryId: 'b', diffCents: -4000 }
		});
	});

	it('zonder eerdere maanden geen vergelijking; met één alleen die', () => {
		expect(compareMonths({ totalCents: 1, byCategory: {} }, [])).toBeNull();
		const one = compareMonths({ totalCents: 100, byCategory: { a: 100 } }, [
			{ totalCents: 100, byCategory: { a: 100 } }
		]);
		expect(one).toMatchObject({ months: 1, averageCents: 100, riser: null, faller: null });
	});
});

describe('voorstellen voor limieten', () => {
	const history = (
		months: [limit: number, spent: number][],
		currentLimitCents = months[0]![0]
	): LimitHistory => ({
		categoryId: 'boodschappen',
		name: 'Boodschappen',
		group: 'Dagelijks',
		currentLimitCents,
		months: months.map(([limitCents, spentCents]) => ({ limitCents, spentCents }))
	});

	it('drie maanden over de limiet: het gemiddelde, afgerond op hele euro', () => {
		const [p] = limitProposals([
			history([
				[30000, 34050],
				[30000, 31000],
				[30000, 32000]
			])
		]);
		// (340,50 + 310 + 320) / 3 = 323,50 → € 324
		expect(p).toMatchObject({ fromCents: 30000, toCents: 32400, reason: 'over' });
	});

	it('drie maanden onder 70%', () => {
		const [p] = limitProposals([
			history([
				[20000, 9000],
				[20000, 13999],
				[20000, 10000]
			])
		]);
		expect(p).toMatchObject({ toCents: 11000, reason: 'onder' });
	});

	it('precies 70% of precies op de limiet telt niet', () => {
		expect(
			limitProposals([
				history([
					[20000, 14000],
					[20000, 9000],
					[20000, 9000]
				]),
				history([
					[20000, 20000],
					[20000, 25000],
					[20000, 25000]
				])
			])
		).toEqual([]);
	});

	it('geen voorstel bij twee maanden, wisselend, zonder limiet of als het al zo staat', () => {
		expect(
			limitProposals([
				history([
					[30000, 40000],
					[30000, 40000]
				]),
				history([
					[30000, 40000],
					[30000, 10000],
					[30000, 40000]
				]),
				history([
					[0, 40000],
					[30000, 40000],
					[30000, 40000]
				]),
				history(
					[
						[30000, 40000],
						[30000, 40000],
						[30000, 40000]
					],
					40000
				)
			])
		).toEqual([]);
	});

	it('nooit een voorstel van nul', () => {
		expect(
			limitProposals([
				history([
					[5000, 0],
					[5000, 0],
					[5000, 40]
				])
			])
		).toEqual([]);
	});
});

describe('uitkomst en verschil sinds afsluiten', () => {
	it('de zin over de uitkomst', () => {
		expect(outcomeSentence(outcomeOf(14200, 200000, 185800))).toMatch(/^Je hield €\s142 over\.$/);
		expect(outcomeSentence(outcomeOf(-3800, 200000, 203800))).toMatch(
			/^Je ging €\s38 over je budget\.$/
		);
		expect(outcomeOf(0, 0, 5000)).toEqual({ kind: 'zonder', cents: 5000 });
	});

	it('de maand met een hoofdletter, zonder jaar', () => {
		expect(monthName('2026-09')).toBe('September');
	});

	it('een late boeking van € 12 na het afsluiten', () => {
		const snapshot = {
			totalSpentCents: 100000,
			categories: [
				{
					categoryId: 'a',
					name: 'Boodschappen',
					group: 'Dagelijks',
					limitCents: 0,
					spentCents: 40000
				},
				{ categoryId: 'b', name: 'Uit eten', group: 'Dagelijks', limitCents: 0, spentCents: 60000 }
			]
		};
		const now = {
			totalSpentCents: 101200,
			categories: [{ ...snapshot.categories[0]!, spentCents: 41200 }, snapshot.categories[1]!]
		};
		expect(changedSince(snapshot, now)).toEqual({
			totalCents: 1200,
			categories: [{ categoryId: 'a', name: 'Boodschappen', diffCents: 1200 }]
		});
	});

	it('verschoven tussen categorieën: totaal gelijk, verdeling niet', () => {
		const base = { categoryId: 'a', name: 'A', group: 'G', limitCents: 0, spentCents: 500 };
		const change = changedSince(
			{ totalSpentCents: 500, categories: [base] },
			{ totalSpentCents: 500, categories: [{ ...base, categoryId: 'b', name: 'B' }] }
		);
		expect(change.totalCents).toBe(0);
		expect(change.categories.map((c) => [c.name, c.diffCents])).toEqual([
			['A', -500],
			['B', 500]
		]);
	});

	it('niets veranderd', () => {
		const s = { totalSpentCents: 1, categories: [] };
		expect(changedSince(s, s)).toEqual({ totalCents: 0, categories: [] });
	});
});
