// De semantische laag tegen een echte SQLite-database met de geanonimiseerde fixture (spec:
// Semantische laag, Tests; Vraagveld, Tests): elke maat geeft hetzelfde getal als Budget en
// Analyses, en elk vraagformaat in de goudset geeft de verwachte uitkomst.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monthAnalysis, trendAnalysis, yearAnalysis } from '../../src/lib/server/analyses.ts';
import { monthOverview } from '../../src/lib/server/budgets.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import { groceryOverview } from '../../src/lib/server/groceries.ts';
import { owedOverview } from '../../src/lib/server/owed.ts';
import { catalog, runQuery } from '../../src/lib/server/semantic.ts';
import { monthlyIncome } from '../../src/lib/server/startLimits.ts';
import { tagSummaries } from '../../src/lib/server/tags.ts';
import { NO_FILTERS, type Filters, type Query } from '../../src/lib/semantic/format.ts';
import type { Answer } from '../../src/lib/semantic/answer.ts';
import { modelName } from '../../src/lib/text.ts';
import { buildFixture, FIXTURE_TODAY as TODAY } from '../fixtures/vraag/fixture.ts';
import { GOUDSET } from '../fixtures/vraag/goudset.ts';
import { tempDatabase } from './helpers.ts';

let db: DB;
let cleanup: () => void;
beforeAll(() => {
	({ db, cleanup } = tempDatabase());
	buildFixture(db);
});
afterAll(() => cleanup());

function query(
	maat: Query['maat'],
	periode: Query['periode'],
	filters: Partial<Filters> = {},
	over: Partial<Query> = {}
): Query {
	return {
		maat,
		periode,
		filters: { ...NO_FILTERS, ...filters },
		groeperen: 'geen',
		sorteren: 'bedrag_aflopend',
		limiet: null,
		aannames: [],
		...over
	};
}

function answer(q: Query): Answer {
	const r = runQuery(db, q, TODAY);
	if (!r.ok) throw new Error(`geen antwoord: ${JSON.stringify(r)}`);
	return r.answer;
}

const rows = (a: Answer) => (a.rows ?? []).map((r): [string, number] => [r.label, r.value]);
const MONTH = { woord: 'deze_maand' } as const;

describe('hetzelfde getal als Budget en Analyses', () => {
	it('uitgegeven en vaste lasten deze maand, zoals op Analyses', () => {
		const screen = monthAnalysis(db, '2026-10', TODAY);
		expect(answer(query('uitgegeven', MONTH)).value).toBe(screen.spentCents);
		expect(answer(query('vaste_lasten', MONTH)).value).toBe(screen.fixedCents);
	});

	it('per categorie, met reserveringen, zoals op Budget', () => {
		const overview = monthOverview(db, '2026-10', TODAY);
		const byCategory = new Map(
			rows(answer(query('uitgegeven', MONTH, {}, { groeperen: 'categorie' })))
		);
		for (const line of overview.lines.filter((l) => l.spentCents > 0))
			expect(byCategory.get(line.name)).toBe(line.spentCents);
		const wonen = answer(query('uitgegeven', MONTH, { categorieen: ['Verzekeringen'] }));
		expect(wonen.value).toBe(overview.lines.find((l) => l.name === 'Verzekeringen')!.spentCents);
	});

	it('limiet en nog vrij, zoals op Budget', () => {
		const overview = monthOverview(db, '2026-10', TODAY);
		expect(answer(query('limiet', MONTH)).value).toBe(overview.totalLimitCents);
		expect(answer(query('resterend', MONTH)).value).toBe(overview.freeCents);
		const food = overview.lines.find((l) => l.name === 'Boodschappen')!;
		expect(answer(query('resterend', MONTH, { categorieen: ['Boodschappen'] })).value).toBe(
			food.limitCents - food.spentCents
		);
	});

	it('dit jaar: totaal, per categorie en de grootste tegenpartijen, zoals op Jaar', () => {
		const year = yearAnalysis(db, 2026, TODAY);
		const dit = { woord: 'dit_jaar' } as const;
		expect(answer(query('uitgegeven', dit)).value).toBe(year.spentCents);
		expect(answer(query('vaste_lasten', dit)).value).toBe(year.fixedCents);
		expect(rows(answer(query('uitgegeven', dit, {}, { groeperen: 'categorie' })))).toEqual(
			year.categories.map((c) => [c.name, c.cents])
		);
		expect(
			rows(answer(query('uitgegeven', dit, {}, { groeperen: 'tegenpartij', limiet: 10 })))
		).toEqual(year.top.map((t) => [modelName(t.name), t.cents]));
		expect(
			rows(answer(query('uitgegeven', dit, {}, { groeperen: 'maand', sorteren: 'periode' })))
		).toEqual(year.totals.map((t) => [expect.any(String), t.spentCents]));
	});

	it('gemiddeld per maand, zoals op Trend', () => {
		const trend = trendAnalysis(db, TODAY);
		// Trend kijkt twaalf maanden terug tot en met deze maand, die niet meetelt
		const period = { van: trend.months[0]!, tot: trend.months.at(-1)! };
		expect(answer(query('gemiddeld_per_maand', period)).value).toBe(trend.averageCents);
		const perCategory = new Map(
			rows(answer(query('gemiddeld_per_maand', period, {}, { groeperen: 'categorie' })))
		);
		// Een categorie met alleen uitgaven in de lopende maand heeft gemiddeld nul: geen rij
		for (const c of trend.categories) expect(perCategory.get(c.name) ?? 0).toBe(c.averageCents);
	});

	it('inkomsten, zoals bij de startlimieten', () => {
		const months = ['2026-07', '2026-08', '2026-09'];
		const perMonth = rows(
			answer(
				query(
					'inkomsten',
					{ van: '2026-07', tot: '2026-09' },
					{},
					{
						groeperen: 'maand',
						sorteren: 'periode'
					}
				)
			)
		).map(([, v]) => v);
		expect(perMonth).toEqual(monthlyIncome(db, months));
	});

	it('te krijgen, zoals op Te krijgen', () => {
		expect(answer(query('te_krijgen', MONTH)).value).toBe(owedOverview(db, TODAY).toReceiveCents);
	});

	it('een tag, zoals op de pagina van de tag', () => {
		const lisbon = tagSummaries(db, TODAY).find((t) => t.name === 'Lissabon')!;
		expect(answer(query('uitgegeven', { woord: 'alles' }, { tag: 'Lissabon' })).value).toBe(
			lisbon.totalCents
		);
		expect(
			rows(
				answer(
					query('uitgegeven', { woord: 'alles' }, { tag: 'Lissabon' }, { groeperen: 'categorie' })
				)
			)
		).toEqual(lisbon.byCategory.map((c) => [c.name, c.cents]));
	});

	it('productgroepen, zoals op Boodschappen', () => {
		const screen = groceryOverview(db, '2026-10');
		const byGroup = new Map(
			(answer(query('uitgegeven', MONTH, {}, { groeperen: 'productgroep' })).rows ?? []).map(
				(r) => [r.key, r.value]
			)
		);
		for (const row of screen.rows) expect(byGroup.get(row.bucket)).toBe(row.cents);
	});
});

describe('valkuilen', () => {
	it('sparen en interne overboekingen tellen nooit als uitgave of inkomen', () => {
		const a = answer(
			query('uitgegeven', { van: '2026-03', tot: '2026-03' }, {}, { groeperen: 'categorie' })
		);
		const names = rows(a).map(([n]) => n);
		expect(names).not.toContain('Sparen en beleggen');
		expect(names).not.toContain('Interne overboeking');
		const income = answer(query('inkomsten', { van: '2026-03', tot: '2026-03' }));
		expect(income.value).toBe(285000);
	});

	it('een terugbetaling van een huisgenoot is geen inkomen; een gesplitste bon telt jouw deel', () => {
		expect(answer(query('inkomsten', { van: '2026-09', tot: '2026-09' })).value).toBe(285000);
		expect(
			answer(
				query('uitgegeven', { van: '2026-09-14', tot: '2026-09-14' }, { tegenpartij: 'Pizzeria' })
			).value
		).toBe(2000);
	});

	it('filialen tellen samen via de nette naam', () => {
		const a = answer(
			query('aantal', { van: '2026-10', tot: '2026-10' }, { tegenpartij: 'albert heijn' })
		);
		// Vier keer per maand tot en met de 17e, plus de boodschap met bon op de 11e
		expect(a.value).toBe(4);
		expect(a.assumptions).toContain('tegenpartij = Albert Heijn');
	});

	it('een vraag die code niet kent, geeft geen getal', () => {
		expect(
			runQuery(db, query('uitgegeven', MONTH, { categorieen: ['Snoep'] }), TODAY)
		).toMatchObject({
			ok: false,
			kind: 'kan_niet',
			refusal: 'categorie'
		});
		expect(
			runQuery(db, query('uitgegeven', MONTH, { tegenpartij: 'kapper' }), TODAY)
		).toMatchObject({
			ok: false,
			kind: 'verduidelijken',
			choices: ['Kapper Knip Test', 'Kapper Stijl Test']
		});
	});

	it('naar het model gaan geen tegenpartijen, alleen de eigen namen', () => {
		const c = catalog(db);
		expect(c.counterparties).toContain('Albert Heijn');
		expect(c.counterparties).toContain('Thuisbezorgd');
		expect(c.counterparties).not.toContain('ALBERT HEIJN 1403 UTRECHT');
	});

	it('de limiet stopt bij de rijen, het totaal niet', () => {
		const a = answer(
			query('uitgegeven', { woord: 'dit_jaar' }, {}, { groeperen: 'tegenpartij', limiet: 2 })
		);
		expect(a.rows).toHaveLength(2);
		expect(a.rowCount).toBeGreaterThan(2);
	});
});

describe('de goudset van de vraag-eval', () => {
	it('heeft minstens 40 vragen, met valkuilen en vragen die niet passen', () => {
		expect(GOUDSET.length).toBeGreaterThanOrEqual(40);
		expect(new Set(GOUDSET.map((g) => g.id)).size).toBe(GOUDSET.length);
		expect(GOUDSET.filter((g) => g.verwacht.soort === 'kan_niet').length).toBeGreaterThanOrEqual(5);
		expect(
			GOUDSET.filter((g) => g.verwacht.soort === 'verduidelijken').length
		).toBeGreaterThanOrEqual(2);
	});

	for (const g of GOUDSET) {
		const v = g.verwacht;
		if (v.soort !== 'vraag') continue;
		it(`${g.id}: ${g.vraag}`, () => {
			const a = answer(v.query);
			expect(a.value).toBe(v.waarde);
			if (v.rijen) expect(rows(a).slice(0, v.rijen.length)).toEqual(v.rijen);
			for (const alt of v.ook ?? []) expect(answer(alt.query).value).toBe(alt.waarde);
		});
	}
});
