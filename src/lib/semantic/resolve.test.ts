import { describe, expect, it } from 'vitest';
import { answerSentence, refusalText } from './answer.ts';
import { NO_FILTERS, QuestionFormatSchema, QuerySchema, type Query } from './format.ts';
import { findCounterparties, resolveQuery, type Catalog, type Resolution } from './resolve.ts';

// Het vraagformaat tegen de catalogus (spec: Semantische laag, Vraagformaat): wat niet bestaat,
// wordt geweigerd; een tegenpartij wordt opgezocht tussen de nette namen.

const TODAY = '2026-10-21';

const CATALOG: Catalog = {
	categories: [
		{ id: 'c1', name: 'Boodschappen', group: 'Dagelijks', countsForBudget: true, income: false },
		{
			id: 'c2',
			name: 'Uit eten en bezorgen',
			group: 'Dagelijks',
			countsForBudget: true,
			income: false
		},
		{ id: 'c3', name: 'Wonen', group: 'Vaste lasten', countsForBudget: true, income: false },
		{ id: 'c4', name: 'Inkomen', group: 'Buiten budget', countsForBudget: false, income: true },
		{
			id: 'c5',
			name: 'Sparen en beleggen',
			group: 'Buiten budget',
			countsForBudget: false,
			income: true
		},
		{ id: 'c6', name: 'Café/bar', group: 'Vrije tijd', countsForBudget: true, income: false }
	],
	tags: [{ id: 't1', name: 'Lissabon' }],
	accounts: [{ id: 'a1', name: 'Revolut', alias: 'rev' }],
	counterparties: ['Albert Heijn', 'Albert Heijn To Go', 'Jumbo', 'Kapper Knip', 'Kapper Stijl']
};

function query(
	over: Omit<Partial<Query>, 'filters'> & { filters?: Partial<Query['filters']> } = {}
): Query {
	return QuerySchema.parse({
		maat: 'uitgegeven',
		periode: { woord: 'dit_jaar' },
		groeperen: 'geen',
		sorteren: 'bedrag_aflopend',
		limiet: null,
		aannames: [],
		...over,
		filters: { ...NO_FILTERS, ...over.filters }
	});
}

const resolve = (q: Query, choice?: number) => resolveQuery(q, CATALOG, TODAY, { choice });

function refusal(r: Resolution) {
	return r.ok ? null : r.kind === 'kan_niet' ? r.refusal : 'verduidelijken';
}

describe('Zod-validatie van het vraagformaat', () => {
	it('een onbekende maat, groepering of periode is geen vraagformaat', () => {
		const base = { soort: 'vraag', ...query() };
		expect(QuestionFormatSchema.safeParse(base).success).toBe(true);
		expect(QuestionFormatSchema.safeParse({ ...base, maat: 'saldo' }).success).toBe(false);
		expect(QuestionFormatSchema.safeParse({ ...base, groeperen: 'dag' }).success).toBe(false);
		expect(
			QuestionFormatSchema.safeParse({ ...base, periode: { woord: 'volgend_jaar' } }).success
		).toBe(false);
		expect(QuestionFormatSchema.safeParse({ ...base, limiet: 1001 }).success).toBe(false);
		expect(QuestionFormatSchema.safeParse({ ...base, extra: 'veld' }).success).toBe(false);
	});

	it('een verduidelijking heeft twee tot vier keuzes', () => {
		const ok = { soort: 'verduidelijken', vraag: 'Welke bedoel je?', keuzes: ['a', 'b'] };
		expect(QuestionFormatSchema.safeParse(ok).success).toBe(true);
		expect(QuestionFormatSchema.safeParse({ ...ok, keuzes: ['a'] }).success).toBe(false);
		expect(
			QuestionFormatSchema.safeParse({ ...ok, keuzes: ['a', 'b', 'c', 'd', 'e'] }).success
		).toBe(false);
	});
});

describe('wat bestaat', () => {
	it('een onbekende categorie, groep, tag of rekening wordt geweigerd', () => {
		expect(refusal(resolve(query({ filters: { categorieen: ['Snoepgoed'] } })))).toBe('categorie');
		expect(refusal(resolve(query({ filters: { groepen: ['Luxe'] } })))).toBe('groep');
		expect(refusal(resolve(query({ filters: { tag: 'Parijs' } })))).toBe('tag');
		expect(refusal(resolve(query({ filters: { rekening: 'ING' } })))).toBe('rekening');
	});

	it('namen tellen zonder hoofdletters en zoals het model ze kreeg', () => {
		const r = resolve(query({ filters: { categorieen: ['boodschappen', 'Café bar'] } }));
		expect(r.ok && r.resolved.categories?.map((c) => c.id)).toEqual(['c1', 'c6']);
		const rev = resolve(query({ filters: { rekening: 'rev' } }));
		expect(rev.ok && rev.resolved.account).toEqual({ id: 'a1', name: 'Revolut' });
	});

	it('een groep wordt haar categorieën', () => {
		const r = resolve(query({ filters: { groepen: ['dagelijks'] } }));
		expect(r.ok && r.resolved.categories?.map((c) => c.id)).toEqual(['c1', 'c2']);
		expect(r.ok && r.resolved.categoryLabels).toEqual(['de groep Dagelijks']);
	});

	it('uitgaven alleen in budgetcategorieën, inkomsten alleen in categorieën voor inkomen', () => {
		expect(refusal(resolve(query({ filters: { categorieen: ['Sparen en beleggen'] } })))).toBe(
			'categorie'
		);
		expect(
			refusal(resolve(query({ maat: 'inkomsten', filters: { categorieen: ['Inkomen'] } })))
		).toBeNull();
		expect(
			refusal(resolve(query({ maat: 'inkomsten', filters: { categorieen: ['Wonen'] } })))
		).toBe('categorie');
	});
});

describe('wat een maat kan', () => {
	it('filters en groeperingen die een maat niet kent, worden geweigerd', () => {
		expect(refusal(resolve(query({ maat: 'netto', filters: { categorieen: ['Wonen'] } })))).toBe(
			'filter'
		);
		expect(refusal(resolve(query({ maat: 'te_krijgen', groeperen: 'maand' })))).toBe('groepering');
		expect(refusal(resolve(query({ maat: 'limiet', filters: { tegenpartij: 'Jumbo' } })))).toBe(
			'filter'
		);
	});

	it('productgroepen gaan zonder andere filters', () => {
		expect(refusal(resolve(query({ filters: { productgroep: 'alcohol' } })))).toBeNull();
		expect(
			refusal(resolve(query({ filters: { productgroep: 'alcohol', tegenpartij: 'Jumbo' } })))
		).toBe('productgroep');
		expect(
			refusal(resolve(query({ groeperen: 'productgroep', filters: { categorieen: ['Wonen'] } })))
		).toBe('productgroep');
	});

	it('een tag gaat niet samen met een tegenpartij of rekening', () => {
		expect(refusal(resolve(query({ filters: { tag: 'Lissabon', rekening: 'Revolut' } })))).toBe(
			'filter'
		);
		expect(refusal(resolve(query({ groeperen: 'tag', filters: { tegenpartij: 'Jumbo' } })))).toBe(
			'filter'
		);
	});

	it('resterend voor één maand, een gemiddelde over minstens één volle maand', () => {
		expect(refusal(resolve(query({ maat: 'resterend' })))).toBe('een_maand');
		expect(
			refusal(resolve(query({ maat: 'resterend', periode: { woord: 'deze_maand' } })))
		).toBeNull();
		expect(
			refusal(resolve(query({ maat: 'gemiddeld_per_maand', periode: { woord: 'deze_maand' } })))
		).toBe('geen_volle_maand');
	});

	it('een periode in de toekomst', () => {
		expect(refusal(resolve(query({ periode: { van: '2027-01', tot: '2027-12' } })))).toBe(
			'periode_toekomst'
		);
	});
});

describe('tegenpartijen opzoeken', () => {
	it('een gelijke naam wint van namen die ermee beginnen', () => {
		expect(findCounterparties('albert heijn', CATALOG.counterparties)).toEqual(['Albert Heijn']);
		expect(findCounterparties('Jumbo', CATALOG.counterparties)).toEqual(['Jumbo']);
	});

	it('anders de namen waarin de tekst aan het begin van een woord staat', () => {
		expect(findCounterparties('heijn to', CATALOG.counterparties)).toEqual(['Albert Heijn To Go']);
		expect(findCounterparties('kapper', CATALOG.counterparties)).toEqual([
			'Kapper Knip',
			'Kapper Stijl'
		]);
		// Midden in een woord telt niet
		expect(findCounterparties('umbo', CATALOG.counterparties)).toEqual([]);
	});

	it('één treffer gebruiken, meer verduidelijken, geen weigeren', () => {
		const one = resolve(query({ filters: { tegenpartij: 'jumbo' } }));
		expect(one.ok && one.resolved.counterparty).toBe('Jumbo');
		expect(one.ok && one.resolved.assumptions).toEqual(['tegenpartij = Jumbo']);

		const more = resolve(query({ filters: { tegenpartij: 'kapper' } }));
		expect(more).toEqual({
			ok: false,
			kind: 'verduidelijken',
			refusal: 'tegenpartij',
			choices: ['Kapper Knip', 'Kapper Stijl']
		});
		const chosen = resolve(query({ filters: { tegenpartij: 'kapper' } }), 1);
		expect(chosen.ok && chosen.resolved.counterparty).toBe('Kapper Stijl');

		expect(refusal(resolve(query({ filters: { tegenpartij: 'Lidl' } })))).toBe('tegenpartij');
	});

	it('meer dan vier treffers: te vaag', () => {
		const many: Catalog = {
			...CATALOG,
			counterparties: ['Shop A', 'Shop B', 'Shop C', 'Shop D', 'Shop E']
		};
		const r = resolveQuery(query({ filters: { tegenpartij: 'shop' } }), many, TODAY);
		expect(refusal(r)).toBe('tegenpartij_vaag');
	});
});

// Intl zet een harde spatie tussen € en het bedrag; voor de vergelijking maakt dat niet uit
const plain = (text: string) => text.replace(/\s/g, ' ');

describe('de zin uit de template', () => {
	it('bedrag, onderwerp en periode komen uit code', () => {
		const r = resolve(query({ filters: { categorieen: ['Uit eten en bezorgen'] } }));
		if (!r.ok) throw new Error('verwacht een vraag');
		expect(plain(answerSentence(r.resolved, 128450))).toBe(
			'€ 1.284,50 aan Uit eten en bezorgen, 1 januari tot en met 21 oktober 2026'
		);
	});

	it('per saldo terug, over de limiet, te krijgen', () => {
		const shop = resolve(query({ filters: { tegenpartij: 'jumbo' } }));
		if (!shop.ok) throw new Error('verwacht een vraag');
		expect(plain(answerSentence(shop.resolved, -1200))).toBe(
			'€ 12,00 per saldo terug bij Jumbo, 1 januari tot en met 21 oktober 2026'
		);
		const rest = resolve(query({ maat: 'resterend', periode: { woord: 'deze_maand' } }));
		if (!rest.ok) throw new Error('verwacht een vraag');
		expect(plain(answerSentence(rest.resolved, -500))).toBe(
			'€ 5,00 over de limiet, 1 oktober tot en met 21 oktober 2026'
		);
		const owed = resolve(query({ maat: 'te_krijgen', periode: { woord: 'deze_maand' } }));
		if (!owed.ok) throw new Error('verwacht een vraag');
		expect(plain(answerSentence(owed.resolved, 2350))).toBe('Nog € 23,50 te krijgen van anderen');
	});

	it('elke weigering heeft een zin', () => {
		expect(refusalText('categorie', 'Snoepgoed')).toContain('"Snoepgoed"');
		expect(refusalText('periode_toekomst')).toMatch(/nog/);
	});
});
