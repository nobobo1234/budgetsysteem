import { readFileSync } from 'node:fs';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	accounts,
	auditLog,
	categories,
	importBatches,
	peopleIbans,
	rules,
	transactions
} from '../../src/lib/server/db/schema.ts';
import { parseBankFile } from '../../src/lib/server/import/index.ts';
import {
	applyRules,
	countCardCounterpartyRepairs,
	fillCardCounterparties,
	importRecords,
	uncategorizedGroups
} from '../../src/lib/server/import/importer.ts';
import type { ImportRecord } from '../../src/lib/server/import/types.ts';
import { createPerson } from '../../src/lib/server/people.ts';
import { actions as importActions } from '../../src/routes/(app)/import/+page.server.ts';
import { fakeEvent, tempDatabase } from './helpers.ts';

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
		expect(applyRules(db)).toBe(1);
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

function categoryId(name: string): string {
	return db.select().from(categories).where(eq(categories.name, name)).get()!.id;
}

/** Zoals de import vóór deze reparatie: pinbetalingen zonder tegenpartij. */
function importWithoutMerchants(name: string) {
	const { format, records } = parseBankFile(file(name));
	const old = records.map((r) => (r.description.includes('MCC:') ? { ...r, counterparty: '' } : r));
	return importRecords(db, old, format);
}

const snapshot = () =>
	db
		.select({
			id: transactions.id,
			description: transactions.description,
			bankReference: transactions.bankReference,
			dedupeHash: transactions.dedupeHash,
			amountCents: transactions.amountCents,
			date: transactions.date
		})
		.from(transactions)
		.orderBy(transactions.id)
		.all();

describe('eigen rekening of persoon', () => {
	it('een IBAN van een persoon wordt geen eigen rekening', () => {
		const sanne = createPerson(db, 'Sanne');
		db.insert(peopleIbans).values({ personId: sanne, iban: 'NL12SNSB0123456789' }).run();
		expect(() => importFixture('camt053-v02.xml')).toThrow(/staat bij een persoon/);
		expect(db.select().from(transactions).all()).toEqual([]);
	});
});

describe('pinbetalingen zonder tegenpartij', () => {
	it('krijgen bij de import de winkel als tegenpartij', () => {
		const summary = importFixture('camt053-pin.xml');
		expect(summary.newCount).toBe(7);
		const names = db
			.select({ c: transactions.counterparty })
			.from(transactions)
			.all()
			.map((t) => t.c);
		expect(names).toContain('SUPERMARKT TEST 11');
		expect(names).toContain('Koffiebar Voorbeeld B.V.');
		expect(names.filter((n) => n === '')).toHaveLength(1);
		expect(summary.uncategorized.map((g) => g.pattern)).toContain('supermarkt test');
	});

	it('stellen een categorie voor op basis van de MCC, zonder te boeken', () => {
		const summary = importFixture('camt053-pin.xml');
		const byPattern = new Map(summary.uncategorized.map((g) => [g.pattern, g]));
		expect(byPattern.get('supermarkt test')).toMatchObject({
			count: 2,
			suggestedCategoryId: categoryId('Boodschappen')
		});
		expect(byPattern.get('koffiebar voorbeeld b v')?.suggestedCategoryId).toBe(
			categoryId('Uit eten en bezorgen')
		);
		expect(byPattern.get('verhuurder test')?.suggestedCategoryId).toBeNull();
		// Alleen een voorstel: de transacties zelf blijven zonder categorie
		const supermarkt = db
			.select()
			.from(transactions)
			.where(eq(transactions.counterparty, 'SUPERMARKT TEST 11'))
			.all();
		expect(supermarkt.every((t) => t.categoryId === null)).toBe(true);
	});

	it('een regel gaat voor op het MCC-voorstel', () => {
		db.insert(rules)
			.values({ field: 'tegenpartij', pattern: 'koffiebar', categoryId: categoryId('Uitgaan') })
			.run();
		const summary = importFixture('camt053-pin.xml');
		expect(summary.uncategorized.map((g) => g.pattern)).not.toContain('koffiebar voorbeeld b v');
		const koffie = db
			.select()
			.from(transactions)
			.where(eq(transactions.counterparty, 'Koffiebar Voorbeeld B.V.'))
			.get();
		expect(koffie?.categoryId).toBe(categoryId('Uitgaan'));
	});

	it('ontdubbelen verandert niet: een oude import zonder winkelnamen blijft dubbel', () => {
		importWithoutMerchants('camt053-pin.xml');
		const again = importFixture('camt053-pin.xml');
		expect(again.newCount).toBe(0);
		expect(again.duplicateCount).toBe(7);
	});
});

describe('reparatie van bestaande pinbetalingen', () => {
	it('vult de tegenpartij, past regels toe en legt elke wijziging vast', () => {
		importWithoutMerchants('camt053-pin.xml');
		db.insert(rules)
			.values({
				field: 'tegenpartij',
				pattern: 'supermarkt test',
				categoryId: categoryId('Boodschappen')
			})
			.run();
		const before = snapshot();

		expect(fillCardCounterparties(db)).toEqual({ updated: 5, categorized: 2 });

		const supermarkt = db
			.select()
			.from(transactions)
			.where(eq(transactions.counterparty, 'SUPERMARKT TEST 11'))
			.all();
		expect(supermarkt).toHaveLength(2);
		expect(supermarkt.every((t) => t.categoryId === categoryId('Boodschappen'))).toBe(true);
		// Omschrijving, referentie, hash, bedrag en datum blijven precies gelijk
		expect(snapshot()).toEqual(before);

		const audit = db
			.select()
			.from(auditLog)
			.where(eq(auditLog.action, 'tegenpartij_uit_pinbetaling'))
			.all();
		expect(audit).toHaveLength(5);
		expect(audit.find((a) => a.entityId === supermarkt[0]!.id)).toMatchObject({
			kind: 'wijziging',
			entity: 'transactions',
			before: { counterparty: '' },
			after: { counterparty: 'SUPERMARKT TEST 11' }
		});
	});

	it('is idempotent', () => {
		importWithoutMerchants('camt053-pin.xml');
		expect(fillCardCounterparties(db).updated).toBe(5);
		const after = db.select().from(transactions).orderBy(transactions.id).all();
		expect(fillCardCounterparties(db)).toEqual({ updated: 0, categorized: 0 });
		expect(db.select().from(transactions).orderBy(transactions.id).all()).toEqual(after);
		expect(
			db.select().from(auditLog).where(eq(auditLog.action, 'tegenpartij_uit_pinbetaling')).all()
		).toHaveLength(5);
		// En een nieuwe import van hetzelfde bestand levert daarna niets dubbel op
		expect(importFixture('camt053-pin.xml').newCount).toBe(0);
	});

	it('laat handmatige invoer, ingevulde namen en onbekende omschrijvingen staan', () => {
		importWithoutMerchants('camt053-pin.xml');
		const account = db.select().from(accounts).where(eq(accounts.alias, 'sns')).get()!;
		db.insert(transactions)
			.values({
				amountCents: -100,
				date: '2026-02-06',
				counterparty: '',
				description:
					'BAKKERIJ - 123456 Teststr>Utrecht 06.02.2026 8U05 KV011 PTR00001 MCC:5499 Betaling',
				accountId: account.id,
				source: 'handmatig'
			})
			.run();
		fillCardCounterparties(db);
		const empty = db
			.select({ source: transactions.source, description: transactions.description })
			.from(transactions)
			.where(eq(transactions.counterparty, ''))
			.all();
		expect(empty.map((t) => t.source).sort()).toEqual(['handmatig', 'import']);
		expect(
			db
				.select()
				.from(transactions)
				.where(
					and(eq(transactions.counterparty, 'Verhuurder Test'), eq(transactions.source, 'import'))
				)
				.all()
		).toHaveLength(1);
	});

	it('telt vooraf hoeveel er te repareren is', () => {
		importFixture('camt053-pin.xml');
		expect(countCardCounterpartyRepairs(db)).toBe(0);
		db.delete(transactions).run();
		importWithoutMerchants('camt053-pin.xml');
		expect(countCardCounterpartyRepairs(db)).toBe(5);
		fillCardCounterparties(db);
		expect(countCardCounterpartyRepairs(db)).toBe(0);
	});

	it('draait via de knop op de importpagina', async () => {
		importWithoutMerchants('camt053-pin.xml');
		const event = fakeEvent({ path: '/import?/repair', routeId: '/(app)/import', method: 'POST' });
		expect(await importActions.repair!(event as never)).toEqual({
			repaired: { updated: 5, categorized: 0 }
		});
		expect(await importActions.repair!(event as never)).toEqual({
			repaired: { updated: 0, categorized: 0 }
		});
	});

	it('maakt de groepen in het overzicht weer zichtbaar', () => {
		importWithoutMerchants('camt053-pin.xml');
		expect(uncategorizedGroups(db).map((g) => g.pattern)).toEqual(['verhuurder test']);
		fillCardCounterparties(db);
		expect(uncategorizedGroups(db).map((g) => g.pattern)).toContain('supermarkt test');
	});
});

describe('Revolut-import', () => {
	const revolut = () => db.select().from(accounts).where(eq(accounts.kind, 'revolut')).all();
	const tx = (description: string) =>
		db.select().from(transactions).where(eq(transactions.description, description)).all();

	it('importeert op de bestaande Revolut-rekening en ontdubbelt bij opnieuw importeren', () => {
		const summary = importFixture('revolut.csv');
		expect(summary.newCount).toBe(12);
		expect(summary.periodStart).toBe('2026-01-30');
		expect(summary.periodEnd).toBe('2026-07-05');
		expect(revolut()).toHaveLength(1);
		const all = db.select().from(transactions).all();
		expect(new Set(all.map((t) => t.accountId))).toEqual(new Set([revolut()[0]!.id]));
		expect(db.select().from(importBatches).get()?.format).toBe('revolut');

		const again = importFixture('revolut.csv');
		expect(again.newCount).toBe(0);
		expect(again.duplicateCount).toBe(12);
		expect(db.select().from(transactions).all()).toHaveLength(12);
	});

	it('bewaart het bedrag in kronen naast het eurobedrag', () => {
		importFixture('revolut.csv');
		expect(tx('ICA Maxi')[0]).toMatchObject({
			amountCents: -4000,
			origAmountCents: -46000,
			origCurrency: 'SEK',
			status: 'bevestigd'
		});
	});

	it('opwaarderen is intern, het koersverschil niet', () => {
		importFixture('revolut.csv');
		const internal = db
			.select()
			.from(categories)
			.where(eq(categories.name, 'Interne overboeking'))
			.get();
		expect(tx('Opwaardering via Apple Pay')[0]).toMatchObject({
			categoryId: internal?.id,
			categorySource: 'intern'
		});
		expect(tx('Koersverschil bij wisselen SEK naar EUR')[0]).toMatchObject({
			amountCents: -540,
			categoryId: null
		});
	});

	it('een geschat eurobedrag krijgt de status te controleren', () => {
		const csv =
			'Type,Product,Startdatum,Datum voltooid,Beschrijving,Bedrag,Kosten,Valuta,Status,Saldo\n' +
			'Kaartbetaling,Betaalrekening,2026-02-01 10:00:00,2026-02-01 10:00:00,ICA,-10.00,0.00,SEK,VOLTOOID,90.00\n' +
			'Wisselen,Betaalrekening,2026-02-02 10:00:00,2026-02-02 10:00:00,Naar SEK,-10.00,0.00,EUR,VOLTOOID,0.00\n' +
			'Wisselen,Betaalrekening,2026-02-02 10:00:00,2026-02-02 10:00:00,Van EUR,100.00,0.00,SEK,VOLTOOID,190.00\n';
		const { format, records } = parseBankFile(new TextEncoder().encode(csv));
		importRecords(db, records, format);
		expect(tx('ICA')[0]).toMatchObject({ amountCents: -100, status: 'te_controleren' });
	});

	it('maakt een Revolut-rekening aan als die er niet is', () => {
		db.delete(accounts).where(eq(accounts.kind, 'revolut')).run();
		importFixture('revolut.csv');
		expect(revolut()).toMatchObject([{ name: 'Revolut', alias: 'rev', iban: null }]);
	});

	it('importeert met een begindatum alleen boekingen vanaf die datum', () => {
		const { format, records } = parseBankFile(file('revolut.csv'));
		const summary = importRecords(db, records, format, { from: '2026-07-01' });
		expect(summary).toMatchObject({ newCount: 7, earlierCount: 5, periodStart: '2026-07-01' });
		// Het koersverschil is berekend met de wissels van vóór de begindatum
		expect(tx('Koersverschil bij wisselen SEK naar EUR')[0]?.amountCents).toBe(-540);
		expect(tx('ICA Maxi')).toHaveLength(0);
		expect(() => importRecords(db, records, format, { from: '2026-08-01' })).toThrow(
			/vanaf deze datum/
		);
	});

	it('het uploadformulier geeft de begindatum door en weigert een ongeldige', async () => {
		const upload = (from: string) => {
			const body = new FormData();
			body.set('file', new File([file('revolut.csv')], 'revolut.csv', { type: 'text/csv' }));
			body.set('from', from);
			const request = new Request('http://localhost/import?/upload', { method: 'POST', body });
			return importActions.upload!({ request } as never);
		};
		expect(await upload('01-07-2026')).toMatchObject({
			status: 400,
			data: { message: 'Ongeldige begindatum.' }
		});
		expect(db.select().from(transactions).all()).toHaveLength(0);
		expect(await upload('2026-07-01')).toMatchObject({ summary: { newCount: 7, earlierCount: 5 } });
		expect(await upload('')).toMatchObject({
			summary: { newCount: 5, duplicateCount: 7, earlierCount: 0 }
		});
	});

	it('weigert bij meerdere Revolut-rekeningen en importeert dan niets', () => {
		db.insert(accounts).values({ name: 'Revolut 2', kind: 'revolut', alias: 'rev2' }).run();
		expect(() => importFixture('revolut.csv')).toThrow(/meerdere Revolut-rekeningen/);
		expect(db.select().from(transactions).all()).toHaveLength(0);
	});
});
