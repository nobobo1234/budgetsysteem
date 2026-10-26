import { describe, expect, it } from 'vitest';
import {
	categorySeries,
	categoryTotals,
	cells,
	cumulativeByDay,
	dailyVariable,
	monthForecast,
	monthTotals,
	monthsFrom,
	topCounterparties,
	type Part
} from './analyses.ts';

let n = 0;
function part(over: Partial<Part> & Pick<Part, 'date' | 'cents'>): Part {
	return {
		id: `t${++n}`,
		categoryId: 'boodschappen',
		counterparty: 'Winkel',
		fixed: false,
		...over
	};
}

describe('uitgaven per maand en categorie', () => {
	it('telt delen op en reserveringen als vaste uitgave', () => {
		const list = cells(
			[
				part({ date: '2026-09-03', cents: 2000 }),
				part({ date: '2026-09-20', cents: 500 }),
				part({ date: '2026-09-01', cents: 85000, categoryId: 'wonen', fixed: true }),
				part({ date: '2026-10-02', cents: 1200 })
			],
			[{ month: '2026-09', categoryId: 'vereniging', cents: 1500 }]
		);
		const at = (month: string, id: string) =>
			list.find((c) => c.month === month && c.categoryId === id);
		expect(at('2026-09', 'boodschappen')).toMatchObject({ spentCents: 2500, fixedCents: 0 });
		expect(at('2026-09', 'wonen')).toMatchObject({ spentCents: 85000, fixedCents: 85000 });
		expect(at('2026-09', 'vereniging')).toMatchObject({ spentCents: 1500, fixedCents: 1500 });
		expect(at('2026-10', 'boodschappen')).toMatchObject({ spentCents: 1200 });
	});

	it('een retour groter dan de uitgaven geeft geen ruimte terug, zoals op Budget', () => {
		const list = cells([
			part({ date: '2026-10-02', cents: 3000 }),
			part({ date: '2026-10-05', cents: -5000 })
		]);
		expect(list).toEqual([
			{ month: '2026-10', categoryId: 'boodschappen', spentCents: 0, fixedCents: 0 }
		]);
	});

	it('het vaste deel is nooit meer dan de uitgaven en nooit negatief', () => {
		const [cell] = cells([
			part({ date: '2026-10-01', cents: 4000, fixed: true }),
			part({ date: '2026-10-09', cents: -3000 })
		]);
		expect(cell).toMatchObject({ spentCents: 1000, fixedCents: 1000 });
		const [refund] = cells([
			part({ date: '2026-10-01', cents: 2000 }),
			part({ date: '2026-10-02', cents: -500, fixed: true })
		]);
		expect(refund).toMatchObject({ spentCents: 1500, fixedCents: 0 });
	});

	it('totalen per maand, ook voor maanden zonder uitgaven', () => {
		const list = cells([
			part({ date: '2026-08-10', cents: 1000 }),
			part({ date: '2026-08-01', cents: 50000, categoryId: 'wonen', fixed: true }),
			part({ date: '2026-10-10', cents: 700 })
		]);
		expect(monthTotals(list, monthsFrom('2026-08', '2026-10'))).toEqual([
			{ month: '2026-08', spentCents: 51000, fixedCents: 50000, variableCents: 1000 },
			{ month: '2026-09', spentCents: 0, fixedCents: 0, variableCents: 0 },
			{ month: '2026-10', spentCents: 700, fixedCents: 0, variableCents: 700 }
		]);
	});

	it('maanden over de jaargrens, per categorie en de categorieën op volgorde', () => {
		expect(monthsFrom('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
		expect(monthsFrom('2026-03', '2026-02')).toEqual([]);
		const list = cells([
			part({ date: '2025-12-24', cents: 4000, categoryId: 'cadeaus' }),
			part({ date: '2026-01-04', cents: 1000 }),
			part({ date: '2026-01-05', cents: 900, categoryId: null })
		]);
		const months = monthsFrom('2025-12', '2026-01');
		expect(categorySeries(list, months, 'cadeaus')).toEqual([4000, 0]);
		expect(categorySeries(list, months, null)).toEqual([0, 900]);
		expect(categoryTotals(list)).toEqual([
			{ categoryId: 'cadeaus', cents: 4000 },
			{ categoryId: 'boodschappen', cents: 1000 },
			{ categoryId: null, cents: 900 }
		]);
	});
});

describe('topuitgaven per tegenpartij', () => {
	it('filialen tellen samen via de nette naam, een retour verlaagt het totaal', () => {
		const top = topCounterparties([
			part({ date: '2026-10-01', cents: 3000, counterparty: 'ALBERT HEIJN 1403 UTRECHT' }),
			part({ date: '2026-10-03', cents: 2000, counterparty: 'ALBERT HEIJN 2201 AMSTERDAM' }),
			part({ date: '2026-10-04', cents: -500, counterparty: 'Albert Heijn' }),
			part({ date: '2026-10-05', cents: 6000, counterparty: 'Bol.com' }),
			part({ date: '2026-10-06', cents: -900, counterparty: 'Retourwinkel' })
		]);
		expect(top.map((t) => [t.name, t.cents, t.count])).toEqual([
			['Bol.com', 6000, 1],
			['Albert Heijn', 4500, 2]
		]);
		expect(top[0]!.share).toBeCloseTo(6000 / 10500);
	});

	it('een verdeling over twee categorieën is één transactie', () => {
		const [t] = topCounterparties([
			part({ id: 'x', date: '2026-10-01', cents: 1200, counterparty: 'Kruidvat' }),
			part({
				id: 'x',
				date: '2026-10-01',
				cents: 800,
				counterparty: 'Kruidvat',
				categoryId: 'drogist'
			})
		]);
		expect(t).toMatchObject({ name: 'Kruidvat', cents: 2000, count: 1, share: 1 });
	});

	it('hooguit zoveel als gevraagd, en zonder naam heet "Zonder naam"', () => {
		const parts = ['A', 'B', 'C'].map((c, i) =>
			part({ date: '2026-10-01', cents: 100 * (i + 1), counterparty: `Winkel ${c}` })
		);
		parts.push(part({ date: '2026-10-02', cents: 50, counterparty: '' }));
		expect(topCounterparties(parts, 2).map((t) => t.name)).toEqual(['Winkel C', 'Winkel B']);
		expect(topCounterparties(parts, 10).at(-1)?.name).toBe('Zonder naam');
		expect(topCounterparties([])).toEqual([]);
	});
});

describe('verwachting einde maand', () => {
	it('uitgegeven + vaste lasten die nog komen + gemiddeld per resterende dag', () => {
		// 31 oktober, vandaag de 21e: nog 10 dagen na vandaag
		expect(
			monthForecast({
				spentCents: 120000,
				plannedLeftCents: 4500,
				dailyCents: 1500,
				day: 21,
				daysInMonth: 31
			})
		).toEqual({
			spentCents: 120000,
			plannedLeftCents: 4500,
			variableLeftCents: 15000,
			daysLeft: 10,
			totalCents: 139500
		});
	});

	it('op de laatste dag is de verwachting wat er al uitgegeven en nog gepland is', () => {
		const f = monthForecast({
			spentCents: 90000,
			plannedLeftCents: 2000,
			dailyCents: 1500,
			day: 30,
			daysInMonth: 30
		});
		expect(f.daysLeft).toBe(0);
		expect(f.totalCents).toBe(92000);
	});

	it('nooit minder door een negatief gepland bedrag of gemiddelde', () => {
		const f = monthForecast({
			spentCents: 1000,
			plannedLeftCents: -300,
			dailyCents: -50,
			day: 1,
			daysInMonth: 28
		});
		expect(f.totalCents).toBe(1000);
	});

	it('gemiddelde per dag over de laatste drie volledige maanden met uitgaven', () => {
		const months = [
			{ month: '2026-06', spentCents: 99999, fixedCents: 0, variableCents: 99999 },
			{ month: '2026-07', spentCents: 93000, fixedCents: 0, variableCents: 31000 },
			{ month: '2026-08', spentCents: 0, fixedCents: 0, variableCents: 0 },
			{ month: '2026-09', spentCents: 90000, fixedCents: 60000, variableCents: 30000 }
		];
		// Augustus heeft geen uitgaven en telt niet mee; met juni erbij zijn het er drie
		expect(dailyVariable(months.slice(1), { variableCents: 0, day: 1 })).toBe(
			Math.floor((31000 + 30000) / (31 + 30))
		);
		expect(dailyVariable(months, { variableCents: 0, day: 1 })).toBe(
			Math.floor((99999 + 31000 + 30000) / (30 + 31 + 30))
		);
	});

	it('zonder historie: deze maand tot en met vandaag', () => {
		expect(dailyVariable([], { variableCents: 10000, day: 4 })).toBe(2500);
		expect(dailyVariable([], { variableCents: 10000, day: 0 })).toBe(0);
		expect(dailyVariable([], { variableCents: -500, day: 3 })).toBe(0);
	});

	it('een uitgesmeerde last telt met zijn reservering, niet met de afschrijving', () => {
		// Contributie €90 halfjaarlijks, uitgesmeerd: €15 opzij in deze maand (in spentCents).
		// De afschrijving komt volgende maand, dus er is deze maand niets meer gepland.
		const spread = monthForecast({
			spentCents: 1500,
			plannedLeftCents: 0,
			dailyCents: 0,
			day: 10,
			daysInMonth: 31
		});
		expect(spread.totalCents).toBe(1500);
	});
});

describe('lijn van uitgegeven per dag', () => {
	it('loopt op tot vandaag, met de reserveringen vanaf de eerste', () => {
		const parts = [
			part({ date: '2026-10-01', cents: 1000 }),
			part({ date: '2026-10-03', cents: 500 }),
			part({ date: '2026-10-03', cents: -200 }),
			part({ date: '2026-10-08', cents: 9999 }),
			part({ date: '2026-09-30', cents: 7777 })
		];
		expect(cumulativeByDay(parts, 1500, '2026-10', 4)).toEqual([2500, 2500, 2800, 2800]);
		expect(cumulativeByDay(parts, 0, '2026-10', 31)).toHaveLength(31);
	});

	it('inkomend geld zonder categorie, zoals salaris, telt niet', () => {
		const parts = [
			part({ date: '2026-10-01', cents: 1000, categoryId: null }),
			part({ date: '2026-10-02', cents: -250000, categoryId: null })
		];
		expect(cumulativeByDay(parts, 0, '2026-10', 2)).toEqual([1000, 1000]);
	});
});
