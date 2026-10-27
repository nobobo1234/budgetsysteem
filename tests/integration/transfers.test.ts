import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/lib/server/db/index.ts';
import { accounts, categories, transactions } from '../../src/lib/server/db/schema.ts';
import {
	listTransactions,
	spendingPerDay,
	summarizeTransactions,
	transferCounterpart,
	transferPairs
} from '../../src/lib/server/transactions.ts';
import { tempDatabase } from './helpers.ts';

let db: DB;
let cleanup: () => void;
let sns: string;
let rev: string;
let internal: string;
let groceries: string;

beforeEach(() => {
	({ db, cleanup } = tempDatabase());
	const account = (alias: string) =>
		db.select().from(accounts).where(eq(accounts.alias, alias)).get()!.id;
	const cat = (name: string) =>
		db.select().from(categories).where(eq(categories.name, name)).get()!.id;
	sns = account('sns');
	rev = account('rev');
	internal = cat('Interne overboeking');
	groceries = cat('Boodschappen');
});
afterEach(() => cleanup());

function addTx(
	accountId: string,
	date: string,
	amountCents: number,
	over: Partial<typeof transactions.$inferInsert> = {}
) {
	return db
		.insert(transactions)
		.values({ accountId, date, amountCents, source: 'import', ...over })
		.returning({ id: transactions.id })
		.get().id;
}

const intern = { categoryId: null, categorySource: 'intern' } as const;

describe('interne overboekingen als paar', () => {
	it('toont de afschrijving met de bijschrijving erbij, en het paar telt niet als uit of in', () => {
		const out = addTx(sns, '2026-10-03', -5000, intern);
		// Via de standaardregel voor Revolut: wel de categorie, niet herkend aan de IBAN
		const inc = addTx(rev, '2026-10-04', 5000, {
			categoryId: internal,
			categorySource: 'regel'
		});
		addTx(sns, '2026-10-04', -1250, { categoryId: groceries });

		const filter = { month: '2026-10' };
		const t = transferPairs(db, filter);
		expect(t.pairs.get(out)).toMatchObject({
			id: inc,
			date: '2026-10-04',
			from: 'SNS',
			to: 'Revolut'
		});
		const rows = listTransactions(db, { ...filter, excludeIds: t.hidden });
		expect(rows.map((r) => r.id).sort()).not.toContain(inc);
		expect(rows).toHaveLength(2);
		const summary = summarizeTransactions(db, { ...filter, excludeIds: t.paired });
		expect(summary.count + t.pairs.size).toBe(2);
		expect(summary.outCents).toBe(-1250);
		expect(summary.inCents).toBe(0);
	});

	it('vormt geen paar als het filter maar één kant vindt', () => {
		addTx(sns, '2026-10-03', -5000, intern);
		addTx(rev, '2026-10-03', 5000, intern);
		expect(transferPairs(db, { accountId: sns }).pairs.size).toBe(0);
		expect(transferPairs(db, { from: '2026-10-03', to: '2026-10-03' }).pairs.size).toBe(1);
	});

	it('koppelt geen gewone boekingen of verwachte posten', () => {
		addTx(sns, '2026-10-03', -5000, { categoryId: groceries });
		addTx(rev, '2026-10-03', 5000, { categoryId: groceries });
		addTx(sns, '2026-10-05', -2000, { ...intern, status: 'verwacht' });
		addTx(rev, '2026-10-05', 2000, intern);
		expect(transferPairs(db, {}).pairs.size).toBe(0);
	});

	it('de detailpagina vindt de andere kant, in beide richtingen', () => {
		const out = addTx(sns, '2026-10-03', -5000, intern);
		const inc = addTx(rev, '2026-10-03', 5000, intern);
		expect(transferCounterpart(db, out)).toMatchObject({ id: inc, from: 'SNS', to: 'Revolut' });
		expect(transferCounterpart(db, inc)).toMatchObject({ id: out, from: 'SNS', to: 'Revolut' });
		const other = addTx(sns, '2026-10-04', -1250, { categoryId: groceries });
		expect(transferCounterpart(db, other)).toBeNull();
	});

	it('opwaarderen via de regel telt niet als uitgave per dag', () => {
		addTx(sns, '2026-10-03', -5000, { categoryId: internal, categorySource: 'regel' });
		addTx(sns, '2026-10-03', -1250, { categoryId: groceries });
		expect(spendingPerDay(db, { month: '2026-10' })).toEqual([
			{ date: '2026-10-03', outCents: 1250 }
		]);
	});
});
