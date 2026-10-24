import Database from 'better-sqlite3';
import { asc, eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spendingByCategory } from '../../src/lib/server/budgets.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	accounts,
	categories,
	owed,
	owedPayments,
	people,
	transactionSplits,
	transactions
} from '../../src/lib/server/db/schema.ts';
import {
	applyShare,
	createOwed,
	deleteOwed,
	forgiveOwed,
	matchCandidates,
	owedOverview,
	owedReminders,
	settlePayment,
	unlinkPayment,
	updateOwed
} from '../../src/lib/server/owed.ts';
import {
	addIban,
	createPerson,
	deletePerson,
	findOrCreatePerson,
	removeIban,
	updatePerson
} from '../../src/lib/server/people.ts';
import {
	createTransaction,
	deleteTransaction,
	updateTransaction,
	ValidationError
} from '../../src/lib/server/transactions.ts';
import { newTransactionSchema } from '../../src/lib/server/validation.ts';
import { tempDatabase } from './helpers.ts';

let db: DB;
let cleanup: () => void;
let sns: string;
let cat: (name: string) => string;

// Alleen test-IBANs (zie scripts/check-ibans.mjs)
const IBAN_SANNE = 'NL91ABNA0417164300';
const IBAN_OWN = 'NL20INGB0001234567';

beforeEach(() => {
	({ db, cleanup } = tempDatabase());
	sns = db.select().from(accounts).where(eq(accounts.alias, 'sns')).get()!.id;
	cat = (name) => db.select().from(categories).where(eq(categories.name, name)).get()!.id;
});
afterEach(() => cleanup());

const TODAY = '2026-10-23';

function tx(over: Partial<Record<string, unknown>> = {}) {
	const input = newTransactionSchema.parse({
		id: crypto.randomUUID(),
		amountCents: -4500,
		date: '2026-10-20',
		counterparty: 'Etentje',
		categoryId: cat('Uit eten en bezorgen'),
		accountId: sns,
		...over
	});
	createTransaction(db, input, TODAY);
	return input.id;
}

const person = (name: string) =>
	db.select().from(people).where(eq(people.name, name)).get()?.id ?? null;

function posts(sourceTransactionId?: string) {
	return db
		.select({
			id: owed.id,
			person: people.name,
			amountCents: owed.amountCents,
			status: owed.status,
			direction: owed.direction
		})
		.from(owed)
		.leftJoin(people, eq(people.id, owed.personId))
		.where(sourceTransactionId ? eq(owed.sourceTransactionId, sourceTransactionId) : undefined)
		.orderBy(asc(owed.date), asc(owed.createdAt), asc(sql`owed.rowid`))
		.all();
}

const splits = (id: string) =>
	Object.fromEntries(
		db
			.select()
			.from(transactionSplits)
			.where(eq(transactionSplits.transactionId, id))
			.all()
			.map((s) => [s.note, s.amountCents])
	);

const payments = (transactionId: string) =>
	db
		.select({ owedId: owedPayments.owedId, amountCents: owedPayments.amountCents })
		.from(owedPayments)
		.where(eq(owedPayments.transactionId, transactionId))
		.all();

const status = (id: string) =>
	db.select().from(transactions).where(eq(transactions.id, id)).get()?.status;

describe('voorschieten', () => {
	it('€10 met sanne en tim: jij 3,33 in de categorie, Sanne 3,34 en Tim 3,33 te krijgen', () => {
		const id = tx({ amountCents: -1000, share: { people: 3, with: ['sanne', 'Tim'] } });
		expect(splits(id)).toEqual({ 'Mijn deel': -333, Voorgeschoten: -667 });
		expect(posts(id).map((p) => [p.person, p.amountCents, p.status])).toEqual([
			['Sanne', 334, 'open'],
			['Tim', 333, 'open']
		]);
		// Nieuwe personen krijgen een hoofdletter; alleen jouw deel telt in het budget
		expect(spendingByCategory(db, '2026-10').get(cat('Uit eten en bezorgen'))).toBe(333);
		expect(spendingByCategory(db, '2026-10').get(cat('Terugbetaling'))).toBe(667);
	});

	it('bestaande personen worden hergebruikt, hoofdletters maken niet uit', () => {
		createPerson(db, 'Sanne');
		tx({ share: { people: 2, with: ['SANNE'] } });
		expect(db.select().from(people).all()).toHaveLength(1);
	});

	it('voor 3 zonder namen: twee posten zonder persoon, later te kiezen', () => {
		const id = tx({ share: { people: 3, with: [] } });
		expect(posts(id).map((p) => [p.person, p.amountCents])).toEqual([
			[null, 1500],
			[null, 1500]
		]);
		const [first] = posts(id);
		updateOwed(db, first!.id, { personId: findOrCreatePerson(db, 'Eva') });
		expect(posts(id)[0]!.person).toBe('Eva');
	});

	it('bedrag per persoon: jouw deel is wat overblijft, nul mag, meer dan het totaal niet', () => {
		const id = tx();
		const sanne = findOrCreatePerson(db, 'Sanne');
		const tim = findOrCreatePerson(db, 'Tim');
		db.transaction((t) => applyShare(t, id, { personIds: [sanne, tim], amounts: [2000, 1000] }));
		expect(splits(id)).toEqual({ 'Mijn deel': -1500, Voorgeschoten: -3000 });
		db.transaction((t) => applyShare(t, id, { personIds: [sanne, tim], amounts: [2500, 2000] }));
		expect(splits(id)['Mijn deel']).toBe(0);
		expect(() =>
			db.transaction((t) => applyShare(t, id, { personIds: [sanne, tim], amounts: [2500, 2001] }))
		).toThrow(/meer dan het totaal/);
		// Geweigerd: de vorige verdeling staat er nog
		expect(posts(id).map((p) => p.amountCents)).toEqual([2500, 2000]);
	});

	it('verdeling weghalen of iemand dubbel noemen', () => {
		const id = tx({ share: { people: 2, with: ['Sanne'] } });
		const sanne = person('Sanne')!;
		expect(() => db.transaction((t) => applyShare(t, id, { personIds: [sanne, sanne] }))).toThrow(
			/twee keer/
		);
		db.transaction((t) => applyShare(t, id, null));
		expect(posts(id)).toEqual([]);
		expect(splits(id)).toEqual({});
		expect(spendingByCategory(db, '2026-10').get(cat('Uit eten en bezorgen'))).toBe(4500);
	});

	it('een inkomende transactie kun je niet delen', () => {
		const id = tx({ amountCents: 1000, categoryId: null });
		expect(() =>
			db.transaction((t) => applyShare(t, id, { personIds: [findOrCreatePerson(t, 'X')] }))
		).toThrow(ValidationError);
	});

	it('een andere categorie verhuist jouw deel mee', () => {
		const id = tx({ share: { people: 3, with: [] } });
		updateTransaction(db, id, { categoryId: cat('Uitgaan') }, TODAY);
		expect(spendingByCategory(db, '2026-10').get(cat('Uitgaan'))).toBe(1500);
	});
});

describe('ontvangen', () => {
	function shared() {
		const id = tx({ amountCents: -3000, share: { people: 3, with: ['Sanne', 'Tim'] } });
		const [sanne, tim] = posts(id);
		return { id, sanne: sanne!, tim: tim! };
	}

	it('+10 van Sanne betaalt haar post', () => {
		const { sanne } = shared();
		const pay = tx({
			amountCents: 1000,
			counterparty: 'Sanne',
			categoryId: cat('Terugbetaling'),
			settle: { owedId: sanne.id }
		});
		expect(payments(pay)).toEqual([{ owedId: sanne.id, amountCents: 1000 }]);
		expect(posts().find((p) => p.id === sanne.id)?.status).toBe('betaald');
		expect(status(pay)).toBe('bevestigd');
	});

	it('een deelbetaling laat de rest open', () => {
		const { sanne } = shared();
		tx({ amountCents: 400, categoryId: null, settle: { owedId: sanne.id } });
		expect(posts().find((p) => p.id === sanne.id)?.status).toBe('deels');
		const overview = owedOverview(db, TODAY);
		expect(overview.toReceiveCents).toBe(600 + 1000);
	});

	it('één betaling dekt meer posten (oudste eerst), de rest is tegoed voor de volgende post', () => {
		const first = tx({
			amountCents: -2000,
			date: '2026-10-01',
			share: { people: 2, with: ['Sanne'] }
		});
		const second = tx({
			amountCents: -3000,
			date: '2026-10-10',
			share: { people: 2, with: ['Sanne'] }
		});
		const [a] = posts(first);
		const [b] = posts(second);
		// Sanne betaalt de nieuwste post aan, maar met genoeg voor beide en €2 extra
		const pay = tx({ amountCents: 2700, categoryId: null, settle: { owedId: b!.id } });
		expect(payments(pay)).toEqual([
			{ owedId: b!.id, amountCents: 1500 },
			{ owedId: a!.id, amountCents: 1000 },
			{ owedId: null, amountCents: 200 }
		]);
		expect(owedOverview(db, TODAY).creditCents).toBe(200);
		// Een nieuwe post gaat eerst van het tegoed af
		const third = tx({ amountCents: -1000, share: { people: 2, with: ['Sanne'] } });
		const [c] = posts(third);
		expect(posts().find((p) => p.id === c!.id)?.status).toBe('deels');
		expect(owedOverview(db, TODAY).creditCents).toBe(0);
		expect(owedOverview(db, TODAY).toReceiveCents).toBe(300);
	});

	it('meerdere betalingen voor één post', () => {
		const { tim } = shared();
		tx({ amountCents: 300, categoryId: null, settle: { owedId: tim.id } });
		tx({ amountCents: 700, categoryId: null, settle: { owedId: tim.id } });
		expect(posts().find((p) => p.id === tim.id)?.status).toBe('betaald');
	});

	it('opnieuw versturen (offline wachtrij) koppelt niet dubbel', () => {
		const { sanne } = shared();
		const input = newTransactionSchema.parse({
			id: crypto.randomUUID(),
			amountCents: 1000,
			date: '2026-10-21',
			counterparty: 'Sanne',
			categoryId: null,
			accountId: sns,
			settle: { owedId: sanne.id }
		});
		createTransaction(db, input, TODAY);
		createTransaction(db, input, TODAY);
		expect(db.select().from(owedPayments).all()).toHaveLength(1);
	});

	it('een post die er niet meer is: transactie blijft, te controleren, geen koppeling', () => {
		const pay = tx({
			amountCents: 1000,
			categoryId: null,
			settle: { owedId: crypto.randomUUID() }
		});
		expect(status(pay)).toBe('te_controleren');
		expect(payments(pay)).toEqual([]);
	});

	it('een uitgave koppelt niet aan een post te krijgen', () => {
		const { sanne } = shared();
		expect(
			db.transaction((t) => settlePayment(t, tx({ amountCents: -1000 }), { owedId: sanne.id }))
		).toBe(false);
	});

	it('betaling verwijderen of losmaken zet de post weer open', () => {
		const { sanne } = shared();
		const pay = tx({ amountCents: 1000, categoryId: null, settle: { owedId: sanne.id } });
		deleteTransaction(db, pay);
		expect(posts().find((p) => p.id === sanne.id)?.status).toBe('open');

		const again = tx({ amountCents: 1000, categoryId: null, settle: { owedId: sanne.id } });
		db.transaction((t) => unlinkPayment(t, again));
		expect(posts().find((p) => p.id === sanne.id)?.status).toBe('open');
	});

	it('een ander bedrag op een gekoppelde betaling wordt opnieuw verdeeld', () => {
		const { sanne } = shared();
		const pay = tx({ amountCents: 1000, categoryId: null, settle: { owedId: sanne.id } });
		updateTransaction(db, pay, { amountCents: 600 }, TODAY);
		expect(payments(pay)).toEqual([{ owedId: sanne.id, amountCents: 600 }]);
		expect(posts().find((p) => p.id === sanne.id)?.status).toBe('deels');
	});

	it('de uitgave verwijderen: open posten vervallen, (deels) betaalde blijven', () => {
		const { id, sanne, tim } = shared();
		tx({ amountCents: 500, categoryId: null, settle: { owedId: sanne.id } });
		deleteTransaction(db, id);
		const left = posts();
		expect(left.map((p) => p.id)).toEqual([sanne.id]);
		expect(left.some((p) => p.id === tim.id)).toBe(false);
	});

	it('een nieuwe verdeling wordt geweigerd als er al betaald is', () => {
		const { id, sanne } = shared();
		tx({ amountCents: 500, categoryId: null, settle: { owedId: sanne.id } });
		expect(() => db.transaction((t) => applyShare(t, id, null))).toThrow(/al betaald/);
	});
});

describe('kwijtschelden', () => {
	it('het open deel komt voor jouw rekening in de oorspronkelijke maand, en terug', () => {
		const id = tx({ amountCents: -3000, share: { people: 3, with: ['Sanne', 'Tim'] } });
		const [sanne] = posts(id);
		tx({ amountCents: 400, categoryId: null, settle: { owedId: sanne!.id } });
		forgiveOwed(db, sanne!.id);
		expect(posts(id)[0]!.status).toBe('kwijtgescholden');
		expect(splits(id)).toEqual({ 'Mijn deel': -1600, Voorgeschoten: -1400 });
		expect(spendingByCategory(db, '2026-10').get(cat('Uit eten en bezorgen'))).toBe(1600);

		forgiveOwed(db, sanne!.id, true);
		expect(posts(id)[0]!.status).toBe('deels');
		expect(splits(id)).toEqual({ 'Mijn deel': -1000, Voorgeschoten: -2000 });
		expect(() => forgiveOwed(db, sanne!.id, true)).toThrow(ValidationError);
	});
});

describe('nog te betalen', () => {
	it('een losse post te betalen, afgelost met een uitgave', () => {
		const tim = createPerson(db, 'Tim');
		const post = createOwed(db, {
			personId: tim,
			direction: 'te_betalen',
			amountCents: 1250,
			description: 'Bioscoop',
			date: '2026-10-18'
		});
		const overview = owedOverview(db, TODAY);
		expect(overview.toPayCents).toBe(1250);
		expect(overview.toReceiveCents).toBe(0);

		const pay = tx({
			amountCents: -1250,
			counterparty: 'Tim',
			categoryId: null,
			settle: { owedId: post }
		});
		expect(payments(pay)).toEqual([{ owedId: post, amountCents: 1250 }]);
		expect(owedOverview(db, TODAY).toPayCents).toBe(0);
	});

	it('een losse post verwijderen; een post van een uitgave niet', () => {
		const tim = createPerson(db, 'Tim');
		const post = createOwed(db, {
			personId: tim,
			direction: 'te_krijgen',
			amountCents: 500,
			description: 'Contant',
			date: '2026-10-18'
		});
		deleteOwed(db, post);
		expect(posts()).toEqual([]);
		const id = tx({ share: { people: 2, with: ['Tim'] } });
		expect(() => deleteOwed(db, posts(id)[0]!.id)).toThrow(/verdeling/);
	});
});

describe('overzicht', () => {
	it('per persoon, hoe lang open, en de herinnering na 14 dagen', () => {
		tx({ amountCents: -2000, date: '2026-10-01', share: { people: 2, with: ['Sanne'] } });
		tx({ amountCents: -1000, date: '2026-10-20', share: { people: 2, with: ['Tim'] } });
		const o = owedOverview(db, TODAY);
		expect(o.toReceiveCents).toBe(1500);
		expect(o.people.map((p) => [p.name, p.toReceiveCents, p.oldestDate])).toEqual([
			['Sanne', 1000, '2026-10-01'],
			['Tim', 500, '2026-10-20']
		]);
		expect(o.people[0]!.posts[0]).toMatchObject({ daysOpen: 22, remind: true });
		expect(o.people[1]!.posts[0]).toMatchObject({ daysOpen: 3, remind: false });
		expect(owedReminders(db, TODAY).map((p) => p.personName)).toEqual(['Sanne']);
	});

	it('Tikkie-link en notitie bij een post', () => {
		const id = tx({ share: { people: 2, with: ['Sanne'] } });
		const [p] = posts(id);
		updateOwed(db, p!.id, { tikkieUrl: 'https://tikkie.me/pay/abc', note: 'Gestuurd in de groep' });
		const row = db.select().from(owed).where(eq(owed.id, p!.id)).get()!;
		expect(row.tikkieUrl).toBe('https://tikkie.me/pay/abc');
		expect(row.note).toBe('Gestuurd in de groep');
	});
});

describe('koppellijst op de server', () => {
	it('een bekende IBAN telt als volle score op naam', () => {
		const sanneId = createPerson(db, 'Sanne');
		addIban(db, sanneId, IBAN_SANNE);
		tx({ amountCents: -2000, date: '2026-10-20', share: { people: 2, with: ['Sanne'] } });
		tx({ amountCents: -2000, date: '2026-10-20', share: { people: 2, with: ['Tim'] } });
		const pay = tx({ amountCents: 1000, counterparty: 'S. DE VRIES', categoryId: null });
		db.update(transactions).set({ counterIban: IBAN_SANNE }).where(eq(transactions.id, pay)).run();
		const result = matchCandidates(db, pay);
		expect(result.candidates[0]?.personName).toBe('Sanne');
		expect(result.candidates[0]?.label).toBe('waarschijnlijk');
		expect(result.preselect).toBeNull();
		expect(result.ibanPerson).toBe(sanneId);
	});
});

describe('personen', () => {
	it('naam uniek zonder op hoofdletters te letten', () => {
		createPerson(db, 'Sanne');
		expect(() => createPerson(db, 'sanne')).toThrow(/bestaat al/);
		const tim = createPerson(db, 'tim');
		expect(() => updatePerson(db, tim, { name: 'SANNE' })).toThrow(/bestaat al/);
		expect(updatePerson(db, tim, { name: 'Tim de Vries', active: false })).toMatchObject({
			name: 'Tim de Vries',
			active: false
		});
	});

	it('IBAN: geldig, bij één persoon, nooit een eigen rekening', () => {
		db.update(accounts).set({ iban: IBAN_OWN }).where(eq(accounts.id, sns)).run();
		const sanne = createPerson(db, 'Sanne');
		const tim = createPerson(db, 'Tim');
		expect(() => addIban(db, sanne, 'NL00BANK0000000000')).toThrow(/klopt niet/);
		expect(() => addIban(db, sanne, IBAN_OWN)).toThrow(/eigen rekening/);
		addIban(db, sanne, 'nl91 abna 0417 1643 00');
		addIban(db, sanne, IBAN_SANNE);
		expect(() => addIban(db, tim, IBAN_SANNE)).toThrow(/iemand anders/);
		removeIban(db, sanne, IBAN_SANNE);
		addIban(db, tim, IBAN_SANNE);
	});

	it('verwijderen kan alleen zonder posten', () => {
		const eva = createPerson(db, 'Eva');
		deletePerson(db, eva);
		tx({ share: { people: 2, with: ['Sanne'] } });
		expect(() => deletePerson(db, person('Sanne')!)).toThrow(/niet actief/);
	});
});

describe('migratie 0002: personen en betalingen', () => {
	function statements(file: string): string[] {
		return readFileSync(`drizzle/${file}`, 'utf8')
			.split('--> statement-breakpoint')
			.map((s) => s.trim())
			.filter(Boolean);
	}

	it('namen worden personen, betaald-via wordt een betaling', () => {
		const sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		for (const s of [...statements('0000_init.sql'), ...statements('0001_regelbron.sql')])
			sqlite.exec(s);
		sqlite.exec(`
			INSERT INTO accounts (id, name, kind, alias) VALUES ('a', 'SNS', 'sns', 'sns');
			INSERT INTO transactions (id, amount_cents, date, account_id, source, counterparty) VALUES
				('t-eten', -4500, '2026-09-01', 'a', 'handmatig', 'Etentje'),
				('t-terug', 1500, '2026-09-03', 'a', 'handmatig', 'Sanne');
			INSERT INTO owed (id, person, amount_cents, direction, source_transaction_id, status, paid_via_transaction_id, created_at) VALUES
				('o1', 'Sanne', 1500, 'te_krijgen', 't-eten', 'betaald', 't-terug', '2026-09-01T10:00:00.000Z'),
				('o2', 'sanne ', 1500, 'te_krijgen', 't-eten', 'open', NULL, '2026-09-01T10:00:00.000Z'),
				('o3', '2 anderen', 3000, 'te_krijgen', NULL, 'open', NULL, '2026-09-05T10:00:00.000Z');
		`);
		// Zoals de migrator: alles in één transactie, met foreign keys aan
		sqlite.transaction(() => {
			for (const s of statements('0002_te_krijgen.sql')) sqlite.exec(s);
		})();

		const peopleRows = sqlite.prepare('SELECT id, name FROM people').all() as {
			id: string;
			name: string;
		}[];
		expect(peopleRows.map((p) => p.name)).toEqual(['Sanne']);
		expect(peopleRows[0]!.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
		);
		const owedRows = sqlite
			.prepare('SELECT id, person_id, description, date, status FROM owed ORDER BY id')
			.all();
		expect(owedRows).toEqual([
			{
				id: 'o1',
				person_id: peopleRows[0]!.id,
				description: 'Etentje',
				date: '2026-09-01',
				status: 'betaald'
			},
			{
				id: 'o2',
				person_id: peopleRows[0]!.id,
				description: 'Etentje',
				date: '2026-09-01',
				status: 'open'
			},
			{ id: 'o3', person_id: null, description: '', date: '2026-09-05', status: 'open' }
		]);
		expect(
			sqlite
				.prepare('SELECT transaction_id, person_id, owed_id, amount_cents FROM owed_payments')
				.all()
		).toEqual([
			{ transaction_id: 't-terug', person_id: peopleRows[0]!.id, owed_id: 'o1', amount_cents: 1500 }
		]);
		expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
		sqlite.close();
	});
});
