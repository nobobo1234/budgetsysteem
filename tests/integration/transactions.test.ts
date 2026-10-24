import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { monthOverview, setBudget, spendingByCategory } from '../../src/lib/server/budgets.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	accounts,
	auditLog,
	categories,
	owed,
	transactionSplits,
	transactions
} from '../../src/lib/server/db/schema.ts';
import {
	createTransaction,
	deleteTransaction,
	listTransactions,
	summarizeTransactions,
	transactionMonths,
	updateTransaction,
	ValidationError
} from '../../src/lib/server/transactions.ts';
import { newTransactionSchema } from '../../src/lib/server/validation.ts';
import { tempDatabase } from './helpers.ts';

let db: DB;
let cleanup: () => void;
let sns: string;
let cat: (name: string) => string;

beforeEach(() => {
	({ db, cleanup } = tempDatabase());
	sns = db.select().from(accounts).where(eq(accounts.alias, 'sns')).get()!.id;
	cat = (name) => db.select().from(categories).where(eq(categories.name, name)).get()!.id;
});
afterEach(() => cleanup());

const TODAY = '2026-10-23';

function input(over: Partial<Record<string, unknown>> = {}) {
	return newTransactionSchema.parse({
		id: crypto.randomUUID(),
		amountCents: -1250,
		date: '2026-10-20',
		counterparty: 'Albert Heijn',
		categoryId: cat('Boodschappen'),
		accountId: sns,
		...over
	});
}

describe('handmatige transacties', () => {
	it('is idempotent op het ID (offline opnieuw versturen)', () => {
		const tx = input();
		expect(createTransaction(db, tx, TODAY).created).toBe(true);
		expect(createTransaction(db, tx, TODAY).created).toBe(false);
		expect(db.select().from(transactions).all()).toHaveLength(1);
	});

	it('legt elke wijziging vast in het audit-log', () => {
		const tx = input();
		createTransaction(db, tx, TODAY);
		updateTransaction(db, tx.id, { note: 'test' }, TODAY);
		deleteTransaction(db, tx.id);
		const actions = db
			.select()
			.from(auditLog)
			.where(eq(auditLog.entityId, tx.id))
			.all()
			.map((a) => a.action);
		expect(actions).toEqual(['aangemaakt', 'gewijzigd', 'verwijderd']);
	});

	it('weigert een datum ver in de toekomst, een onbekende categorie en een onbekende rekening', () => {
		expect(() => createTransaction(db, input({ date: '2027-06-01' }), TODAY)).toThrow(
			ValidationError
		);
		expect(() => createTransaction(db, input({ categoryId: crypto.randomUUID() }), TODAY)).toThrow(
			/categorie/
		);
		expect(() => createTransaction(db, input({ accountId: crypto.randomUUID() }), TODAY)).toThrow(
			/rekening/
		);
	});

	it('een dollarpost zonder eurobedrag is te controleren', () => {
		const tx = input({ amountCents: 0, origAmountCents: -2000, origCurrency: 'USD' });
		createTransaction(db, tx, TODAY);
		expect(db.select().from(transactions).where(eq(transactions.id, tx.id)).get()?.status).toBe(
			'te_controleren'
		);
		updateTransaction(db, tx.id, { amountCents: -1850 }, TODAY);
		expect(db.select().from(transactions).where(eq(transactions.id, tx.id)).get()?.status).toBe(
			'bevestigd'
		);
	});

	it('voorschieten: alleen jouw deel telt, de rest staat open per persoon', () => {
		const tx = input({
			amountCents: -4500,
			categoryId: cat('Uit eten en bezorgen'),
			share: { people: 3, with: ['Sanne', 'Tom'] }
		});
		createTransaction(db, tx, TODAY);
		const splits = db
			.select()
			.from(transactionSplits)
			.where(eq(transactionSplits.transactionId, tx.id))
			.all();
		expect(splits.map((s) => s.amountCents).sort((a, b) => a - b)).toEqual([-3000, -1500]);
		expect(
			db
				.select()
				.from(owed)
				.all()
				.map((o) => [o.person, o.amountCents])
		).toEqual([
			['Sanne', 1500],
			['Tom', 1500]
		]);
		const spending = spendingByCategory(db, '2026-10');
		expect(spending.get(cat('Uit eten en bezorgen'))).toBe(1500);
	});

	it('verdeelt oneven bedragen exact', () => {
		const tx = input({ amountCents: -1000, share: { people: 3, with: ['A', 'B'] } });
		createTransaction(db, tx, TODAY);
		const total = db
			.select()
			.from(owed)
			.all()
			.reduce((s, o) => s + o.amountCents, 0);
		expect(total).toBe(667);
	});

	it('zoekt op tegenpartij, omschrijving en notitie, en escapet LIKE-tekens', () => {
		createTransaction(db, input({ counterparty: 'Albert Heijn' }), TODAY);
		createTransaction(db, input({ counterparty: '100% Sap', note: 'lekker' }), TODAY);
		expect(listTransactions(db, { q: 'albert' })).toHaveLength(1);
		expect(listTransactions(db, { q: '%' })).toHaveLength(1);
		expect(listTransactions(db, { q: 'lekker' })).toHaveLength(1);
		expect(listTransactions(db, { q: "'; DROP TABLE transactions; --" })).toHaveLength(0);
		expect(db.select().from(transactions).all()).toHaveLength(2);
	});

	it('vat het hele filter samen, los van de pagina, met in en uit apart', () => {
		createTransaction(db, input({ amountCents: -1250 }), TODAY);
		createTransaction(db, input({ amountCents: -750, categoryId: null }), TODAY);
		createTransaction(db, input({ amountCents: 5000, date: '2026-09-30' }), TODAY);
		expect(summarizeTransactions(db)).toEqual({ count: 3, inCents: 5000, outCents: -2000 });
		expect(summarizeTransactions(db, { month: '2026-10' })).toEqual({
			count: 2,
			inCents: 0,
			outCents: -2000
		});
		expect(summarizeTransactions(db, { categoryId: 'geen' }).count).toBe(1);
		expect(listTransactions(db, { limit: 1 })).toHaveLength(1);
		expect(summarizeTransactions(db, { q: 'bestaat niet' })).toEqual({
			count: 0,
			inCents: 0,
			outCents: 0
		});
	});

	it('geeft de maanden met transacties, de nieuwste eerst, zonder dubbele', () => {
		createTransaction(db, input({ date: '2026-09-02' }), TODAY);
		createTransaction(db, input({ date: '2026-10-20' }), TODAY);
		createTransaction(db, input({ date: '2026-10-01' }), TODAY);
		expect(transactionMonths(db)).toEqual(['2026-10', '2026-09']);
	});
});

describe('budget', () => {
	it('nog vrij: limieten min uitgaven, en zonder categorie telt mee', () => {
		setBudget(db, '2026-10', cat('Boodschappen'), 30000);
		setBudget(db, '2026-10', cat('Uit eten en bezorgen'), 10000);
		createTransaction(db, input({ amountCents: -12000 }), TODAY);
		createTransaction(db, input({ amountCents: -2000, categoryId: null }), TODAY);
		createTransaction(db, input({ amountCents: 300000, categoryId: cat('Inkomen') }), TODAY);
		const o = monthOverview(db, '2026-10', TODAY);
		expect(o.totalLimitCents).toBe(40000);
		expect(o.uncategorizedCents).toBe(2000);
		expect(o.freeCents).toBe(40000 - 12000 - 2000);
		const line = o.lines.find((l) => l.name === 'Boodschappen')!;
		expect(line.spentCents).toBe(12000);
		// 40% van de limiet op dag 23 van 31 (74%)
		expect(line.pace).toBe('rustig');
	});

	it('een terugbetaling in dezelfde categorie verlaagt de uitgaven', () => {
		createTransaction(db, input({ amountCents: -5000 }), TODAY);
		createTransaction(db, input({ amountCents: 1500 }), TODAY);
		expect(spendingByCategory(db, '2026-10').get(cat('Boodschappen'))).toBe(3500);
	});

	it('een nieuwe maand neemt de limieten van de vorige over', () => {
		setBudget(db, '2026-08', cat('Boodschappen'), 30000);
		const o = monthOverview(db, '2026-10', TODAY);
		expect(o.lines.find((l) => l.name === 'Boodschappen')?.limitCents).toBe(30000);
	});

	it('categorieën buiten budget tellen niet mee', () => {
		createTransaction(
			db,
			input({ amountCents: -50000, categoryId: cat('Sparen en beleggen') }),
			TODAY
		);
		const o = monthOverview(db, '2026-10', TODAY);
		expect(o.lines.some((l) => l.name === 'Sparen en beleggen')).toBe(false);
		expect(o.totalSpentCents).toBe(0);
	});
});
