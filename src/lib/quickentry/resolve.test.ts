import { describe, expect, it } from 'vitest';
import { sortRules } from '../rules.ts';
import { parseQuickEntry } from './parser.ts';
import { findCategory, matchCounterparty, resolveEntry, type ResolveContext } from './resolve.ts';

const TODAY = '2026-10-23';
const cat = (id: string, name: string) => ({ id, name });

const ctx: ResolveContext = {
	categories: [
		cat('c-boodschappen', 'Boodschappen'),
		cat('c-uiteten', 'Uit eten en bezorgen'),
		cat('c-abonnementen', 'Abonnementen'),
		cat('c-terug', 'Terugbetaling'),
		cat('c-vervoer', 'Vervoer')
	],
	accounts: [
		{ id: 'a-sns', alias: 'sns', kind: 'sns' },
		{ id: 'a-rev', alias: 'rev', kind: 'revolut' }
	],
	rules: sortRules([
		{
			id: 'r1',
			field: 'tegenpartij',
			pattern: 'albert heijn',
			categoryId: 'c-boodschappen',
			priority: 100
		}
	]),
	knownCounterparties: ['ALBERT HEIJN 1403 UTRECHT', 'Jumbo Supermarkten', 'Sanne']
};

const resolve = (input: string) =>
	resolveEntry(parseQuickEntry(input, TODAY, { accountAliases: ['sns', 'rev'] }), ctx);

describe('matchCounterparty', () => {
	it('koppelt initialen aan een bekende naam', () => {
		expect(matchCounterparty('ah', ctx.knownCounterparties)).toBe('ALBERT HEIJN 1403 UTRECHT');
	});

	it('koppelt het begin van een naam', () => {
		expect(matchCounterparty('jumbo', ctx.knownCounterparties)).toBe('Jumbo Supermarkten');
	});

	it('valt terug op ingebouwde afkortingen zonder historie', () => {
		expect(matchCounterparty('ah', [])).toBe('Albert Heijn');
	});

	it('laat onbekende tekst ongemoeid', () => {
		expect(matchCounterparty('kapper bob', ctx.knownCounterparties)).toBeNull();
	});
});

describe('findCategory', () => {
	it('vindt een categorie op het begin of een woord', () => {
		expect(findCategory('bood', ctx.categories)?.id).toBe('c-boodschappen');
		expect(findCategory('uit eten', ctx.categories)?.id).toBe('c-uiteten');
		expect(findCategory('eten', ctx.categories)?.id).toBe('c-uiteten');
		expect(findCategory('bestaatniet', ctx.categories)).toBeNull();
	});
});

describe('resolveEntry', () => {
	it('12,50 ah: Albert Heijn, categorie via regel, SNS, uitgave', () => {
		const d = resolve('12,50 ah');
		expect(d.amountCents).toBe(-1250);
		expect(d.counterparty).toBe('ALBERT HEIJN 1403 UTRECHT');
		expect(d.categoryId).toBe('c-boodschappen');
		expect(d.accountId).toBe('a-sns');
		expect(d.missing).toEqual([]);
	});

	it('$20 netflix rev: dollar op Revolut, eurobedrag nog in te vullen', () => {
		const d = resolve('$20 netflix rev');
		expect(d.amountCents).toBeNull();
		expect(d.origAmountCents).toBe(-2000);
		expect(d.origCurrency).toBe('USD');
		expect(d.accountId).toBe('a-rev');
		expect(d.categoryId).toBe('c-abonnementen');
		expect(d.missing).toContain('eurobedrag');
	});

	it('dollars gaan zonder rekening naar Revolut', () => {
		expect(resolve('$5 app').accountId).toBe('a-rev');
	});

	it('45 etentje voor 3: uit eten, jouw deel 15 euro', () => {
		const d = resolve('45 etentje voor 3');
		expect(d.amountCents).toBe(-4500);
		expect(d.categoryId).toBe('c-uiteten');
		expect(d.people).toBe(3);
		expect(d.myShareCents).toBe(-1500);
	});

	it('+15 tikkie sanne: inkomend, terugbetaling, niet gedeeld', () => {
		const d = resolve('+15 tikkie sanne');
		expect(d.amountCents).toBe(1500);
		expect(d.categoryId).toBe('c-terug');
		expect(d.people).toBe(1);
	});

	it('#categorie gaat voor regels', () => {
		expect(resolve('12 ah #vervoer').categoryId).toBe('c-vervoer');
	});

	it('mist een bedrag', () => {
		expect(resolve('ah').missing).toContain('bedrag');
	});
});
