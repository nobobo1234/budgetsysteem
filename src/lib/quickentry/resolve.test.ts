import { describe, expect, it } from 'vitest';
import { sortRules } from '../rules.ts';
import { parseQuickEntry } from './parser.ts';
import {
	findCategory,
	knownPerson,
	matchCounterparty,
	resolveEntry,
	type OpenPostRef,
	type ResolveContext
} from './resolve.ts';

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

const post = (over: Partial<OpenPostRef> & { id: string }): OpenPostRef => ({
	personId: 'p-sanne',
	personName: 'Sanne',
	direction: 'te_krijgen',
	outstandingCents: 1500,
	description: 'Etentje',
	date: '2026-10-20',
	...over
});

const withPosts: ResolveContext = {
	...ctx,
	people: [
		{ id: 'p-sanne', name: 'Sanne' },
		{ id: 'p-tim', name: 'Tim' }
	],
	openPosts: [
		post({ id: 'o-sanne' }),
		post({ id: 'o-tim', personId: 'p-tim', personName: 'Tim', outstandingCents: 1000 }),
		post({ id: 'o-tim-ik', personId: 'p-tim', personName: 'Tim', direction: 'te_betalen' })
	]
};

const resolveWith = (input: string, date = TODAY) =>
	resolveEntry(
		parseQuickEntry(input, date, {
			accountAliases: ['sns', 'rev'],
			people: withPosts.people!.map((p) => p.name)
		}),
		withPosts
	);

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

describe('voorschieten in de snelinvoer', () => {
	it('€10 met sanne en tim: jij 3,33, Sanne 3,34, Tim 3,33', () => {
		const d = resolveWith('10 lunch met sanne en tim');
		expect(d.people).toBe(3);
		expect(d.myShareCents).toBe(-333);
		expect(d.sharedWith).toEqual(['Sanne', 'Tim']);
		expect(d.otherShares).toEqual([334, 333]);
	});

	it('een onbekende naam blijft zoals getypt', () => {
		expect(resolveWith('10 lunch met eva').sharedWith).toEqual(['eva']);
		expect(knownPerson('SANNE', withPosts.people!)).toBe('Sanne');
	});

	it('bij delen geen koppellijst', () => {
		expect(resolveWith('15 lunch met sanne').candidates).toEqual([]);
	});
});

describe('ontvangen in de snelinvoer', () => {
	it('+15 tikkie sanne: Sanne als tegenpartij, haar post bovenaan', () => {
		const d = resolveWith('+15 tikkie sanne');
		expect(d.counterparty).toBe('Sanne');
		expect(d.description).toBe('tikkie');
		expect(d.categoryId).toBe('c-terug');
		expect(d.candidates[0]?.id).toBe('o-sanne');
		expect(d.candidates[0]?.label).toBe('waarschijnlijk');
		// Alleen posten te krijgen; de post die jij Tim nog moet staat er niet in
		expect(d.candidates.map((c) => c.id)).not.toContain('o-tim-ik');
	});

	it('voorselectie alleen als de bovenste duidelijk voorloopt', () => {
		// Zelfde dag, zelfde bedrag en de naam: duidelijk Sanne
		expect(resolveWith('+15 tikkie sanne', '2026-10-20').preselect).toBe('o-sanne');
		// Alleen het bedrag past bij Tim: hij staat erin, maar je kiest zelf
		const d = resolveWith('+10 tikkie', '2026-10-20');
		expect(d.candidates.map((c) => c.id)).toEqual(['o-tim']);
		expect(d.preselect).toBeNull();
	});

	it('salaris geeft geen koppellijst', () => {
		expect(resolveWith('+2500 salaris').candidates).toEqual([]);
	});

	it('een uitgave aan Tim stelt de post te betalen voor', () => {
		const d = resolveWith('15 tikkie tim');
		expect(d.candidates.map((c) => c.id)).toEqual(['o-tim-ik']);
	});
});
