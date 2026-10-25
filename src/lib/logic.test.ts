import { describe, expect, it } from 'vitest';
import {
	freeThisMonth,
	homeBars,
	monthStory,
	pace,
	storySentence,
	type BudgetLine
} from './budget.ts';
import { groupColor, groupHue } from './categoryColor.ts';
import { keyboardInset } from './viewport.ts';
import { addDays, daysInMonth, formatDayHeading, isIsoDate, shiftMonth } from './dates.ts';
import { matchRule, sortRules, type Rule } from './rules.ts';
import { isValidIban, normalize, normalizeCounterparty } from './text.ts';

describe('tempo', () => {
	it('boodschappen op 70% bij dag 19 van 31 gaat snel (spec: Startscherm)', () => {
		const r = pace({ spentCents: 7000, limitCents: 10000, day: 19, daysInMonth: 31 });
		expect(r.pace).toBe('snel');
		expect(r.monthRatio).toBeCloseTo(19 / 31);
	});

	it.each([
		[2000, 15, 'rustig'],
		[4800, 15, 'op_schema'],
		[5600, 15, 'snel'],
		[10001, 15, 'over'],
		[10000, 30, 'op_schema']
	] as const)('%i van 10000 op dag %i is %s', (spent, day, expected) => {
		expect(pace({ spentCents: spent, limitCents: 10000, day, daysInMonth: 30 }).pace).toBe(
			expected
		);
	});

	it('zonder limiet is elke uitgave over', () => {
		expect(pace({ spentCents: 1, limitCents: 0, day: 1, daysInMonth: 30 }).pace).toBe('over');
		expect(pace({ spentCents: 0, limitCents: 0, day: 1, daysInMonth: 30 }).pace).toBe('rustig');
	});

	it('nog vrij is limieten min uitgaven, inclusief uitgaven zonder limiet', () => {
		const budgets = [
			{ categoryId: 'a', limitCents: 30000, spentCents: 12000 },
			{ categoryId: 'b', limitCents: 10000, spentCents: 11000 }
		];
		expect(freeThisMonth(budgets)).toBe(17000);
		expect(freeThisMonth(budgets, 2500)).toBe(14500);
	});
});

describe('verhaal onder nog vrij', () => {
	const line = (
		limitCents: number,
		spentCents: number,
		plannedCents = 0,
		plannedSpentCents = 0
	) => ({
		limitCents,
		spentCents,
		plannedCents,
		plannedSpentCents
	});

	it('per dag: vrij min de vaste lasten die nog komen, gedeeld door de dagen incl. vandaag', () => {
		// Huur €685 gepland en bevestigd, energie €90 nog te komen; boodschappen €100 van €350
		const lines = [line(68500, 68500, 68500, 68500), line(9000, 0, 9000, 0), line(35000, 10000)];
		const free = 68500 + 9000 + 35000 - 68500 - 10000; // 34000
		const story = monthStory(lines, free, 25, 31);
		expect(story.daysLeft).toBe(7);
		expect(story.plannedLeftCents).toBe(9000);
		expect(story.spendableCents).toBe(25000);
		expect(story.perDayCents).toBe(Math.floor(25000 / 7));
		expect(storySentence(story, free)).toMatch(
			/^Nog 7 dagen, ongeveer €\s36 per dag\. Je houdt het rustig\.$/
		);
	});

	it('de maandlijn telt op tot hooguit 1', () => {
		const story = monthStory([line(10000, 9000, 5000, 0)], 1000, 10, 30);
		expect(story.spentShare).toBeCloseTo(0.9);
		expect(story.plannedShare).toBeCloseTo(0.1);
		expect(story.spentShare + story.plannedShare).toBeLessThanOrEqual(1);
	});

	it('zegt het eerlijk als er niets meer vrij is', () => {
		const lines = [line(10000, 9500, 1000, 0)];
		expect(storySentence(monthStory(lines, 500, 20, 30), 500)).toMatch(/niets meer vrij/);
		expect(storySentence(monthStory(lines, -2500, 20, 30), -2500)).toMatch(
			/^Je zit €\s25 boven je limieten\.$/
		);
	});

	it('op de laatste dag geen gemiddelde per dag', () => {
		const story = monthStory([line(10000, 4000)], 6000, 31, 31);
		expect(story.daysLeft).toBe(1);
		expect(storySentence(story, 6000)).toMatch(/^Laatste dag van de maand, nog €\s60\.$/);
	});

	it('tempo over alle limieten samen, zonder geplande posten', () => {
		// Op dag 15 van 30 al 80% van het vrije deel uitgegeven
		const story = monthStory([line(10000, 8000), line(50000, 50000, 50000, 50000)], 2000, 15, 30);
		expect(story.pace).toBe('snel');
	});
});

describe('balken op het startscherm', () => {
	const bar = (
		name: string,
		group: string,
		limitCents: number,
		spentCents: number,
		plannedCents = 0
	): BudgetLine => {
		const r = pace({
			spentCents,
			limitCents,
			plannedCents,
			plannedSpentCents: plannedCents,
			day: 20,
			daysInMonth: 30
		});
		return {
			categoryId: name,
			name,
			group,
			limitCents,
			spentCents,
			plannedCents,
			plannedSpentCents: plannedCents,
			...r
		};
	};

	it('vaste lasten samen, de rest op wat het dichtst bij de limiet zit', () => {
		const lines = [
			bar('Wonen', 'Vaste lasten', 68500, 68500, 68500),
			bar('Energie', 'Vaste lasten', 9000, 8700, 8700),
			bar('Boodschappen', 'Dagelijks', 35000, 5000),
			bar('Uit eten', 'Dagelijks', 10000, 9500),
			bar('Uitgaan', 'Vrije tijd', 8000, 9000),
			bar('Vervoer', 'Onderweg', 6000, 3000),
			bar('Kleding', 'Overig', 5000, 500),
			bar('Sport', 'Vrije tijd', 0, 0)
		];
		const { fixed, top, more } = homeBars(lines, 20, 30);
		expect(fixed).toMatchObject({ limitCents: 77500, spentCents: 77200, count: 2 });
		expect(top.map((l) => l.name)).toEqual(['Uitgaan', 'Uit eten', 'Vervoer', 'Boodschappen']);
		// Sport heeft geen limiet en geen uitgaven: telt niet mee
		expect(more).toBe(1);
	});

	it('zonder vaste lasten geen samengevoegde balk', () => {
		expect(homeBars([bar('Boodschappen', 'Dagelijks', 35000, 5000)], 20, 30).fixed).toBeNull();
	});
});

describe('datums', () => {
	it('rekent met maanden en schrikkeljaren', () => {
		expect(daysInMonth('2028-02')).toBe(29);
		expect(daysInMonth('2026-02')).toBe(28);
		expect(shiftMonth('2026-01', -1)).toBe('2025-12');
		expect(shiftMonth('2026-12', 1)).toBe('2027-01');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
	});

	it('herkent geldige ISO-datums', () => {
		expect(isIsoDate('2026-10-23')).toBe(true);
		expect(isIsoDate('2026-02-30')).toBe(false);
		expect(isIsoDate('2026-1-1')).toBe(false);
	});
});

describe('tekst en IBAN', () => {
	it('normaliseert tegenpartijen', () => {
		expect(normalize('  Café   DE Hoek ')).toBe('cafe de hoek');
		expect(normalizeCounterparty('ALBERT HEIJN 1403 UTRECHT')).toBe('albert heijn utrecht');
		expect(normalizeCounterparty('AH to go 5678')).toBe('ah to go');
	});

	it('controleert het IBAN-controlegetal', () => {
		expect(isValidIban('NL91 ABNA 0417 1643 00')).toBe(true);
		expect(isValidIban('NL12SNSB0123456789')).toBe(true);
		expect(isValidIban('NL91ABNA0417164301')).toBe(false);
		expect(isValidIban('geen iban')).toBe(false);
	});
});

describe('categorieregels', () => {
	const rules: Rule[] = sortRules([
		{
			id: '1',
			field: 'tegenpartij',
			pattern: 'albert heijn',
			categoryId: 'boodschappen',
			priority: 100
		},
		{
			id: '2',
			field: 'tegenpartij',
			pattern: 'albert heijn to go',
			categoryId: 'uiteten',
			priority: 100
		},
		{ id: '3', field: 'iban', pattern: 'NL91ABNA0417164300', categoryId: 'inkomen', priority: 50 },
		{ id: '4', field: 'omschrijving', pattern: 'huur', categoryId: 'wonen', priority: 100 },
		{ id: '5', field: 'tegenpartij', pattern: '1234', categoryId: 'fout', priority: 1 }
	]);
	const tx = (counterparty: string, counterIban: string | null = null, description = '') => ({
		counterparty,
		counterIban,
		description
	});

	it('matcht ondanks filiaalnummer en plaatsnaam', () => {
		expect(matchRule(rules, tx('ALBERT HEIJN 1403 UTRECHT'))?.categoryId).toBe('boodschappen');
	});

	it('het specifiekste patroon wint bij gelijke prioriteit', () => {
		expect(matchRule(rules, tx('Albert Heijn to go 12'))?.categoryId).toBe('uiteten');
	});

	it('lagere prioriteit wint', () => {
		expect(matchRule(rules, tx('Albert Heijn', 'NL91 ABNA 0417 1643 00'))?.categoryId).toBe(
			'inkomen'
		);
	});

	it('omschrijving', () => {
		expect(matchRule(rules, tx('Verhuurder', null, 'Huur oktober'))?.categoryId).toBe('wonen');
	});

	it('een patroon dat leeg normaliseert matcht nooit', () => {
		expect(matchRule(rules, tx('Iets 1234'))).toBeNull();
	});
});

describe('dagkoppen in lijsten', () => {
	it('vandaag en gisteren bij naam, ook over een maandgrens', () => {
		expect(formatDayHeading('2026-10-24', '2026-10-24')).toBe('Vandaag');
		expect(formatDayHeading('2026-10-23', '2026-10-24')).toBe('Gisteren');
		expect(formatDayHeading('2026-09-30', '2026-10-01')).toBe('Gisteren');
	});

	it('anders weekdag en datum met hoofdletter, het jaar alleen als het een ander jaar is', () => {
		expect(formatDayHeading('2026-10-22', '2026-10-24')).toBe('Donderdag 22 oktober');
		expect(formatDayHeading('2025-12-31', '2026-01-02')).toBe('Woensdag 31 december 2025');
	});
});

describe('kleur per categoriegroep', () => {
	it('vaste tinten voor de startgroepen, verschillend per groep', () => {
		const groups = [
			'Vaste lasten',
			'Dagelijks',
			'Onderweg',
			'Vrije tijd',
			'Overig',
			'Buiten budget'
		];
		expect(new Set(groups.map(groupHue)).size).toBe(groups.length);
	});

	it('een onbekende groep krijgt steeds dezelfde tint binnen 0 tot 360', () => {
		const h = groupHue('Huisdieren');
		expect(h).toBe(groupHue('Huisdieren'));
		expect(h).toBeGreaterThanOrEqual(0);
		expect(h).toBeLessThan(360);
	});

	it('zonder categorie geen kleur', () => {
		expect(groupColor(null)).toBeNull();
		expect(groupColor('')).toBeNull();
		expect(groupColor('Dagelijks')).toContain('oklch(');
	});
});

describe('sheet boven het schermtoetsenbord', () => {
	it('zonder toetsenbord blijft de sheet onderin met de hele hoogte als ruimte', () => {
		expect(keyboardInset(800, { height: 800, offsetTop: 0 })).toEqual({ bottom: 0, room: 800 });
	});

	it('met toetsenbord schuift de sheet erboven en krimpt de ruimte mee', () => {
		expect(keyboardInset(800, { height: 460, offsetTop: 0 })).toEqual({ bottom: 340, room: 460 });
	});

	it('houdt rekening met een verschoven visual viewport (iOS scrolt naar het veld)', () => {
		expect(keyboardInset(800, { height: 460, offsetTop: 120 })).toEqual({ bottom: 220, room: 460 });
	});

	it('zonder visualViewport of bij afrondingsruis nooit negatief', () => {
		expect(keyboardInset(800, null)).toEqual({ bottom: 0, room: 800 });
		expect(keyboardInset(800, { height: 800.4, offsetTop: 0 }).bottom).toBe(0);
	});
});
