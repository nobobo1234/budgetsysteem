import { describe, expect, it } from 'vitest';
import { freeThisMonth, pace } from './budget.ts';
import { groupColor, groupHue } from './categoryColor.ts';
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
