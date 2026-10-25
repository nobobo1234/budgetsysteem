import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	accounts,
	auditLog,
	categories,
	importBatches,
	owed,
	receipts,
	transactionSplits,
	transactions
} from '../../src/lib/server/db/schema.ts';
import { ValidationError } from '../../src/lib/server/errors.ts';
import { importRecords } from '../../src/lib/server/import/importer.ts';
import { mergeImported, mergeInfo } from '../../src/lib/server/import/koppellijst.ts';
import type { ImportRecord } from '../../src/lib/server/import/types.ts';
import { ADVANCED, MY_SHARE } from '../../src/lib/server/owed.ts';
import { reviewInbox } from '../../src/lib/server/review.ts';
import { createTransaction } from '../../src/lib/server/transactions.ts';
import { actions } from '../../src/routes/(app)/te-controleren/+page.server.ts';
import { fakeEvent, ORIGIN, tempDatabase } from './helpers.ts';

// Koppellijst bij een bankimport (spec: Import, Bonnetjes en koppelen → Koppellijst): een latere
// import wordt tegen je eigen invoer gehouden, zodat niets dubbel telt. Geanonimiseerde boekingen;
// alleen test-IBANs (scripts/test-ibans.txt).
const IBAN_OWN = 'NL12SNSB0123456789';
const IBAN_SHOP = 'NL20INGB0001234567';
const TODAY = '2026-10-25';

let db: DB;
let cleanup: () => void;
let sns: string;
beforeEach(() => {
	({ db, cleanup } = tempDatabase());
	sns = db.select().from(accounts).where(eq(accounts.alias, 'sns')).get()!.id;
});
afterEach(() => cleanup());

const cat = (name: string) =>
	db.select().from(categories).where(eq(categories.name, name)).get()!.id;

function manual(over: Partial<Parameters<typeof createTransaction>[1]> = {}): string {
	return createTransaction(
		db,
		{
			id: randomUUID(),
			amountCents: -2000,
			date: '2026-10-12',
			counterparty: 'Albert Heijn',
			description: '',
			categoryId: cat('Boodschappen'),
			accountId: sns,
			origAmountCents: null,
			origCurrency: null,
			note: 'weekboodschappen',
			share: null,
			settle: null,
			correct: null,
			...over
		},
		TODAY
	).id;
}

function bon(over: Partial<typeof transactions.$inferInsert> = {}): string {
	const id = db
		.insert(transactions)
		.values({
			amountCents: -1234,
			date: '2026-10-10',
			counterparty: 'Jumbo',
			accountId: sns,
			source: 'bon',
			categoryId: cat('Boodschappen'),
			...over
		})
		.returning({ id: transactions.id })
		.get().id;
	db.insert(receipts)
		.values({ fileId: randomUUID(), source: 'app', status: 'zeker', transactionId: id })
		.run();
	return id;
}

function record(over: Partial<ImportRecord> = {}): ImportRecord {
	return {
		accountIban: IBAN_OWN,
		date: '2026-10-12',
		amountCents: -2000,
		counterparty: 'ALBERT HEIJN',
		counterIban: null,
		description: 'Betaalautomaat 12-10-2026',
		bankReference: `REF-${randomUUID()}`,
		...over
	};
}

const all = () => db.select().from(transactions).all();
const row = (id: string) => db.select().from(transactions).where(eq(transactions.id, id)).get();
const merges = () =>
	db
		.select()
		.from(auditLog)
		.where(and(eq(auditLog.action, 'samengevoegd'), eq(auditLog.entity, 'transactions')))
		.all();

describe('automatisch samenvoegen bij een duidelijke voorsprong', () => {
	it('je invoer krijgt bedrag, datum en referentie van de bank; de rest blijft', () => {
		const id = manual();
		const file = [record({ bankReference: 'REF-AH-1012', counterIban: IBAN_SHOP })];
		const summary = importRecords(db, file, 'camt053');
		expect([summary.newCount, summary.duplicateCount]).toEqual([0, 1]);
		expect(summary.matched).toEqual({
			merged: [
				{
					id,
					counterparty: 'ALBERT HEIJN',
					amountCents: -2000,
					date: '2026-10-12',
					differenceCents: 0
				}
			],
			reviewCount: 0
		});
		expect(all()).toHaveLength(1);
		expect(row(id)).toMatchObject({
			amountCents: -2000,
			bankReference: 'REF-AH-1012',
			source: 'import',
			status: 'bevestigd',
			categoryId: cat('Boodschappen'),
			categorySource: 'handmatig',
			note: 'weekboodschappen',
			importBatchId: summary.batchId
		});
		const audit = merges();
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			entityId: id,
			before: { source: 'handmatig', amountCents: -2000 },
			after: { how: 'automatisch', differenceCents: 0 }
		});
		expect(JSON.stringify(audit)).not.toContain(IBAN_SHOP);
		expect(mergeInfo(db, id)).toMatchObject({ how: 'automatisch', differenceCents: 0 });

		// Dezelfde export nog een keer: ontdubbelen op bankreferentie, niets opnieuw samengevoegd
		const again = importRecords(db, file, 'camt053');
		expect([again.newCount, again.duplicateCount, again.matched.merged.length]).toEqual([0, 1, 0]);
		expect(all()).toHaveLength(1);
	});

	it('zonder bankreferentie ontdubbelt de hash bij een tweede import', () => {
		const id = manual();
		const file = [record({ bankReference: null })];
		importRecords(db, file, 'csv');
		expect(row(id)?.dedupeHash).toMatch(/^[0-9a-f]{64}$/);
		const again = importRecords(db, file, 'csv');
		expect([again.newCount, again.duplicateCount]).toEqual([0, 1]);
		expect(all()).toHaveLength(1);
	});

	it('een bon met een andere datum en een winkelnaam houdt zijn bon', () => {
		const id = bon();
		const summary = importRecords(
			db,
			[record({ date: '2026-10-11', amountCents: -1234, counterparty: 'JUMBO UTRECHT' })],
			'camt053'
		);
		expect(summary.matched.merged.map((m) => m.id)).toEqual([id]);
		expect(row(id)).toMatchObject({ date: '2026-10-11', source: 'import' });
		expect(db.select().from(receipts).get()?.transactionId).toBe(id);
		expect(mergeInfo(db, id)?.source).toBe('bon');
	});

	it('een met één tik bevestigde verwachte post telt ook als eigen invoer, een open post niet', () => {
		const confirmed = db
			.insert(transactions)
			.values({
				amountCents: -6000,
				date: '2026-10-01',
				counterparty: 'Ziggo',
				accountId: sns,
				source: 'verwacht',
				status: 'bevestigd'
			})
			.returning({ id: transactions.id })
			.get().id;
		const open = db
			.insert(transactions)
			.values({
				amountCents: -1500,
				date: '2026-10-20',
				counterparty: 'Spotify',
				accountId: sns,
				source: 'verwacht',
				status: 'verwacht'
			})
			.returning({ id: transactions.id })
			.get().id;
		const summary = importRecords(
			db,
			[
				record({ date: '2026-10-01', amountCents: -6000, counterparty: 'ZIGGO BV' }),
				record({ date: '2026-10-20', amountCents: -1500, counterparty: 'Spotify' })
			],
			'camt053'
		);
		expect(summary.matched.merged.map((m) => m.id)).toEqual([confirmed]);
		expect(summary.newCount).toBe(1);
		expect(row(open)?.status).toBe('verwacht');
	});

	it('een storno, een andere richting of een ver verwijderde datum telt niet', () => {
		manual();
		const summary = importRecords(
			db,
			[
				record({ reversal: true, amountCents: 2000 }),
				record({ amountCents: 2000 }),
				record({ date: '2026-10-20' })
			],
			'camt053'
		);
		expect(summary.matched).toEqual({ merged: [], reviewCount: 0 });
		expect(summary.newCount).toBe(3);
		expect(all().filter((t) => t.source === 'handmatig')).toHaveLength(1);
	});

	it('de import blijft één transactie: bij een fout is ook het samenvoegen terug', () => {
		const id = manual();
		const before = row(id);
		expect(() =>
			importRecords(db, [record(), record({ date: '12-10-2026', amountCents: -100 })], 'camt053')
		).toThrow();
		expect(row(id)).toEqual(before);
		expect(merges()).toHaveLength(0);
		expect(db.select().from(importBatches).all()).toHaveLength(0);
	});
});

describe('op te controleren met de koppellijst', () => {
	it('een fooi: de boeking wacht in de review-inbox met het verschil', () => {
		const id = manual({
			amountCents: -4500,
			counterparty: 'Café de Zaak',
			categoryId: cat('Uit eten en bezorgen')
		});
		const summary = importRecords(
			db,
			[record({ amountCents: -4600, counterparty: 'CAFE DE ZAAK' })],
			'camt053'
		);
		expect([summary.newCount, summary.matched.reviewCount]).toEqual([1, 1]);
		const pending = all().find((t) => t.source === 'import')!;
		expect(pending.status).toBe('te_controleren');

		const [item] = reviewInbox(db, TODAY).transactions;
		expect(item).toMatchObject({ id: pending.id, reason: 'dubbel', match: null });
		expect(item!.own?.preselect).toBeNull();
		expect(item!.own?.candidates).toEqual([
			expect.objectContaining({
				id,
				source: 'handmatig',
				label: 'waarschijnlijk',
				differenceCents: 100,
				categoryName: 'Uit eten en bezorgen',
				note: 'weekboodschappen'
			})
		]);
		expect(JSON.stringify(item)).not.toContain('counterIban');
	});

	it('samenvoegen: voorgeschoten delen blijven, de fooi gaat naar jouw deel', () => {
		const id = manual({
			amountCents: -4500,
			counterparty: 'Café de Zaak',
			share: { people: 3, with: ['Sanne', 'Tim'] }
		});
		const posts = db.select().from(owed).where(eq(owed.sourceTransactionId, id)).all();
		expect(posts.map((p) => p.amountCents)).toEqual([1500, 1500]);
		importRecords(
			db,
			[record({ amountCents: -4600, counterparty: 'CAFE DE ZAAK', bankReference: 'REF-CAFE' })],
			'camt053'
		);
		const pending = all().find((t) => t.source === 'import')!;

		expect(mergeImported(db, pending.id, id)).toEqual({ differenceCents: 100 });
		expect(all()).toHaveLength(1);
		expect(row(id)).toMatchObject({
			amountCents: -4600,
			bankReference: 'REF-CAFE',
			status: 'bevestigd',
			note: 'weekboodschappen'
		});
		const splits = db
			.select()
			.from(transactionSplits)
			.where(eq(transactionSplits.transactionId, id))
			.all();
		expect(splits.find((s) => s.note === MY_SHARE)?.amountCents).toBe(-1600);
		expect(splits.find((s) => s.note === ADVANCED)?.amountCents).toBe(-3000);
		expect(db.select().from(owed).where(eq(owed.sourceTransactionId, id)).all()).toHaveLength(2);
		expect(merges()[0]).toMatchObject({
			after: { how: 'gekozen', differenceCents: 100, replaced: pending.id }
		});
		expect(mergeInfo(db, id)).toEqual({
			enteredCents: -4500,
			enteredDate: '2026-10-12',
			source: 'handmatig',
			differenceCents: 100,
			how: 'gekozen'
		});
		expect(reviewInbox(db, TODAY).transactions).toHaveLength(0);
	});

	it('meerdere kandidaten: niet raden; na samenvoegen valt de gekozen af voor een tweede boeking', () => {
		const first = manual({ amountCents: -500, counterparty: 'Bakker', categoryId: null });
		const second = manual({
			amountCents: -500,
			counterparty: 'Bakker',
			date: '2026-10-13',
			categoryId: null
		});
		const summary = importRecords(
			db,
			[
				record({ amountCents: -500, counterparty: 'BAKKER', date: '2026-10-12' }),
				record({ amountCents: -500, counterparty: 'BAKKER', date: '2026-10-13' })
			],
			'camt053'
		);
		expect(summary.matched).toEqual({ merged: [], reviewCount: 2 });
		const items = reviewInbox(db, TODAY).transactions;
		expect(items.map((i) => i.own?.candidates.map((c) => c.id))).toEqual([
			[first, second],
			[second, first]
		]);
		mergeImported(db, items[0]!.id, first);
		// De eerste is nu een bankboeking en staat niet meer in de lijst van de tweede
		const [left] = reviewInbox(db, TODAY).transactions;
		expect(left!.own?.candidates.map((c) => c.id)).toEqual([second]);
		expect(() => mergeImported(db, left!.id, first)).toThrow(ValidationError);
		mergeImported(db, left!.id, second);
		expect(all().map((t) => t.source)).toEqual(['import', 'import']);
	});

	it('een kandidaat met een retour erop kan niet naar een ander bedrag', () => {
		const id = manual({ amountCents: -4000, counterparty: 'Zara' });
		manual({
			amountCents: 4000,
			counterparty: 'Zara',
			date: '2026-10-14',
			categoryId: null,
			correct: { transactionId: id, mode: 'verhouding' }
		});
		const summary = importRecords(
			db,
			[record({ amountCents: -3950, counterparty: 'ZARA', date: '2026-10-12' })],
			'camt053'
		);
		// De retour van €40 past niet op €39,50: geen kandidaat, gewoon een nieuwe boeking
		expect(summary.matched).toEqual({ merged: [], reviewCount: 0 });
		expect(summary.newCount).toBe(1);
	});

	it('weigert een transactie die niet in de koppellijst staat', () => {
		manual();
		const other = manual({ amountCents: -9900, counterparty: 'Bol' });
		importRecords(db, [record({ amountCents: -2050, counterparty: 'Albert Heijn' })], 'camt053');
		const pending = all().find((t) => t.source === 'import')!;
		expect(() => mergeImported(db, pending.id, other)).toThrow(ValidationError);
		expect(() => mergeImported(db, randomUUID(), other)).toThrow(ValidationError);
		expect(all()).toHaveLength(3);
	});
});

describe('acties in de review-inbox', () => {
	async function post(fields: Record<string, string>) {
		const form = new FormData();
		for (const [k, v] of Object.entries(fields)) form.set(k, v);
		const event = fakeEvent({
			path: '/te-controleren',
			routeId: '/(app)/te-controleren',
			method: 'POST'
		});
		const request = new Request(`${ORIGIN}/te-controleren?/merge`, {
			method: 'POST',
			body: form,
			headers: { origin: ORIGIN }
		});
		return (actions as Record<string, (e: never) => Promise<unknown>>).merge!({
			...event,
			request
		} as never);
	}

	it('samenvoegen of een nieuwe transactie, en ongeldige keuzes', async () => {
		const id = manual({ amountCents: -4500, counterparty: 'Café de Zaak' });
		importRecords(
			db,
			[
				record({ amountCents: -4600, counterparty: 'CAFE DE ZAAK' }),
				record({ amountCents: -4500, counterparty: 'KAPPER', date: '2026-10-13' })
			],
			'camt053'
		);
		const [cafe, kapper] = reviewInbox(db, TODAY).transactions;
		expect([cafe?.reason, kapper?.reason]).toEqual(['dubbel', 'dubbel']);

		expect(await post({ id: cafe!.id, target: 'geen-uuid' })).toMatchObject({ status: 400 });
		expect(await post({ id: cafe!.id, target: id })).toEqual({
			merged: cafe!.id,
			differenceCents: 100
		});
		// De kapper hoorde er niet bij: een nieuwe transactie
		expect(await post({ id: kapper!.id, target: 'nieuw' })).toEqual({
			merged: kapper!.id,
			differenceCents: null
		});
		expect(row(kapper!.id)?.status).toBe('bevestigd');
		expect(await post({ id: kapper!.id, target: 'nieuw' })).toMatchObject({ status: 400 });
		expect(reviewInbox(db, TODAY).transactions).toHaveLength(0);
		expect(all()).toHaveLength(2);
	});
});
