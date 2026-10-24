import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	accounts,
	auditLog,
	categories,
	rules,
	transactionSplits,
	transactions
} from '../../src/lib/server/db/schema.ts';
import { importRecords } from '../../src/lib/server/import/importer.ts';
import type { ImportRecord } from '../../src/lib/server/import/types.ts';
import { updateTransaction } from '../../src/lib/server/transactions.ts';
import { actions } from '../../src/routes/(app)/regels/+page.server.ts';
import { ORIGIN, tempDatabase } from './helpers.ts';

let db: DB;
let cleanup: () => void;
beforeEach(() => ({ db, cleanup } = tempDatabase()));
afterEach(() => cleanup());

const MOLLIE = 'Woolsocks AG via Stichting Mollie Payments';

function record(over: Partial<ImportRecord> = {}): ImportRecord {
	return {
		accountIban: 'NL12SNSB0123456789',
		date: '2026-09-01',
		amountCents: 250,
		counterparty: MOLLIE,
		counterIban: 'NL20INGB0001234567',
		description: 'Cashback',
		bankReference: crypto.randomUUID(),
		...over
	};
}

function categoryId(name: string): string {
	return db.select().from(categories).where(eq(categories.name, name)).get()!.id;
}

function only() {
	return db.select().from(transactions).where(eq(transactions.counterparty, MOLLIE)).get()!;
}

async function addRule(pattern: string, category: string, priority = 100) {
	const body = new FormData();
	body.set('field', 'tegenpartij');
	body.set('pattern', pattern);
	body.set('categoryId', categoryId(category));
	body.set('priority', String(priority));
	const request = new Request(`${ORIGIN}/regels?/addRule`, { method: 'POST', body });
	return actions.addRule!({ request } as never);
}

async function deleteRule(pattern: string) {
	const rule = db.select().from(rules).where(eq(rules.pattern, pattern)).get()!;
	const body = new FormData();
	body.set('id', rule.id);
	const request = new Request(`${ORIGIN}/regels?/deleteRule`, { method: 'POST', body });
	return actions.deleteRule!({ request } as never);
}

describe('regels op bestaande transacties', () => {
	it('een import onthoudt welke regel de categorie gaf', async () => {
		await addRule('mollie', 'Overig');
		importRecords(db, [record()], 'camt053');
		const tx = only();
		expect(tx.categoryId).toBe(categoryId('Overig'));
		expect(tx.categorySource).toBe('regel');
		expect(tx.categoryRuleId).toBe(
			db.select().from(rules).where(eq(rules.pattern, 'mollie')).get()!.id
		);
	});

	it('een nieuwe regel overschrijft de categorie van een eerdere regel', async () => {
		await addRule('mollie', 'Overig');
		importRecords(db, [record()], 'camt053');
		expect(await addRule('woolsocks', 'Inkomen', 50)).toEqual({ applied: 1 });
		expect(only().categoryId).toBe(categoryId('Inkomen'));
	});

	it('een regel naar een andere categorie zetten werkt ook op de historie', async () => {
		await addRule('woolsocks', 'Overig');
		importRecords(db, [record()], 'camt053');
		expect(await addRule('woolsocks', 'Inkomen')).toEqual({ applied: 1 });
		expect(only().categoryId).toBe(categoryId('Inkomen'));
	});

	it('na het verwijderen van een regel geldt de volgende regel, of geen categorie', async () => {
		await addRule('mollie', 'Overig');
		await addRule('woolsocks', 'Inkomen', 50);
		importRecords(db, [record()], 'camt053');
		expect(only().categoryId).toBe(categoryId('Inkomen'));

		expect(await deleteRule('woolsocks')).toEqual({ ok: true, applied: 1 });
		expect(only().categoryId).toBe(categoryId('Overig'));

		expect(await deleteRule('mollie')).toEqual({ ok: true, applied: 1 });
		const tx = only();
		expect(tx.categoryId).toBeNull();
		expect(tx.categorySource).toBeNull();
		expect(tx.categoryRuleId).toBeNull();
	});

	it('een zelf gekozen categorie blijft staan', async () => {
		await addRule('woolsocks', 'Overig');
		importRecords(db, [record()], 'camt053');
		updateTransaction(db, only().id, { categoryId: categoryId('Cadeaus') });
		expect(only().categorySource).toBe('handmatig');

		expect(await addRule('woolsocks', 'Inkomen')).toEqual({ applied: 0 });
		expect(await deleteRule('woolsocks')).toEqual({ ok: true, applied: 0 });
		expect(only().categoryId).toBe(categoryId('Cadeaus'));
	});

	it('opslaan zonder de categorie te wijzigen maakt hem niet handmatig', async () => {
		await addRule('woolsocks', 'Overig');
		importRecords(db, [record()], 'camt053');
		updateTransaction(db, only().id, { categoryId: categoryId('Overig'), note: 'cashback' });
		expect(only().categorySource).toBe('regel');
	});

	it('geen categorie kiezen geeft de transactie terug aan de regels', async () => {
		importRecords(db, [record()], 'camt053');
		updateTransaction(db, only().id, { categoryId: categoryId('Cadeaus') });
		updateTransaction(db, only().id, { categoryId: null });
		expect(only().categorySource).toBeNull();
		await addRule('woolsocks', 'Inkomen');
		expect(only().categoryId).toBe(categoryId('Inkomen'));
	});

	it('een overboeking naar een eigen rekening blijft intern', async () => {
		db.update(accounts).set({ iban: 'NL20INGB0001234567' }).where(eq(accounts.alias, 'rev')).run();
		importRecords(db, [record()], 'camt053');
		expect(only().categorySource).toBe('intern');
		expect(await addRule('woolsocks', 'Inkomen')).toEqual({ applied: 0 });
		expect(only().categoryId).toBe(categoryId('Interne overboeking'));
	});

	it('een gedeelde uitgave met een verdeling blijft staan', async () => {
		importRecords(db, [record({ amountCents: -6000 })], 'camt053');
		db.insert(transactionSplits)
			.values({ transactionId: only().id, categoryId: null, amountCents: -6000 })
			.run();
		expect(await addRule('woolsocks', 'Overig')).toEqual({ applied: 0 });
		expect(only().categoryId).toBeNull();
	});

	it('opnieuw toepassen zet categorieën van oude regels terug', async () => {
		await addRule('woolsocks', 'Overig');
		importRecords(db, [record()], 'camt053');
		// Zoals na de migratie: een categorie van een regel die niet meer bestaat
		db.delete(rules).where(eq(rules.pattern, 'woolsocks')).run();
		expect(only().categoryId).toBe(categoryId('Overig'));

		expect(await actions.reapply!({} as never)).toEqual({ reapplied: true, applied: 1 });
		expect(only().categoryId).toBeNull();
		expect(await actions.reapply!({} as never)).toEqual({ reapplied: true, applied: 0 });
	});

	it('elke wijziging door een regel staat in het audit-log', async () => {
		importRecords(db, [record()], 'camt053');
		await addRule('woolsocks', 'Inkomen');
		const entry = db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.action, 'regel_toegepast'), eq(auditLog.entityId, only().id)))
			.get();
		expect(entry?.before).toEqual({ categoryId: null, categorySource: null, categoryRuleId: null });
		expect(entry?.after).toMatchObject({
			categoryId: categoryId('Inkomen'),
			categorySource: 'regel'
		});
	});
});

describe('migratie 0001: bron van bestaande categorieën', () => {
	function statements(file: string): string[] {
		return readFileSync(`drizzle/${file}`, 'utf8')
			.split('--> statement-breakpoint')
			.map((s) => s.trim())
			.filter(Boolean);
	}

	it('handmatig volgens het audit-log, eigen overboekingen intern, de rest van de import via een regel', () => {
		const sqlite = new Database(':memory:');
		for (const s of statements('0000_init.sql')) sqlite.exec(s);
		sqlite.exec(`
			INSERT INTO categories (id, name, "group") VALUES
				('c-int', 'Interne overboeking', 'Overig'), ('c-a', 'A', 'Overig'), ('c-b', 'B', 'Overig');
			INSERT INTO accounts (id, name, kind, alias, iban) VALUES
				('a-sns', 'SNS', 'sns', 'sns', 'NL12SNSB0123456789'),
				('a-rev', 'Revolut', 'revolut', 'rev', 'NL46SNSB9876543210');
			INSERT INTO transactions (id, amount_cents, date, account_id, source, category_id, counter_iban) VALUES
				('t-regel', -100, '2026-09-01', 'a-sns', 'import', 'c-a', NULL),
				('t-zelf', -100, '2026-09-01', 'a-sns', 'import', 'c-b', NULL),
				('t-intern', -100, '2026-09-01', 'a-sns', 'import', 'c-int', 'NL46SNSB9876543210'),
				('t-leeg', -100, '2026-09-01', 'a-sns', 'import', NULL, NULL),
				('t-snel', -100, '2026-09-01', 'a-sns', 'handmatig', 'c-a', NULL);
			INSERT INTO audit_log (id, kind, action, entity, entity_id, before, after) VALUES
				('l1', 'wijziging', 'gewijzigd', 'transactions', 't-zelf',
					'{"categoryId":"c-a"}', '{"categoryId":"c-b"}'),
				('l2', 'wijziging', 'gewijzigd', 'transactions', 't-regel',
					'{"categoryId":"c-a","note":""}', '{"categoryId":"c-a","note":"x"}');
		`);
		for (const s of statements('0001_regelbron.sql')) sqlite.exec(s);

		const source = Object.fromEntries(
			sqlite
				.prepare('SELECT id, category_source AS s FROM transactions')
				.all()
				.map((r) => [(r as { id: string }).id, (r as { s: string | null }).s])
		);
		expect(source).toEqual({
			't-regel': 'regel',
			't-zelf': 'handmatig',
			't-intern': 'intern',
			't-leeg': null,
			't-snel': 'handmatig'
		});
		sqlite.close();
	});
});
