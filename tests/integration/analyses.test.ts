import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	monthAnalysis,
	reservedByMonth,
	spendingParts,
	trendAnalysis,
	yearAnalysis
} from '../../src/lib/server/analyses.ts';
import { monthOverview, spendingByCategory } from '../../src/lib/server/budgets.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	accounts,
	categories,
	recurring,
	reservations,
	transactionSplits,
	transactions
} from '../../src/lib/server/db/schema.ts';
import { load as monthLoad } from '../../src/routes/(app)/analyses/+page.server.ts';
import { load as yearLoad } from '../../src/routes/(app)/analyses/jaar/+page.server.ts';
import { tempDatabase } from './helpers.ts';

// Analyses (spec: Analyses → Zonder AI) tegen een echte SQLite-database: dezelfde optelling
// als Budget, met vaste lasten herkend aan hun koppeling of hun sleutel.

// Alleen test-IBANs (scripts/test-ibans.txt)
const RENT_IBAN = 'NL20INGB0001234567';

const TODAY = '2026-10-21';

let db: DB;
let cleanup: () => void;
let sns: string;
let cat: (name: string) => string;

beforeEach(() => {
	({ db, cleanup } = tempDatabase());
	sns = db.select().from(accounts).where(eq(accounts.alias, 'sns')).get()!.id;
	cat = (name) => db.select().from(categories).where(eq(categories.name, name)).get()!.id;
});
afterEach(() => {
	vi.useRealTimers();
	cleanup();
});

function tx(
	date: string,
	cents: number,
	counterparty: string,
	over: Partial<typeof transactions.$inferInsert> = {}
): string {
	return db
		.insert(transactions)
		.values({
			amountCents: -cents,
			date,
			counterparty,
			accountId: sns,
			source: 'handmatig',
			status: 'bevestigd',
			...over
		})
		.returning({ id: transactions.id })
		.get().id;
}

function rent(status: 'actief' | 'gestopt' = 'actief', name = 'woonstichting'): string {
	return db
		.insert(recurring)
		.values({
			matchKey: `${name}|${RENT_IBAN}`,
			counterparty: 'Woonstichting',
			counterIban: RENT_IBAN,
			interval: 'maand',
			expectedDay: 1,
			medianCents: 85000,
			minCents: 85000,
			maxCents: 85000,
			kind: 'vast',
			nextDate: '2026-11-01',
			accountId: sns,
			categoryId: cat('Wonen'),
			status
		})
		.returning({ id: recurring.id })
		.get().id;
}

describe('geboekte delen', () => {
	it('alleen budgetcategorieën en zonder categorie; verwachte posten tellen niet', () => {
		tx('2026-10-02', 2500, 'Albert Heijn', { categoryId: cat('Boodschappen') });
		tx('2026-10-03', 900, 'Onbekend');
		tx('2026-10-04', 50000, 'Spaarrekening', { categoryId: cat('Sparen en beleggen') });
		tx('2026-10-05', 1000, 'Interne', { categoryId: cat('Interne overboeking') });
		tx('2026-10-25', 4000, 'Later', { categoryId: cat('Boodschappen'), status: 'verwacht' });
		const parts = spendingParts(db, '2026-10-01', '2026-10-31');
		expect(parts.map((p) => [p.counterparty, p.cents]).sort()).toEqual([
			['Albert Heijn', 2500],
			['Onbekend', 900]
		]);
	});

	it('een verdeling telt per regel, een terugboeking op de datum van de boeking', () => {
		const shared = tx('2026-10-06', 3000, 'Pizzeria', { categoryId: cat('Uit eten en bezorgen') });
		db.insert(transactionSplits)
			.values([
				{ transactionId: shared, categoryId: cat('Uit eten en bezorgen'), amountCents: -1000 },
				{ transactionId: shared, categoryId: cat('Terugbetaling'), amountCents: -2000 }
			])
			.run();
		const original = tx('2026-09-28', 6000, 'Zalando', { categoryId: cat('Kleding') });
		tx('2026-10-08', -6000, 'Zalando', { categoryId: cat('Kleding'), correctionOf: original });

		const october = spendingParts(db, '2026-10-01', '2026-10-31');
		expect(october).toEqual([
			expect.objectContaining({ id: shared, cents: 1000, categoryId: cat('Uit eten en bezorgen') })
		]);
		const september = spendingParts(db, '2026-09-01', '2026-09-30');
		expect(september.map((p) => [p.date, p.cents]).sort()).toEqual([
			['2026-09-28', -6000],
			['2026-09-28', 6000]
		]);
		// Hetzelfde als Budget telt
		expect(spendingByCategory(db, '2026-09').get(cat('Kleding'))).toBe(0);
	});

	it('vaste lasten: gekoppeld, of uit de historie met dezelfde sleutel', () => {
		const id = rent();
		const linked = tx('2026-10-01', 85000, 'Woonstichting', {
			counterIban: RENT_IBAN,
			categoryId: cat('Wonen'),
			recurringId: id
		});
		const history = tx('2026-08-01', 85000, 'WOONSTICHTING', {
			counterIban: RENT_IBAN,
			categoryId: cat('Wonen'),
			source: 'import'
		});
		const other = tx('2026-08-02', 85000, 'Woonstichting', { categoryId: cat('Wonen') });
		const fixed = new Map(
			spendingParts(db, '2026-08-01', '2026-10-31').map((p) => [p.id, p.fixed])
		);
		expect(fixed.get(linked)).toBe(true);
		expect(fixed.get(history)).toBe(true);
		// Zonder IBAN is het een andere sleutel
		expect(fixed.get(other)).toBe(false);
	});

	it('reserveringen per maand: opzij min eruit gehaald, alleen budgetcategorieën', () => {
		const id = rent();
		const other = rent('gestopt', 'bank');
		db.insert(reservations)
			.values([
				{ recurringId: id, month: '2026-09', amountCents: 1500, categoryId: cat('Sport') },
				{
					recurringId: id,
					month: '2026-10',
					amountCents: 1500,
					drawnCents: 3000,
					categoryId: cat('Sport')
				},
				{
					recurringId: other,
					month: '2026-10',
					amountCents: 999,
					categoryId: cat('Sparen en beleggen')
				}
			])
			.run();
		expect(reservedByMonth(db, '2026-09', '2026-10')).toEqual([
			{ month: '2026-09', categoryId: cat('Sport'), cents: 1500 },
			{ month: '2026-10', categoryId: cat('Sport'), cents: -1500 }
		]);
	});
});

describe('maandoverzicht en verwachting', () => {
	it('verwachting: uitgegeven + verwachte vaste lasten + gemiddeld per resterende dag', () => {
		const id = rent();
		// Drie volledige maanden met €300 aan variabele uitgaven en de huur
		for (const m of ['2026-07', '2026-08', '2026-09']) {
			tx(`${m}-01`, 85000, 'Woonstichting', {
				counterIban: RENT_IBAN,
				categoryId: cat('Wonen'),
				recurringId: id
			});
			tx(`${m}-12`, 30000, 'Albert Heijn', { categoryId: cat('Boodschappen') });
		}
		// Deze maand: €120 boodschappen; de huur staat nog als verwachte post
		tx('2026-10-05', 12000, 'Albert Heijn', { categoryId: cat('Boodschappen') });
		tx('2026-10-28', 85000, 'Woonstichting', {
			counterIban: RENT_IBAN,
			categoryId: cat('Wonen'),
			recurringId: id,
			status: 'verwacht',
			source: 'verwacht'
		});

		const a = monthAnalysis(db, '2026-10', TODAY);
		const daily = Math.floor(90000 / (31 + 31 + 30));
		expect(a.forecast).toEqual({
			spentCents: 12000,
			plannedLeftCents: 85000,
			variableLeftCents: daily * 10,
			daysLeft: 10,
			totalCents: 12000 + 85000 + daily * 10
		});
		expect(a.spentCents).toBe(12000);
		expect(a.cumulative).toHaveLength(21);
		expect(a.cumulative.at(-1)).toBe(12000);
		expect(a.top).toEqual([
			expect.objectContaining({ name: 'Albert Heijn', cents: 12000, count: 1 })
		]);
		expect(a.lines.find((l) => l.name === 'Boodschappen')?.spentCents).toBe(12000);
	});

	it('een uitgesmeerde last telt met zijn reservering, apart van de uitgaven', () => {
		const club = db
			.insert(recurring)
			.values({
				matchKey: 'vereniging|',
				counterparty: 'Vereniging',
				interval: 'halfjaar',
				expectedDay: 1,
				medianCents: 9000,
				minCents: 9000,
				maxCents: 9000,
				kind: 'vast',
				nextDate: '2027-01-01',
				accountId: sns,
				categoryId: cat('Sport'),
				spread: true,
				status: 'actief'
			})
			.returning({ id: recurring.id })
			.get().id;
		db.insert(reservations)
			.values({ recurringId: club, month: '2026-10', amountCents: 1500, categoryId: cat('Sport') })
			.run();
		tx('2026-10-10', 800, 'Sporthal', { categoryId: cat('Sport') });

		const a = monthAnalysis(db, '2026-10', TODAY);
		const sport = a.lines.find((l) => l.name === 'Sport')!;
		expect(sport).toMatchObject({ spentCents: 800, reservedCents: 1500 });
		expect(a.reservedCents).toBe(1500);
		expect(a.reserves).toEqual([
			expect.objectContaining({ counterparty: 'Vereniging', reservedCents: 1500 })
		]);
		// Uitgegeven en vaste lasten tellen de reservering, net als Budget
		expect(a.spentCents).toBe(2300);
		expect(a.fixedCents).toBe(1500);
		expect(monthOverview(db, '2026-10', TODAY).totalSpentCents).toBe(2300);
		// Geen afschrijving deze maand: alleen de reservering, niet de €90
		expect(a.forecast!.plannedLeftCents).toBe(0);
	});

	it('een afgelopen maand heeft geen verwachting, wel de hele lijn', () => {
		tx('2026-09-30', 1000, 'Bakker', { categoryId: cat('Boodschappen') });
		const a = monthAnalysis(db, '2026-09', TODAY);
		expect(a.forecast).toBeNull();
		expect(a.cumulative).toHaveLength(30);
		expect(a.cumulative.at(-1)).toBe(1000);
		expect(a.hasEarlier).toBe(false);
	});

	it('de pagina toont geen maand die nog moet komen', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 9, 21, 12));
		const url = (q: string) => ({ url: new URL(`http://localhost/analyses${q}`) }) as never;
		const future = monthLoad(url('?maand=2027-01')) as { analysis: { month: string } };
		expect(future.analysis.month).toBe('2026-10');
		const past = monthLoad(url('?maand=2026-03')) as { analysis: { month: string }; next: string };
		expect(past.analysis.month).toBe('2026-03');
		expect(past.next).toBe('2026-04');
		const odd = monthLoad(url('?maand=2026-13')) as { analysis: { month: string } };
		expect(odd.analysis.month).toBe('2026-10');
	});
});

describe('trend en jaar', () => {
	it('twaalf maanden, met het gemiddelde over de volledige maanden', () => {
		const id = rent();
		for (const m of ['2026-08', '2026-09']) {
			tx(`${m}-01`, 85000, 'Woonstichting', {
				counterIban: RENT_IBAN,
				categoryId: cat('Wonen'),
				recurringId: id
			});
			tx(`${m}-15`, 15000, 'Albert Heijn', { categoryId: cat('Boodschappen') });
		}
		tx('2026-10-02', 5000, 'Albert Heijn', { categoryId: cat('Boodschappen') });

		const t = trendAnalysis(db, TODAY);
		expect(t.months).toHaveLength(12);
		expect(t.months[0]).toBe('2025-11');
		expect(t.totals.at(-1)).toMatchObject({ month: '2026-10', spentCents: 5000 });
		// Augustus en september; oktober loopt nog
		expect(t.averageCents).toBe(100000);
		expect(t.fixedShare).toBeCloseTo(0.85);
		const groceries = t.categories.find((c) => c.name === 'Boodschappen')!;
		expect(groceries.values.slice(-3)).toEqual([15000, 15000, 5000]);
		expect(groceries.averageCents).toBe(15000);
		expect(t.categories[0]!.name).toBe('Wonen');
	});

	it('jaaroverzicht tegenover dezelfde maanden een jaar eerder', () => {
		tx('2025-03-10', 20000, 'Albert Heijn', { categoryId: cat('Boodschappen') });
		tx('2025-11-10', 99999, 'Later in het jaar', { categoryId: cat('Kleding') });
		tx('2026-02-10', 12000, 'Albert Heijn', { categoryId: cat('Boodschappen') });
		tx('2026-10-10', 3000, 'Bol.com', { categoryId: cat('Elektronica') });

		const y = yearAnalysis(db, 2026, TODAY);
		expect(y.months).toHaveLength(10);
		expect(y.spentCents).toBe(15000);
		// Januari tot en met oktober 2025: november telt niet mee
		expect(y.previousCents).toBe(20000);
		expect(y.categories.map((c) => [c.name, c.cents])).toEqual([
			['Boodschappen', 12000],
			['Elektronica', 3000]
		]);
		expect(y.top[0]).toMatchObject({ name: 'Albert Heijn', cents: 12000 });
		expect(y.hasEarlier).toBe(true);
		expect(y.hasLater).toBe(false);

		const last = yearAnalysis(db, 2025, TODAY);
		expect(last.months).toHaveLength(12);
		expect(last.spentCents).toBe(119999);
		expect(last.previousCents).toBeNull();
		expect(last.hasLater).toBe(true);
	});

	it('de pagina kiest geen jaar dat nog moet komen', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 9, 21, 12));
		const url = (q: string) => ({ url: new URL(`http://localhost/analyses/jaar${q}`) }) as never;
		expect((yearLoad(url('?jaar=2031')) as { year: { year: number } }).year.year).toBe(2026);
		expect((yearLoad(url('?jaar=2025')) as { year: { year: number } }).year.year).toBe(2025);
		expect((yearLoad(url('?jaar=abc')) as { year: { year: number } }).year.year).toBe(2026);
	});
});
