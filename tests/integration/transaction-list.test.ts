import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../../src/lib/dates.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import { accounts, transactions } from '../../src/lib/server/db/schema.ts';
import { listTransactions, listWholeDays } from '../../src/lib/server/transactions.ts';
import { load } from '../../src/routes/(app)/transacties/+page.server.ts';
import { tempDatabase } from './helpers.ts';

let db: DB;
let cleanup: () => void;
let sns: string;

beforeEach(() => {
	({ db, cleanup } = tempDatabase());
	sns = db.select().from(accounts).where(eq(accounts.alias, 'sns')).get()!.id;
});
afterEach(() => cleanup());

function addTx(date: string, over: Partial<typeof transactions.$inferInsert> = {}) {
	return db
		.insert(transactions)
		.values({ accountId: sns, date, amountCents: -100, source: 'import', ...over })
		.returning({ id: transactions.id })
		.get().id;
}

/** `perDay` rijen per dag, `days` dagen terug vanaf 1 oktober */
function seedDays(days: number, perDay = 1) {
	for (let d = 0; d < days; d++) for (let i = 0; i < perDay; i++) addTx(addDays('2026-10-01', -d));
}

describe('lijst in hele dagen', () => {
	it('geeft alles als het past, zonder meer', () => {
		seedDays(3);
		const { rows, hasMore } = listWholeDays(db, {}, 50);
		expect(rows).toHaveLength(3);
		expect(hasMore).toBe(false);
	});

	it('knipt op de grens als daar een nieuwe dag begint', () => {
		seedDays(10);
		const { rows, hasMore } = listWholeDays(db, {}, 5);
		expect(rows.map((r) => r.date)).toEqual([
			'2026-10-01',
			'2026-09-30',
			'2026-09-29',
			'2026-09-28',
			'2026-09-27'
		]);
		expect(hasMore).toBe(true);
	});

	it('vult een dag die over de grens loopt aan, en zegt of er daarvoor nog iets is', () => {
		seedDays(2, 3); // 1 okt en 30 sep, elk drie
		const whole = listWholeDays(db, {}, 4);
		expect(whole.rows).toHaveLength(6);
		expect(whole.rows.filter((r) => r.date === '2026-09-30')).toHaveLength(3);
		expect(whole.hasMore).toBe(false);

		addTx('2026-09-01');
		const more = listWholeDays(db, {}, 4);
		expect(more.rows).toHaveLength(6);
		expect(more.hasMore).toBe(true);
	});

	it('houdt zich aan het filter, ook bij het aanvullen', () => {
		seedDays(2, 3);
		addTx('2026-09-30', { counterparty: 'Albert Heijn' });
		const { rows } = listWholeDays(db, { q: 'albert' }, 1);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.counterparty).toBe('Albert Heijn');
	});

	it('legt rijen uit één import (zelfde datum en createdAt) vast, zodat stappen niets missen', () => {
		const createdAt = '2026-10-01T10:00:00.000Z';
		const ids = Array.from({ length: 30 }, () => addTx('2026-10-01', { createdAt }));
		const first = listTransactions(db, { limit: 10 }).map((r) => r.id);
		expect(listTransactions(db, { limit: 10 }).map((r) => r.id)).toEqual(first);
		const all = [0, 10, 20].flatMap((offset) =>
			listTransactions(db, { limit: 10, offset }).map((r) => r.id)
		);
		expect(new Set(all)).toEqual(new Set(ids));
	});
});

describe('transactielijst: aantal in de URL', () => {
	type Data = {
		list: { count: number; step: number; max: number; hasMore: boolean };
		transactions: unknown[];
	};
	const run = (search: string) =>
		load({ url: new URL(`http://localhost/transacties${search}`) } as never) as Data;

	it('begint met 50 en laadt per 50 bij', () => {
		seedDays(120);
		const first = run('');
		expect(first.list).toMatchObject({ count: 50, step: 50, max: 500, hasMore: true });
		expect(first.transactions).toHaveLength(50);
		const second = run('?aantal=100');
		expect(second.transactions).toHaveLength(100);
		expect(second.list.hasMore).toBe(true);
		const last = run('?aantal=150');
		expect(last.transactions).toHaveLength(120);
		expect(last.list.hasMore).toBe(false);
	});

	it('maakt van een vreemd aantal een stap tussen 50 en 500', () => {
		for (const [asked, count] of [
			['', 50],
			['abc', 50],
			['-20', 50],
			['0', 50],
			['75', 100],
			['500', 500],
			['501', 500],
			['9'.repeat(400), 500]
		] as const)
			expect(run(`?aantal=${asked}`).list.count, asked).toBe(count);
	});
});
