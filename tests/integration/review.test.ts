import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDays, toIsoDate } from '../../src/lib/dates.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	accounts,
	auditLog,
	categories,
	owed,
	recurring,
	transactions
} from '../../src/lib/server/db/schema.ts';
import { ValidationError } from '../../src/lib/server/errors.ts';
import { parseBankFile } from '../../src/lib/server/import/index.ts';
import { importRecords } from '../../src/lib/server/import/importer.ts';
import { createOwed, settlePayment } from '../../src/lib/server/owed.ts';
import { createPerson } from '../../src/lib/server/people.ts';
import { generateMonth } from '../../src/lib/server/recurring.ts';
import {
	inboxCount,
	leaveInInbox,
	reviewInbox,
	type ReviewInbox
} from '../../src/lib/server/review.ts';
import { addIban, confirmReceived, createShare, updateShare } from '../../src/lib/server/shares.ts';
import { actions } from '../../src/routes/(app)/te-controleren/+page.server.ts';
import { fakeEvent, ORIGIN, tempDatabase } from './helpers.ts';

// Review-inbox: de verzameling uit de bestaande bronnen, laten staan, en de acties van de pagina.
// Alleen test-IBANs (scripts/test-ibans.txt).
const IBAN_SANNE = 'NL91ABNA0417164300';
const IBAN_ZIGGO = 'NL18RABO0123459876';

let db: DB;
let cleanup: () => void;
let sns: string;
let ziggo: string;
let sanne: string;
let tim: string;

beforeEach(() => {
	({ db, cleanup } = tempDatabase());
	sns = db.select().from(accounts).where(eq(accounts.alias, 'sns')).get()!.id;
	const category = db
		.select()
		.from(categories)
		.where(eq(categories.name, 'Internet en telefoon'))
		.get()!.id;
	ziggo = db
		.insert(recurring)
		.values({
			matchKey: `ziggo|${IBAN_ZIGGO}`,
			counterparty: 'Ziggo',
			counterIban: IBAN_ZIGGO,
			interval: 'maand',
			expectedDay: 1,
			medianCents: 6000,
			minCents: 6000,
			maxCents: 6000,
			kind: 'vast',
			nextDate: '2026-10-01',
			categoryId: category,
			accountId: sns,
			status: 'actief'
		})
		.returning()
		.get().id;
	sanne = createPerson(db, 'Sanne');
	tim = createPerson(db, 'Tim');
	addIban(db, sanne, IBAN_SANNE);
});
afterEach(() => cleanup());

const sizes = (inbox: ReviewInbox) =>
	Object.fromEntries(Object.entries(inbox).map(([k, v]: [string, unknown[]]) => [k, v.length]));

/** Sanne betaalt €20 van Ziggo, ontvangstdag de 1e; de post van oktober staat er meteen. */
function shareOfSanne() {
	const id = createShare(
		db,
		{
			recurringId: ziggo,
			personId: sanne,
			kind: 'vast',
			amountCents: 2000,
			receiveDay: 1,
			startMonth: '2026-10'
		},
		'2026-10-01'
	);
	generateMonth(db, '2026-10');
	const post = db.select().from(owed).where(eq(owed.shareId, id)).get()!;
	return { shareId: id, postId: post.id };
}

function payment(cents: number, date: string, personId = sanne) {
	const id = db
		.insert(transactions)
		.values({ amountCents: cents, date, accountId: sns, source: 'handmatig' })
		.returning()
		.get().id;
	settlePayment(db, id, { personId });
	return id;
}

describe('verzameling', () => {
	it('leeg: niets te controleren', () => {
		const inbox = reviewInbox(db, '2026-10-05');
		expect(sizes(inbox)).toEqual({
			receipts: 0,
			missed: 0,
			transactions: 0,
			late: 0,
			credit: 0,
			reminders: 0
		});
		expect(inboxCount(inbox)).toBe(0);
	});

	it('een verwachte post komt na 7 dagen als gemist of opgezegd', () => {
		generateMonth(db, '2026-10');
		expect(reviewInbox(db, '2026-10-07').missed).toEqual([]);
		const missed = reviewInbox(db, '2026-10-08').missed;
		expect(missed.map((m) => [m.counterparty, m.date, m.missed])).toEqual([
			['Ziggo', '2026-10-01', true]
		]);
	});

	it('een storno zonder kenmerk staat er met een voorstel uit de koppellijst', () => {
		const { format, records } = parseBankFile(readFileSync('tests/fixtures/camt053-storno.xml'));
		importRecords(db, records, format);
		const { transactions: items } = reviewInbox(db, '2026-10-05');
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			amountCents: 2000,
			reason: 'koppelen',
			match: { amountCents: -2000 }
		});
		// Geen IBANs naar de pagina
		expect(JSON.stringify(items)).not.toMatch(/NL\d{2}[A-Z]{4}/);
	});

	it('zonder eurobedrag: eerst het bedrag invullen; zonder kandidaat gewoon nakijken', () => {
		db.insert(transactions)
			.values([
				{
					amountCents: 0,
					origAmountCents: 2000,
					origCurrency: 'USD',
					date: '2026-10-02',
					counterparty: 'Netflix',
					accountId: sns,
					source: 'handmatig',
					status: 'te_controleren'
				},
				{
					amountCents: -1250,
					date: '2026-10-03',
					counterparty: 'ICA Supermarket',
					accountId: sns,
					source: 'import',
					status: 'te_controleren'
				}
			])
			.run();
		const reasons = reviewInbox(db, '2026-10-05').transactions.map((t) => [
			t.counterparty,
			t.reason
		]);
		expect(reasons).toEqual([
			['Netflix', 'bedrag'],
			['ICA Supermarket', 'controleren']
		]);
	});

	it('een aandeel is te laat een week na de ontvangstdag, en staat niet ook bij herinneren', () => {
		const { postId } = shareOfSanne();
		expect(reviewInbox(db, '2026-10-08').late).toEqual([]);
		expect(reviewInbox(db, '2026-10-09').late.map((l) => [l.id, l.personName])).toEqual([
			[postId, 'Sanne']
		]);
		// Na 14 dagen nog steeds alleen bij te laat
		const later = reviewInbox(db, '2026-10-20');
		expect(later.late).toHaveLength(1);
		expect(later.reminders).toEqual([]);
		// Ontvangen: weg
		confirmReceived(db, postId, '2026-10-20');
		expect(reviewInbox(db, '2026-10-20').late).toEqual([]);
	});

	it('herinneren: een post te krijgen die 14 dagen openstaat', () => {
		createOwed(db, {
			personId: tim,
			direction: 'te_krijgen',
			amountCents: 1500,
			description: 'Etentje',
			date: '2026-09-21'
		});
		createOwed(db, {
			personId: tim,
			direction: 'te_betalen',
			amountCents: 900,
			description: 'Bioscoop',
			date: '2026-09-01'
		});
		expect(reviewInbox(db, '2026-10-04').reminders).toEqual([]);
		const reminders = reviewInbox(db, '2026-10-05').reminders;
		expect(reminders.map((r) => [r.personName, r.description, r.daysOpen])).toEqual([
			['Tim', 'Etentje', 14]
		]);
	});
});

describe('tegoed', () => {
	it('dubbel betaald: een tweede betaling wordt tegoed en meldt zich', () => {
		const { postId } = shareOfSanne();
		confirmReceived(db, postId, '2026-10-02');
		payment(2000, '2026-10-03');
		expect(reviewInbox(db, '2026-10-04').credit).toEqual([
			{
				personId: sanne,
				personName: 'Sanne',
				creditCents: 2000,
				date: '2026-10-03',
				reason: 'dubbel'
			}
		]);
	});

	it('vooruitbetaald kort voor de volgende ontvangstdag: geen melding', () => {
		const { postId } = shareOfSanne();
		confirmReceived(db, postId, '2026-10-02');
		// Op de 28e voor de 1e: de post van november is er nog niet
		payment(2000, '2026-10-28');
		expect(reviewInbox(db, '2026-10-29').credit).toEqual([]);
		// Meer dan het aandeel is wel te veel
		payment(2000, '2026-10-29');
		expect(reviewInbox(db, '2026-10-29').credit.map((c) => c.creditCents)).toEqual([4000]);
	});

	it('na vertrek: een latere overboeking wordt tegoed', () => {
		const { shareId, postId } = shareOfSanne();
		updateShare(db, shareId, { endMonth: '2026-10' });
		confirmReceived(db, postId, '2026-10-02');
		payment(2000, '2026-11-02');
		expect(reviewInbox(db, '2026-11-03').credit.map((c) => c.reason)).toEqual(['vertrokken']);
	});

	it('zonder gedeelde last: te veel ontvangen', () => {
		createOwed(db, {
			personId: tim,
			direction: 'te_krijgen',
			amountCents: 1000,
			description: 'Pizza',
			date: '2026-10-01'
		});
		payment(1500, '2026-10-02', tim);
		expect(reviewInbox(db, '2026-10-03').credit).toMatchObject([
			{ personName: 'Tim', creditCents: 500, reason: 'teveel' }
		]);
	});

	it('laten staan meldt het eenmalig; een nieuwe overboeking meldt zich weer', () => {
		const { postId } = shareOfSanne();
		confirmReceived(db, postId, '2026-10-02');
		payment(2000, '2026-10-03');
		leaveInInbox(db, 'tegoed', sanne, '2026-10-04');
		expect(reviewInbox(db, '2026-10-04').credit).toEqual([]);
		// In het audit-log
		expect(
			db
				.select()
				.from(auditLog)
				.where(and(eq(auditLog.entity, 'review'), eq(auditLog.action, 'laten_staan')))
				.all()
		).toHaveLength(1);
		expect(() => leaveInInbox(db, 'tegoed', sanne, '2026-10-04')).toThrow(ValidationError);
		payment(2000, '2026-10-05');
		expect(reviewInbox(db, '2026-10-05').credit.map((c) => c.creditCents)).toEqual([4000]);
	});
});

describe('laten staan', () => {
	it('te laat en herinnering verdwijnen uit de inbox, en blijven verder zoals ze waren', () => {
		const { postId } = shareOfSanne();
		const tikkie = createOwed(db, {
			personId: tim,
			direction: 'te_krijgen',
			amountCents: 1500,
			description: 'Etentje',
			date: '2026-09-21'
		});
		const before = reviewInbox(db, '2026-10-09');
		expect([before.late.length, before.reminders.length]).toEqual([1, 1]);
		leaveInInbox(db, 'te_laat', postId, '2026-10-09');
		leaveInInbox(db, 'herinnering', tikkie, '2026-10-09');
		const after = reviewInbox(db, '2026-10-09');
		expect([after.late.length, after.reminders.length]).toEqual([0, 0]);
		expect(db.select().from(owed).where(eq(owed.id, tikkie)).get()?.status).toBe('open');
	});

	it('weigert wat niet in de inbox hoort', () => {
		const fresh = createOwed(db, {
			personId: tim,
			direction: 'te_krijgen',
			amountCents: 1500,
			description: 'Etentje',
			date: '2026-10-08'
		});
		// Nog geen 14 dagen open, geen maandaandeel, en een onbekende persoon zonder tegoed
		expect(() => leaveInInbox(db, 'herinnering', fresh, '2026-10-09')).toThrow(ValidationError);
		expect(() => leaveInInbox(db, 'te_laat', fresh, '2026-10-09')).toThrow(ValidationError);
		expect(() => leaveInInbox(db, 'tegoed', tim, '2026-10-09')).toThrow(ValidationError);
	});
});

describe('acties op de pagina', () => {
	async function post(action: string, fields: Record<string, string>) {
		const form = new FormData();
		for (const [k, v] of Object.entries(fields)) form.set(k, v);
		const event = fakeEvent({
			path: '/te-controleren',
			routeId: '/(app)/te-controleren',
			method: 'POST'
		});
		const request = new Request(`${ORIGIN}/te-controleren?/${action}`, {
			method: 'POST',
			body: form,
			headers: { origin: ORIGIN }
		});
		return (actions as Record<string, (e: never) => Promise<unknown>>)[action]!({
			...event,
			request
		} as never);
	}

	it('klopt: een boeking op te controleren wordt bevestigd; zonder eurobedrag niet', async () => {
		const [checked, noEuro] = db
			.insert(transactions)
			.values([
				{
					amountCents: -1250,
					date: '2026-10-03',
					counterparty: 'ICA Supermarket',
					accountId: sns,
					source: 'import' as const,
					status: 'te_controleren' as const
				},
				{
					amountCents: 0,
					origAmountCents: 2000,
					origCurrency: 'USD',
					date: '2026-10-02',
					counterparty: 'Netflix',
					accountId: sns,
					source: 'handmatig' as const,
					status: 'te_controleren' as const
				}
			])
			.returning()
			.all();
		expect(await post('confirm', { id: checked!.id })).toEqual({ confirmed: checked!.id });
		expect(
			db.select().from(transactions).where(eq(transactions.id, checked!.id)).get()
		).toMatchObject({ status: 'bevestigd', amountCents: -1250 });
		expect(await post('confirm', { id: checked!.id })).toMatchObject({ status: 400 });
		expect(await post('confirm', { id: noEuro!.id })).toMatchObject({ status: 400 });
	});

	it('laten staan en teruggeven', async () => {
		const today = toIsoDate(new Date());
		const tikkie = createOwed(db, {
			personId: tim,
			direction: 'te_krijgen',
			amountCents: 1500,
			description: 'Etentje',
			date: addDays(today, -20)
		});
		expect(await post('leave', { kind: 'herinnering', id: tikkie })).toEqual({ left: tikkie });
		expect(await post('leave', { kind: 'herinnering', id: tikkie })).toMatchObject({
			status: 400
		});
		expect(await post('leave', { kind: 'iets', id: tikkie })).toMatchObject({ status: 400 });

		payment(500, today, tim);
		expect(reviewInbox(db, today).credit).toHaveLength(0);
		payment(2500, today, tim);
		expect(reviewInbox(db, today).credit.map((c) => c.creditCents)).toEqual([1500]);
		expect(await post('payable', { personId: tim })).toEqual({ payable: tim });
		expect(reviewInbox(db, today).credit).toEqual([]);
		const payable = db.select().from(owed).where(eq(owed.direction, 'te_betalen')).get();
		expect(payable).toMatchObject({ personId: tim, amountCents: 1500 });
	});
});
