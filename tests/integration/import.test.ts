import { readFileSync } from 'node:fs';
import { eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	accounts,
	categories,
	importBatches,
	rules,
	transactions
} from '../../src/lib/server/db/schema.ts';
import { parseBankFile } from '../../src/lib/server/import/index.ts';
import { applyRulesToUncategorized, importRecords } from '../../src/lib/server/import/importer.ts';
import type { ImportRecord } from '../../src/lib/server/import/types.ts';
import { tempDatabase } from './helpers.ts';

const file = (name: string) => readFileSync(`tests/fixtures/${name}`);

let db: DB;
let cleanup: () => void;
beforeEach(() => ({ db, cleanup } = tempDatabase()));
afterEach(() => cleanup());

function importFixture(name: string) {
	const { format, records } = parseBankFile(file(name));
	return importRecords(db, records, format);
}

describe('import met ontdubbelen', () => {
	it('importeert en geeft een overzicht', () => {
		const summary = importFixture('camt053-v02.xml');
		expect(summary.newCount).toBe(5);
		expect(summary.duplicateCount).toBe(0);
		expect(summary.periodStart).toBe('2026-09-02');
		expect(summary.periodEnd).toBe('2026-09-28');
		expect(summary.uncategorized.map((g) => g.pattern)).toContain('albert heijn utrecht');
	});

	it('dezelfde export twee keer levert niets dubbel op', () => {
		importFixture('camt053-v02.xml');
		const again = importFixture('camt053-v02.xml');
		expect(again.newCount).toBe(0);
		expect(again.duplicateCount).toBe(5);
		expect(db.select().from(transactions).all()).toHaveLength(5);
	});

	it('twee identieke boekingen zonder referentie blijven er twee', () => {
		importFixture('camt053-v02.xml');
		const spotify = db
			.select()
			.from(transactions)
			.where(eq(transactions.counterparty, 'Spotify AB'))
			.all();
		expect(spotify).toHaveLength(2);
		expect(new Set(spotify.map((t) => t.dedupeHash)).size).toBe(2);
	});

	it('koppelt de rekening aan het IBAN uit het bestand', () => {
		importFixture('camt053-v02.xml');
		const sns = db.select().from(accounts).where(eq(accounts.alias, 'sns')).get();
		expect(sns?.iban).toBe('NL12SNSB0123456789');
	});

	it('herkent Revolut-opwaarderingen als interne overboeking', () => {
		importFixture('camt053-v02.xml');
		const topup = db
			.select({ category: categories.name })
			.from(transactions)
			.innerJoin(categories, eq(categories.id, transactions.categoryId))
			.where(eq(transactions.counterparty, 'Revolut Ltd'))
			.get();
		expect(topup?.category).toBe('Interne overboeking');
	});

	it('een overboeking naar een eigen IBAN is intern', () => {
		db.update(accounts).set({ iban: 'NL91ABNA0417164300' }).where(eq(accounts.alias, 'rev')).run();
		importFixture('camt053-v02.xml');
		const salary = db
			.select()
			.from(transactions)
			.where(eq(transactions.counterparty, 'Werkgever B.V.'))
			.get();
		const internal = db
			.select()
			.from(categories)
			.where(eq(categories.name, 'Interne overboeking'))
			.get();
		expect(salary?.categoryId).toBe(internal?.id);
	});

	it('wantrouwt een referentie die in één bestand bij verschillende boekingen hoort', () => {
		const base: ImportRecord = {
			accountIban: 'NL12SNSB0123456789',
			date: '2026-09-01',
			amountCents: -100,
			counterparty: 'A',
			counterIban: null,
			description: '',
			bankReference: 'SAME'
		};
		const summary = importRecords(
			db,
			[base, { ...base, amountCents: -200, counterparty: 'B' }],
			'camt053'
		);
		expect(summary.newCount).toBe(2);
	});

	it('een import is één transactie: bij een fout rolt alles terug', () => {
		const good: ImportRecord = {
			accountIban: 'NL12SNSB0123456789',
			date: '2026-09-01',
			amountCents: -100,
			counterparty: 'Goed',
			counterIban: null,
			description: '',
			bankReference: 'R1'
		};
		// Een datum die de CHECK-constraint schendt
		const bad = { ...good, date: '01-09-2026', bankReference: 'R2' };
		expect(() => importRecords(db, [good, bad], 'camt053')).toThrow();
		expect(db.select().from(transactions).all()).toHaveLength(0);
		expect(db.select().from(importBatches).all()).toHaveLength(0);
	});

	it('een regel uit het overzicht werkt ook voor de bestaande transacties', () => {
		importFixture('camt053-v02.xml');
		const boodschappen = db
			.select()
			.from(categories)
			.where(eq(categories.name, 'Boodschappen'))
			.get()!;
		db.insert(rules)
			.values({ field: 'tegenpartij', pattern: 'albert heijn', categoryId: boodschappen.id })
			.run();
		expect(applyRulesToUncategorized(db)).toBe(1);
		const ah = db
			.select()
			.from(transactions)
			.where(eq(transactions.counterparty, 'ALBERT HEIJN 1403 UTRECHT'))
			.get();
		expect(ah?.categoryId).toBe(boodschappen.id);
		// Bij een volgende import meteen goed
		db.delete(transactions).run();
		importFixture('camt053-v02.xml');
		expect(
			db
				.select()
				.from(transactions)
				.where(isNull(transactions.categoryId))
				.all()
				.map((t) => t.counterparty)
		).not.toContain('ALBERT HEIJN 1403 UTRECHT');
	});

	it('CSV en CAMT van dezelfde rekening landen op dezelfde rekening', () => {
		importFixture('camt053-v02.xml');
		importFixture('sns.csv');
		const ids = new Set(
			db
				.select({ a: transactions.accountId })
				.from(transactions)
				.all()
				.map((r) => r.a)
		);
		expect(ids.size).toBe(1);
	});
});
