// Startlimieten uit historie: historie, voorstellen, inkomen en overnemen (spec: Analyses →
// Startlimieten uit historie).
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setBudget } from '../../src/lib/server/budgets.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	accounts,
	auditLog,
	budgets,
	categories,
	importBatches,
	owedPayments,
	people,
	recurring,
	transactionSplits,
	transactions
} from '../../src/lib/server/db/schema.ts';
import { ValidationError } from '../../src/lib/server/errors.ts';
import {
	applyStartLimits,
	hasEnoughHistory,
	historyStart,
	monthlyIncome,
	startLimitsPage
} from '../../src/lib/server/startLimits.ts';
import { actions } from '../../src/routes/(app)/budget/startlimieten/+page.server.ts';
import { fakeEvent, ORIGIN, tempDatabase } from './helpers.ts';

let db: DB;
let cleanup: () => void;
beforeEach(() => ({ db, cleanup } = tempDatabase()));
afterEach(() => cleanup());

const TODAY = '2026-10-27';
const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];

const category = (name: string) =>
	db.select().from(categories).where(eq(categories.name, name)).get()!.id;
const account = (alias: string) =>
	db.select().from(accounts).where(eq(accounts.alias, alias)).get()!.id;

function book(
	date: string,
	cents: number,
	categoryName: string | null,
	extra: Partial<typeof transactions.$inferInsert> = {}
) {
	return db
		.insert(transactions)
		.values({
			amountCents: cents,
			date,
			counterparty: 'Tegenpartij',
			categoryId: categoryName ? category(categoryName) : null,
			accountId: account('sns'),
			source: 'handmatig',
			...extra
		})
		.returning()
		.get().id;
}
const spend = (date: string, cents: number, categoryName: string) =>
	book(date, -cents, categoryName);

/** Historie vanaf 1 maart: een import over die periode. */
function importedFrom(start: string) {
	db.insert(importBatches)
		.values({ format: 'camt053', newCount: 0, duplicateCount: 0, periodStart: start })
		.run();
}

const line = (name: string) => startLimitsPage(db, TODAY).lines.find((l) => l.name === name)!;
const limit = (month: string, name: string) =>
	db
		.select()
		.from(budgets)
		.where(and(eq(budgets.month, month), eq(budgets.categoryId, category(name))))
		.get()?.limitCents;

describe('historie', () => {
	it('begint bij de vroegste import of transactie', () => {
		expect(historyStart(db)).toBeNull();
		spend('2026-05-14', 1000, 'Boodschappen');
		expect(historyStart(db)).toBe('2026-05-14');
		importedFrom('2026-03-01');
		expect(historyStart(db)).toBe('2026-03-01');
	});

	it('verwachte posten tellen niet als historie', () => {
		book('2025-01-01', -5000, 'Wonen', { status: 'verwacht', source: 'verwacht' });
		expect(historyStart(db)).toBeNull();
	});

	it('minder dan drie volle maanden: nog te weinig historie', () => {
		// Begint halverwege juli: alleen augustus en september zijn vol
		spend('2026-07-12', 4000, 'Boodschappen');
		expect(hasEnoughHistory(db, TODAY)).toBe(false);
		const page = startLimitsPage(db, TODAY);
		expect(page.enoughHistory).toBe(false);
		expect(page.lines).toEqual([]);
	});

	it('vanaf drie volle maanden een voorstel', () => {
		spend('2026-07-01', 4000, 'Boodschappen');
		expect(hasEnoughHistory(db, TODAY)).toBe(true);
		expect(startLimitsPage(db, TODAY).months).toEqual(['2026-07', '2026-08', '2026-09']);
	});
});

describe('voorstellen', () => {
	beforeEach(() => importedFrom('2026-01-01'));

	it('is de mediaan van de laatste zes volle maanden, zonder de lopende maand', () => {
		const amounts = [30000, 32000, 28000, 31000, 90000, 29000];
		MONTHS.forEach((m, i) => spend(`${m}-10`, amounts[i]!, 'Boodschappen'));
		// Oudere maand en de lopende maand tellen niet
		spend('2026-03-10', 200000, 'Boodschappen');
		spend('2026-10-05', 200000, 'Boodschappen');
		expect(line('Boodschappen').proposal).toEqual({
			kind: 'voorstel',
			proposalCents: 30500,
			plannedCents: 0,
			medianCents: 30500,
			lowestCents: 28000,
			highestCents: 90000
		});
		expect(startLimitsPage(db, TODAY).months).toEqual(MONTHS);
	});

	it('een maand zonder uitgaven telt als € 0', () => {
		spend('2026-08-03', 12000, 'Kleding');
		spend('2026-09-03', 8000, 'Kleding');
		spend('2026-07-03', 4000, 'Kleding');
		// 0, 0, 0, 4000, 12000, 8000 → (0 + 4000) / 2
		expect(line('Kleding').proposal).toMatchObject({ proposalCents: 2000, lowestCents: 0 });
	});

	it('zonder uitgaven en zonder iets gepland: geen voorstel', () => {
		spend('2026-09-03', 50000, 'Elektronica');
		expect(line('Elektronica').proposal).toEqual({ kind: 'geen_uitgaven' });
	});

	it('laat vaste lasten weg en telt op wat er deze maand gepland is', () => {
		const r = db
			.insert(recurring)
			.values({
				matchKey: 'sportschool|',
				counterparty: 'Sportschool',
				interval: 'maand',
				expectedDay: 20,
				medianCents: 3000,
				minCents: 3000,
				maxCents: 3000,
				kind: 'vast',
				categoryId: category('Sport'),
				accountId: account('sns'),
				status: 'actief'
			})
			.returning()
			.get();
		for (const m of MONTHS) {
			book(`${m}-20`, -3000, 'Sport', { recurringId: r.id });
			spend(`${m}-12`, 1500, 'Sport');
		}
		book('2026-10-20', -3000, 'Sport', {
			recurringId: r.id,
			status: 'verwacht',
			source: 'verwacht'
		});
		expect(line('Sport').proposal).toMatchObject({
			proposalCents: 4500,
			plannedCents: 3000,
			medianCents: 1500,
			lowestCents: 4500,
			highestCents: 4500
		});
	});

	it('telt van een verdeelde uitgave alleen het eigen deel', () => {
		for (const m of MONTHS) {
			const id = spend(`${m}-08`, 6000, 'Uit eten en bezorgen');
			db.insert(transactionSplits)
				.values([
					{ transactionId: id, categoryId: category('Uit eten en bezorgen'), amountCents: -2000 },
					{ transactionId: id, categoryId: category('Terugbetaling'), amountCents: -4000 }
				])
				.run();
		}
		expect(line('Uit eten en bezorgen').proposal).toMatchObject({ proposalCents: 2000 });
	});

	it('verrekent een terugboeking in de maand van de uitgave', () => {
		for (const m of MONTHS) spend(`${m}-15`, 10000, 'Kleding');
		// Retour van de septemberaankoop, binnen in oktober: september telt als € 0
		const original = db
			.select()
			.from(transactions)
			.where(eq(transactions.date, '2026-09-15'))
			.get()!.id;
		book('2026-10-02', 10000, 'Kleding', { correctionOf: original });
		expect(line('Kleding').proposal).toMatchObject({ proposalCents: 10000, lowestCents: 0 });
	});

	it('categorieën met een limiet doen niet mee, en tellen in de bestaande limieten', () => {
		for (const m of MONTHS) spend(`${m}-10`, 30000, 'Boodschappen');
		setBudget(db, '2026-09', category('Boodschappen'), 35000);
		const page = startLimitsPage(db, TODAY);
		// Oktober nam de limiet van september over
		expect(page.lines.some((l) => l.name === 'Boodschappen')).toBe(false);
		expect(page.existingLimitsCents).toBe(35000);
		expect(page.withLimitCount).toBe(1);
	});

	it('categorieën buiten budget of gearchiveerd doen niet mee', () => {
		db.update(categories).set({ archived: true }).where(eq(categories.name, 'Cadeaus')).run();
		const names = startLimitsPage(db, TODAY).lines.map((l) => l.name);
		expect(names).not.toContain('Cadeaus');
		expect(names).not.toContain('Inkomen');
		expect(names).toContain('Boodschappen');
	});
});

describe('inkomen', () => {
	beforeEach(() => importedFrom('2026-01-01'));

	it('is de mediaan van de inkomsten zonder interne overboekingen en terugboekingen', () => {
		for (const m of MONTHS) book(`${m}-24`, 250000, 'Inkomen');
		book('2026-06-24', 50000, 'Inkomen'); // vakantiegeld
		// Telt niet: eigen overboeking, retour, en een Tikkie in een budgetcategorie
		book('2026-07-02', 100000, 'Interne overboeking', { categorySource: 'intern' });
		book('2026-07-03', 80000, null, { categorySource: 'intern' });
		const original = spend('2026-08-01', 4000, 'Kleding');
		book('2026-08-09', 4000, null, { correctionOf: original });
		book('2026-08-12', 2500, 'Uit eten en bezorgen');
		expect(monthlyIncome(db, MONTHS)).toEqual([250000, 250000, 300000, 250000, 250000, 250000]);
		expect(startLimitsPage(db, TODAY).incomeCents).toBe(250000);
	});

	it('telt wat anderen terugbetaalden niet mee', () => {
		const person = db.insert(people).values({ name: 'Sam' }).returning().get().id;
		const repaid = book('2026-05-03', 2000, null);
		db.insert(owedPayments)
			.values({ transactionId: repaid, personId: person, amountCents: 2000 })
			.run();
		// Deels terugbetaling: alleen de rest is inkomen
		const mixed = book('2026-06-03', 5000, null);
		db.insert(owedPayments)
			.values({ transactionId: mixed, personId: person, amountCents: 1500 })
			.run();
		book('2026-07-03', 2000, 'Terugbetaling');
		expect(monthlyIncome(db, MONTHS)).toEqual([0, 0, 3500, 0, 0, 0]);
	});
});

describe('overnemen', () => {
	beforeEach(() => importedFrom('2026-01-01'));

	it('zet limieten voor de lopende maand, alleen voor categorieën zonder limiet', () => {
		setBudget(db, '2026-10', category('Boodschappen'), 35000);
		setBudget(db, '2026-10', category('Kleding'), 0); // leeg is geen limiet
		const result = applyStartLimits(db, TODAY, [
			{ categoryId: category('Boodschappen'), limitCents: 99900 },
			{ categoryId: category('Kleding'), limitCents: 6000 },
			{ categoryId: category('Vervoer'), limitCents: 4000 }
		]);
		expect(result).toEqual({ set: 2, skipped: 1 });
		expect(limit('2026-10', 'Boodschappen')).toBe(35000);
		expect(limit('2026-10', 'Kleding')).toBe(6000);
		expect(limit('2026-10', 'Vervoer')).toBe(4000);
		expect(limit('2026-09', 'Vervoer')).toBeUndefined();
	});

	it('legt elke limiet vast in het audit-log, met de oude waarde', () => {
		setBudget(db, '2026-10', category('Kleding'), 0);
		applyStartLimits(db, TODAY, [{ categoryId: category('Kleding'), limitCents: 6000 }]);
		const entry = db.select().from(auditLog).where(eq(auditLog.action, 'startlimiet')).get()!;
		expect(entry.entityId).toBe(`2026-10:${category('Kleding')}`);
		expect(entry.before).toMatchObject({ limitCents: 0 });
		expect(entry.after).toEqual({ limitCents: 6000 });
	});

	it('neemt de limieten van de vorige maand eerst over, zodat die niet overschreven worden', () => {
		setBudget(db, '2026-09', category('Boodschappen'), 35000);
		expect(
			applyStartLimits(db, TODAY, [{ categoryId: category('Boodschappen'), limitCents: 1000 }])
		).toEqual({ set: 0, skipped: 1 });
		expect(limit('2026-10', 'Boodschappen')).toBe(35000);
	});

	it('alles of niets: een categorie buiten budget zet geen enkele limiet', () => {
		expect(() =>
			applyStartLimits(db, TODAY, [
				{ categoryId: category('Vervoer'), limitCents: 4000 },
				{ categoryId: category('Inkomen'), limitCents: 4000 }
			])
		).toThrow(ValidationError);
		expect(limit('2026-10', 'Vervoer')).toBeUndefined();
	});

	it('weigert een limiet van € 0 en een categorie die er twee keer in staat', () => {
		const id = category('Vervoer');
		expect(() => applyStartLimits(db, TODAY, [{ categoryId: id, limitCents: 0 }])).toThrow(
			ValidationError
		);
		expect(() =>
			applyStartLimits(db, TODAY, [
				{ categoryId: id, limitCents: 100 },
				{ categoryId: id, limitCents: 200 }
			])
		).toThrow(ValidationError);
	});
});

describe('formulier', () => {
	async function post(fields: [string, string][]) {
		const form = new FormData();
		for (const [k, v] of fields) form.append(k, v);
		const event = fakeEvent({
			path: '/budget/startlimieten',
			routeId: '/(app)/budget/startlimieten',
			method: 'POST'
		});
		const request = new Request(`${ORIGIN}/budget/startlimieten?/apply`, {
			method: 'POST',
			body: form,
			headers: { origin: ORIGIN }
		});
		return actions.apply!({ ...event, request } as never);
	}

	it('zet alleen de aangevinkte categorieën', async () => {
		const vervoer = category('Vervoer');
		const kleding = category('Kleding');
		const month = new Date().toISOString().slice(0, 7);
		const result = await post([
			['kies', vervoer],
			[`limiet-${vervoer}`, '45,50'],
			[`limiet-${kleding}`, '60']
		]);
		expect(result).toEqual({ set: 1, skipped: 0 });
		expect(limit(month, 'Vervoer')).toBe(4550);
		expect(limit(month, 'Kleding')).toBeUndefined();
	});

	it('een onleesbaar bedrag zet niets en noemt de categorie', async () => {
		const vervoer = category('Vervoer');
		const result = await post([
			['kies', vervoer],
			[`limiet-${vervoer}`, '12,345']
		]);
		expect(result).toMatchObject({
			status: 400,
			data: { message: 'Dat bedrag kan ik niet lezen.', categoryId: vervoer }
		});
		expect(db.select().from(budgets).all()).toEqual([]);
	});

	it('weigert een id die geen uuid is', async () => {
		const result = await post([['kies', '1 OR 1=1']]);
		expect(result).toMatchObject({ status: 400 });
	});
});
