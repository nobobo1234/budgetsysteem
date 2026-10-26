import { describe, expect, it } from 'vitest';
import {
	bucketOf,
	coverage,
	coveragePercent,
	distribute,
	groceryMonth,
	topLines,
	type GroceryLine,
	type GroceryPurchase
} from './groceries.ts';
import type { ProductGroup } from './productGroups.ts';

// Spec: Boodschappen per productgroep. Verzonnen regels; geen echte bonnen.

let n = 0;
function line(
	cents: number,
	group: ProductGroup | null,
	kind: GroceryLine['kind'] = 'artikel',
	extra: Partial<GroceryLine> = {}
): GroceryLine {
	n++;
	return {
		id: `l${n}`,
		receiptId: 'r1',
		description: `Regel ${n}`,
		kind,
		cents,
		group: kind === 'artikel' ? group : null,
		date: '2026-10-12',
		counterparty: 'Supermarkt Voorbeeld',
		...extra
	};
}

function purchase(month: string, spentCents: number, lines: GroceryLine[] = []): GroceryPurchase {
	n++;
	return { id: `t${n}`, month, spentCents, lines };
}

describe('verdeling over productgroepen', () => {
	it('telt artikelen per groep en kortingen en bonus samen als één regel', () => {
		const d = distribute([
			line(249, 'brood_ontbijt'),
			line(119, 'zuivel_eieren'),
			line(429, 'zuivel_eieren'),
			line(-75, null, 'bonus'),
			line(-50, null, 'korting'),
			line(15, null, 'statiegeld')
		]);
		expect(Object.fromEntries(d.buckets)).toEqual({
			brood_ontbijt: 249,
			zuivel_eieren: 548,
			overige_regels: 15
		});
		expect(d.discountCents).toBe(-125);
		// Het totaal is wat er op de bon betaald is, met de korting eraf
		expect(d.totalCents).toBe(249 + 548 + 15 - 125);
	});

	it('kortingen, bonus en statiegeld krijgen geen groep, ook als er een meekomt', () => {
		expect(bucketOf({ kind: 'korting', group: 'zuivel_eieren' })).toBe('korting');
		expect(bucketOf({ kind: 'bonus', group: null })).toBe('korting');
		expect(bucketOf({ kind: 'statiegeld', group: 'frisdrank_sap' })).toBe('overige_regels');
		expect(bucketOf({ kind: 'statiegeld_retour', group: null })).toBe('overige_regels');
		expect(bucketOf({ kind: 'fooi', group: null })).toBe('overige_regels');
	});

	it('een artikel van voor de productgroepen staat bij "nog geen groep"', () => {
		const d = distribute([line(300, null), line(200, 'alcohol')]);
		expect(d.buckets.get('zonder_groep')).toBe(300);
		expect(d.buckets.get('alcohol')).toBe(200);
	});

	it('zonder regels is alles nul', () => {
		expect(distribute([])).toEqual({ buckets: new Map(), discountCents: 0, totalCents: 0 });
	});
});

describe('dekking', () => {
	it('is het deel van het boodschappengeld met een bon met regels, naar bedrag', () => {
		const c = coverage([
			purchase('2026-10', 6800, [line(6800, 'voorraad')]),
			purchase('2026-10', 3200)
		]);
		expect(c).toEqual({ coveredCents: 6800, totalCents: 10000, share: 0.68 });
		expect(coveragePercent(c.share!)).toBe(68);
	});

	it('rondt naar beneden af, zodat bijna alles niet als alles leest', () => {
		expect(coveragePercent(0.996)).toBe(99);
		expect(coveragePercent(1)).toBe(100);
		expect(coveragePercent(0.29)).toBe(29);
	});

	it('zonder boodschappen is er geen dekking, en een terugbetaling telt niet negatief', () => {
		expect(coverage([]).share).toBeNull();
		const c = coverage([
			purchase('2026-10', 2000, [line(2000, 'overig')]),
			purchase('2026-10', -500)
		]);
		expect(c).toEqual({ coveredCents: 2000, totalCents: 2000, share: 1 });
	});
});

describe('maandoverzicht', () => {
	it('vergelijkt met het gemiddelde van de vorige drie maanden met regels', () => {
		const purchases = [
			purchase('2026-10', 5000, [line(3000, 'groente_fruit'), line(2000, 'alcohol')]),
			purchase('2026-09', 4000, [line(2000, 'groente_fruit'), line(-100, null, 'bonus')]),
			// Augustus had boodschappen maar geen bon met regels: telt niet mee in het gemiddelde
			purchase('2026-08', 9000),
			purchase('2026-07', 3000, [line(1000, 'groente_fruit'), line(1000, 'snacks_snoep')]),
			// Juni is meer dan drie maanden terug
			purchase('2026-06', 9900, [line(9900, 'groente_fruit')])
		];
		const m = groceryMonth(purchases, '2026-10');
		expect(m.comparedMonths).toBe(2);
		expect(m.rows).toEqual([
			{ bucket: 'groente_fruit', cents: 3000, averageCents: 1500, diffCents: 1500 },
			{ bucket: 'alcohol', cents: 2000, averageCents: 0, diffCents: 2000 },
			// Geen snacks deze maand, wel gemiddeld: dan staat de groep er met nul
			{ bucket: 'snacks_snoep', cents: 0, averageCents: 500, diffCents: -500 }
		]);
		expect(m.discount).toEqual({ cents: 0, averageCents: -50, diffCents: 50 });
		expect(m.total).toEqual({ cents: 5000, averageCents: 1950, diffCents: 3050 });
		expect(m.coverage.share).toBe(1);
	});

	it('zonder eerdere maanden met regels is er geen gemiddelde', () => {
		const m = groceryMonth([purchase('2026-10', 1000, [line(1000, 'voorraad')])], '2026-10');
		expect(m.comparedMonths).toBe(0);
		expect(m.rows).toEqual([
			{ bucket: 'voorraad', cents: 1000, averageCents: null, diffCents: null }
		]);
		expect(m.total.averageCents).toBeNull();
	});

	it('zet groepen van groot naar klein, met overig, nog geen groep en overige regels achteraan', () => {
		const m = groceryMonth(
			[
				purchase('2026-10', 9999, [
					line(100, 'overig'),
					line(50, null),
					line(15, null, 'statiegeld'),
					line(200, 'huishouden'),
					line(900, 'vlees_vis')
				])
			],
			'2026-10'
		);
		expect(m.rows.map((r) => r.bucket)).toEqual([
			'vlees_vis',
			'huishouden',
			'overig',
			'zonder_groep',
			'overige_regels'
		]);
	});

	it('ziet alleen de maand zelf; een aankoop zonder bon telt alleen in de dekking', () => {
		const m = groceryMonth(
			[purchase('2026-10', 1000, [line(1000, 'voorraad')]), purchase('2026-10', 3000)],
			'2026-10'
		);
		expect(m.total.cents).toBe(1000);
		expect(m.coverage).toEqual({ coveredCents: 1000, totalCents: 4000, share: 0.25 });
	});
});

describe('duurste regels', () => {
	it('geeft de tien duurste artikelen, zonder korting en statiegeld', () => {
		const lines = [
			...Array.from({ length: 12 }, (_, i) => line(100 * (i + 1), 'voorraad')),
			line(5000, null, 'statiegeld'),
			line(-9000, null, 'korting')
		];
		const top = topLines(lines);
		expect(top).toHaveLength(10);
		expect(top.map((l) => l.cents)).toEqual([1200, 1100, 1000, 900, 800, 700, 600, 500, 400, 300]);
	});

	it('bij een gelijk bedrag de nieuwste eerst', () => {
		const old = line(500, 'alcohol', 'artikel', { date: '2026-10-01' });
		const recent = line(500, 'alcohol', 'artikel', { date: '2026-10-20' });
		expect(topLines([old, recent]).map((l) => l.id)).toEqual([recent.id, old.id]);
	});
});
