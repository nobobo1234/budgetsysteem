// Garantie: voorstellen in de review-inbox, bijhouden en afwijzen, het bewijs bewaren, een retour
// op een actieve garantie, en de melding om 9:00 (één per moment, niets na afdanken).
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDays, toIsoDate } from '../../src/lib/dates.ts';
import { zonedTime } from '../../src/lib/closing.ts';
import { linkCorrection } from '../../src/lib/server/corrections.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	accounts,
	auditLog,
	categories,
	receipts,
	transactions,
	warranties
} from '../../src/lib/server/db/schema.ts';
import { ValidationError } from '../../src/lib/server/errors.ts';
import { runDueJobs, unregisterJob } from '../../src/lib/server/jobs.ts';
import { applyShare } from '../../src/lib/server/owed.ts';
import { createPerson } from '../../src/lib/server/people.ts';
import {
	markSent,
	notify,
	setNotificationSetting,
	type NotifyMessage
} from '../../src/lib/server/push/notify.ts';
import { deleteReceipt } from '../../src/lib/server/receipts/process.ts';
import type { Send } from '../../src/lib/server/recurring-notify.ts';
import { reviewInbox } from '../../src/lib/server/review.ts';
import { deleteTransaction } from '../../src/lib/server/transactions.ts';
import {
	createWarranty,
	discardWarranty,
	keepRefunded,
	warrantyProposals
} from '../../src/lib/server/warranty.ts';
import {
	notifyWarranties,
	scheduleWarrantyNotifications,
	WARRANTY_JOB
} from '../../src/lib/server/warranty-notify.ts';
import { actions as productActions } from '../../src/routes/(app)/garantie/[id]/+page.server.ts';
import { actions as inboxActions } from '../../src/routes/(app)/te-controleren/+page.server.ts';
import { fakeEvent, ORIGIN, tempDatabase } from './helpers.ts';

// De acties op de pagina's rekenen met de echte datum; de voorstellen dus ook
const TODAY = toIsoDate(new Date());
const RECENT = addDays(TODAY, -8);

let db: DB;
let cleanup: () => void;
let sns: string;
beforeEach(() => {
	({ db, cleanup } = tempDatabase());
	sns = db.select().from(accounts).where(eq(accounts.alias, 'sns')).get()!.id;
});
afterEach(() => {
	unregisterJob(WARRANTY_JOB);
	cleanup();
});

const category = (name: string) =>
	db.select().from(categories).where(eq(categories.name, name)).get()!.id;

function spend(cents: number, date = RECENT, categoryName = 'Elektronica') {
	return db
		.insert(transactions)
		.values({
			amountCents: -cents,
			date,
			counterparty: 'COOLBLUE B.V.',
			categoryId: category(categoryName),
			accountId: sns,
			source: 'handmatig'
		})
		.returning()
		.get().id;
}

/** Een retour van de winkel, gekoppeld aan de uitgave. */
function refund(originalId: string, cents: number, date = addDays(RECENT, 3)) {
	const id = db
		.insert(transactions)
		.values({
			amountCents: cents,
			date,
			counterparty: 'COOLBLUE B.V.',
			categoryId: category('Elektronica'),
			accountId: sns,
			source: 'handmatig'
		})
		.returning()
		.get().id;
	db.transaction((t) => linkCorrection(t, id, originalId));
	return id;
}

const proposed = (today = TODAY) => warrantyProposals(db, today).map((p) => p.transactionId);
const warrantyRow = (id: string) => db.select().from(warranties).where(eq(warranties.id, id)).get();

type Action = (e: never) => Promise<unknown>;

async function post(
	actions: Record<string, unknown>,
	path: string,
	routeId: string,
	action: string,
	fields: Record<string, string>,
	params: Record<string, string> = {}
) {
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.set(k, v);
	const event = fakeEvent({ path, routeId, method: 'POST', params });
	const request = new Request(`${ORIGIN}${path}?/${action}`, {
		method: 'POST',
		body: form,
		headers: { origin: ORIGIN }
	});
	return (actions as Record<string, Action>)[action]!({ ...event, request } as never);
}

const inbox = (action: string, fields: Record<string, string>) =>
	post(inboxActions, '/te-controleren', '/(app)/te-controleren', action, fields);

const product = (id: string, action: string, fields: Record<string, string> = {}) =>
	post(productActions, `/garantie/${id}`, '/(app)/garantie/[id]', action, fields, { id });

describe('voorstellen', () => {
	it('een uitgave vanaf € 50 bij Elektronica komt in de review-inbox', () => {
		const laptop = spend(64900);
		const cable = spend(4999);
		spend(8000, RECENT, 'Boodschappen');
		const fifty = spend(5000);
		expect(proposed()).toEqual(expect.arrayContaining([laptop, fifty]));
		expect(proposed()).not.toContain(cable);
		expect(proposed()).toHaveLength(2);
		expect(reviewInbox(db, TODAY).warranties[0]).toMatchObject({
			counterparty: 'COOLBLUE B.V.',
			categoryName: 'Elektronica'
		});
	});

	it('de schakelaar per categorie: standaard alleen Elektronica', () => {
		const on = db
			.select({ name: categories.name })
			.from(categories)
			.where(eq(categories.tracksWarranty, true))
			.all();
		expect(on).toEqual([{ name: 'Elektronica' }]);
		const coat = spend(19900, RECENT, 'Kleding');
		expect(proposed()).toEqual([]);
		db.update(categories).set({ tracksWarranty: true }).where(eq(categories.name, 'Kleding')).run();
		expect(proposed()).toEqual([coat]);
	});

	it('de drempel geldt voor jouw deel, zoals bij Budget', () => {
		const sanne = createPerson(db, 'Sanne');
		// € 120 betaald, Sanne € 80: jouw deel € 40
		const small = spend(12000);
		db.transaction((t) => applyShare(t, small, { personIds: [sanne], amounts: [8000] }));
		// € 160 betaald, Sanne € 80: jouw deel € 80
		const big = spend(16000);
		db.transaction((t) => applyShare(t, big, { personIds: [sanne], amounts: [8000] }));
		expect(proposed()).toEqual([big]);
		expect(warrantyProposals(db, TODAY)[0]!.shareCents).toBe(8000);
	});

	it('een retour die de uitgave helemaal verrekent, haalt het voorstel weg; een deel niet', () => {
		const laptop = spend(64900);
		const phone = spend(30000);
		refund(laptop, 64900);
		refund(phone, 5000);
		expect(proposed()).toEqual([phone]);
	});

	it('alleen in het eerste jaar na aankoop, en geen verwachte of te controleren posten', () => {
		spend(64900, addDays(TODAY, -370));
		const expected = spend(64900);
		db.update(transactions).set({ status: 'verwacht' }).where(eq(transactions.id, expected)).run();
		expect(proposed()).toEqual([]);
	});

	it('afwijzen: het voorstel komt niet terug, ook niet na een wijziging', async () => {
		const laptop = spend(64900);
		expect(await inbox('rejectWarranty', { transactionId: laptop })).toEqual({ rejected: laptop });
		expect(proposed()).toEqual([]);
		db.update(transactions).set({ amountCents: -70000 }).where(eq(transactions.id, laptop)).run();
		expect(proposed()).toEqual([]);
		// Een tweede keer afwijzen kan niet: er staat niets meer
		expect(await inbox('rejectWarranty', { transactionId: laptop })).toMatchObject({
			status: 400
		});
		const audit = db.select().from(auditLog).where(eq(auditLog.action, 'afgewezen')).all();
		expect(audit).toHaveLength(1);
	});

	it('bevestigen met de naam van het product: naar zijn pagina, met de bon erbij', async () => {
		const laptop = spend(64900);
		const bon = db
			.insert(receipts)
			.values({
				fileId: crypto.randomUUID(),
				source: 'app',
				status: 'zeker',
				transactionId: laptop
			})
			.returning()
			.get().id;
		await expect(
			inbox('warranty', { transactionId: laptop, product: '  Laptop  ' })
		).rejects.toMatchObject({
			status: 303,
			location: expect.stringMatching(/^\/garantie\/[0-9a-f-]{36}$/)
		});
		const [w] = db.select().from(warranties).all();
		expect(w).toMatchObject({
			product: 'Laptop',
			transactionId: laptop,
			receiptId: bon,
			purchaseDate: RECENT,
			deliveryDate: RECENT,
			factoryUntil: null,
			lifetimeYears: 5,
			status: 'actief'
		});
		expect(proposed()).toEqual([]);
		// Zonder naam lukt het niet
		const phone = spend(30000);
		expect(await inbox('warranty', { transactionId: phone, product: ' ' })).toMatchObject({
			status: 400
		});
	});

	it('zelf bijhouden kan ook na afwijzen, en bij een aankoop buiten de regel', () => {
		const laptop = spend(64900);
		const old = spend(9900, '2024-05-01', 'Hobby en entertainment');
		expect(() => createWarranty(db, { transactionId: old, product: 'Koptelefoon' })).not.toThrow();
		const income = db
			.insert(transactions)
			.values({ amountCents: 5000, date: TODAY, accountId: sns, source: 'handmatig' })
			.returning()
			.get().id;
		expect(() => createWarranty(db, { transactionId: income, product: 'Iets' })).toThrow(
			ValidationError
		);
		expect(proposed()).toEqual([laptop]);
	});
});

describe('bewijs bewaren', () => {
	it('de transactie en de bon blijven staan tot je het product afdankt', async () => {
		const laptop = spend(64900);
		const bon = db
			.insert(receipts)
			.values({
				fileId: crypto.randomUUID(),
				source: 'app',
				status: 'zeker',
				transactionId: laptop
			})
			.returning()
			.get().id;
		const id = createWarranty(db, { transactionId: laptop, product: 'Laptop' });
		expect(() => deleteTransaction(db, laptop)).toThrow(/bewijs voor de garantie op Laptop/);
		await expect(deleteReceipt(db, bon)).rejects.toThrow(ValidationError);
		expect(db.select().from(transactions).where(eq(transactions.id, laptop)).get()).toBeDefined();

		expect(await product(id, 'discard')).toEqual({ discarded: true });
		expect(warrantyRow(id)?.status).toBe('afgedankt');
		expect(await deleteReceipt(db, bon)).toBe(true);
		expect(deleteTransaction(db, laptop)).toBe(true);
		expect(warrantyRow(id)).toBeUndefined();
	});

	it('een retour op een actieve garantie vraagt of het product weg is', async () => {
		const laptop = spend(64900);
		const id = createWarranty(db, { transactionId: laptop, product: 'Laptop' });
		expect(reviewInbox(db, TODAY).warrantyRefunds).toEqual([]);
		refund(laptop, 64900);
		expect(reviewInbox(db, TODAY).warrantyRefunds.map((w) => w.id)).toEqual([id]);

		// Is er nog: laten staan, en hij komt niet terug
		expect(await inbox('keepWarranty', { id })).toEqual({ kept: id });
		expect(reviewInbox(db, TODAY).warrantyRefunds).toEqual([]);
		expect(warrantyRow(id)?.status).toBe('actief');
		expect(() => keepRefunded(db, id)).toThrow(ValidationError);
	});

	it('een retour: afdanken haalt hem uit de inbox', async () => {
		const laptop = spend(64900);
		const id = createWarranty(db, { transactionId: laptop, product: 'Laptop' });
		refund(laptop, 64900);
		expect(await inbox('discardWarranty', { id })).toEqual({ discarded: id });
		expect(warrantyRow(id)?.status).toBe('afgedankt');
		expect(reviewInbox(db, TODAY).warrantyRefunds).toEqual([]);
	});
});

describe('de pagina van het product', () => {
	it('opslaan zet de gegevens; een afgedankt product wijzig je niet meer', async () => {
		const id = createWarranty(db, { transactionId: spend(64900), product: 'Laptop' });
		const fields = {
			product: 'MacBook Air',
			deliveryDate: '2026-10-23',
			factoryUntil: '2027-10-23',
			lifetimeYears: '6'
		};
		expect(await product(id, 'save', fields)).toEqual({ saved: true });
		expect(warrantyRow(id)).toMatchObject({
			product: 'MacBook Air',
			deliveryDate: '2026-10-23',
			factoryUntil: '2027-10-23',
			lifetimeYears: 6
		});
		expect(await product(id, 'save', { ...fields, factoryUntil: '' })).toEqual({ saved: true });
		expect(warrantyRow(id)?.factoryUntil).toBeNull();
		expect(await product(id, 'save', { ...fields, lifetimeYears: '0' })).toMatchObject({
			status: 400
		});
		expect(await product(id, 'save', { ...fields, deliveryDate: '2026-02-30' })).toMatchObject({
			status: 400
		});
		discardWarranty(db, id);
		expect(await product(id, 'save', fields)).toMatchObject({ status: 400 });
	});
});

describe('melding om 9:00', () => {
	function recorder() {
		const calls: { day: string; message: NotifyMessage }[] = [];
		let day = '';
		const send: Send = async (kind, message) => {
			expect(kind).toBe('garantie');
			calls.push({ day, message });
			markSent(db, kind, [message.key!]);
			return { status: 'verstuurd', sent: 1 };
		};
		return { calls, send, at: (d: string) => (day = d) };
	}

	/** Laat de dagelijkse taak `days` dagen lang draaien, elke ochtend om 9:00 in Nederland. */
	async function runDays(from: string, days: number, at: (day: string) => void) {
		for (let i = 0; i < days; i++) {
			const day = addDays(from, i);
			at(day);
			// Om 8:59 nog niets, om 9:00 wel; 's middags draait er niets dubbel
			await runDueJobs(db, new Date(zonedTime(day, 9).getTime() - 60_000));
			await runDueJobs(db, new Date(zonedTime(day, 9).getTime() + 10_000));
		}
	}

	it('klaar-criterium: een afleverdatum die je terugzet, geeft op de juiste dag één melding', async () => {
		// Gekocht op 10 maart, standaard afgeleverd op dezelfde dag: melding zou op 8 februari komen
		const laptop = spend(129900, '2026-03-10');
		const id = createWarranty(db, { transactionId: laptop, product: 'laptop' });
		expect(warrantyRow(id)?.deliveryDate).toBe('2026-03-10');
		// Op de pagina de afleverdatum terugzetten naar 1 maart
		expect(
			await product(id, 'save', {
				product: 'laptop',
				deliveryDate: '2026-03-01',
				factoryUntil: '',
				lifetimeYears: '5'
			})
		).toEqual({ saved: true });

		const { calls, send, at } = recorder();
		scheduleWarrantyNotifications(db, new Date('2027-01-01T12:00:00Z'), send);
		await runDays('2027-01-02', 70, at);

		// Eén melding, op 30 januari: 30 dagen voor 1 maart; niet op 8 februari
		expect(calls.map((c) => c.day)).toEqual(['2027-01-30']);
		expect(calls[0]!.message).toEqual({
			key: `garantie:jaar:${id}:2027-03-01`,
			text: 'Een garantie loopt over 30 dagen af',
			detail:
				'Nog 30 dagen waarin Coolblue moet bewijzen dat je laptop in orde was. Werkt alles nog?',
			url: `/garantie/${id}`
		});
		// Nog een ronde dezelfde dag stuurt niets dubbel
		expect(await notifyWarranties(db, new Date('2027-01-30T14:00:00Z'), send)).toBe(0);
		expect(calls).toHaveLength(1);
	});

	it('één melding per moment: het eerste jaar en de fabrieksgarantie', async () => {
		const id = createWarranty(db, {
			transactionId: spend(64900, '2026-03-10'),
			product: 'wasmachine',
			factoryUntil: '2027-04-30'
		});
		const { calls, send, at } = recorder();
		scheduleWarrantyNotifications(db, new Date('2027-01-31T12:00:00Z'), send);
		await runDays('2027-02-01', 100, at);
		expect(calls.map((c) => [c.day, c.message.key])).toEqual([
			['2027-02-08', `garantie:jaar:${id}:2027-03-10`],
			['2027-03-31', `garantie:fabriek:${id}:2027-04-30`]
		]);
		expect(calls[1]!.message.detail).toBe(
			'Nog 30 dagen fabrieksgarantie op je wasmachine. Werkt alles nog?'
		);
	});

	it('een gemiste ochtend komt de volgende ochtend alsnog, met het echte aantal dagen', async () => {
		createWarranty(db, { transactionId: spend(64900, '2026-03-10'), product: 'laptop' });
		const { calls, send, at } = recorder();
		// De server startte pas op 12 februari
		scheduleWarrantyNotifications(db, new Date('2027-02-12T10:00:00Z'), send);
		await runDays('2027-02-12', 40, at);
		expect(calls.map((c) => c.day)).toEqual(['2027-02-13']);
		expect(calls[0]!.message.text).toBe('Een garantie loopt over 25 dagen af');
	});

	it('niets na afdanken, en niets voor een afgewezen voorstel', async () => {
		const id = createWarranty(db, { transactionId: spend(64900, '2026-03-10'), product: 'laptop' });
		const other = spend(30000, '2026-03-10');
		db.insert(warranties)
			.values({
				transactionId: other,
				purchaseDate: '2026-03-10',
				deliveryDate: '2026-03-10',
				lifetimeYears: 5,
				status: 'afgewezen'
			})
			.run();
		discardWarranty(db, id);
		const { calls, send, at } = recorder();
		scheduleWarrantyNotifications(db, new Date('2027-01-31T12:00:00Z'), send);
		await runDays('2027-02-01', 40, at);
		expect(calls).toEqual([]);
	});

	it('met de schakelaar uit gaat er niets uit', async () => {
		createWarranty(db, { transactionId: spend(64900, '2026-03-10'), product: 'laptop' });
		setNotificationSetting(db, 'garantie', false);
		// Met de echte verzender: die respecteert de schakelaar per soort
		const statuses: string[] = [];
		const send: Send = async (kind, message, conn) => {
			const result = await notify(kind, message, conn);
			statuses.push(result.status);
			return result;
		};
		expect(await notifyWarranties(db, new Date('2027-02-08T09:00:00Z'), send)).toBe(0);
		expect(statuses).toEqual(['uit']);
	});
});
