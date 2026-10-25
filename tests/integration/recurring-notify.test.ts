// Ochtendmeldingen: vaste lasten, Tikkies en budget → pushmeldingen. Een nagebootste push-dienst: nooit echte netwerkaanroepen, en
// de VAPID- en apparaatsleutels worden per test gemaakt.
import { createECDH, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../../src/lib/server/auth/session.ts';
import { freeShareUsed, notifyBudgetThreshold } from '../../src/lib/server/budget-notify.ts';
import { setBudget } from '../../src/lib/server/budgets.ts';
import { resetConfig } from '../../src/lib/server/config.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	accounts,
	categories,
	jobs,
	pushSubscriptions,
	recurring,
	transactions
} from '../../src/lib/server/db/schema.ts';
import { runDueJobs } from '../../src/lib/server/jobs.ts';
import { createOwed } from '../../src/lib/server/owed.ts';
import { notifyOpenTikkies } from '../../src/lib/server/owed-notify.ts';
import { createPerson } from '../../src/lib/server/people.ts';
import {
	setNotificationSetting,
	usePushTransport,
	type NotifyMessage
} from '../../src/lib/server/push/notify.ts';
import type { PushRequest } from '../../src/lib/server/push/webpush.ts';
import {
	NOTIFY_JOB,
	isDaytime,
	nextMorning,
	notifyDueExpected,
	scheduleRecurringNotifications,
	type Send
} from '../../src/lib/server/recurring-notify.ts';
import { tempDatabase } from './helpers.ts';

const TODAY = '2026-10-20';
const ENV_KEYS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] as const;

let db: DB;
let cleanup: () => void;
let sent: PushRequest[];

beforeEach(() => {
	({ db, cleanup } = tempDatabase());
	sent = [];
	usePushTransport(async (request) => {
		sent.push(request);
		return 201;
	});
});

afterEach(() => {
	usePushTransport(undefined);
	for (const k of ENV_KEYS) delete process.env[k];
	resetConfig();
	cleanup();
});

/** Een actieve vaste last met een post op `date` in de gegeven status. */
function post(counterparty: string, date: string, status: 'verwacht' | 'bevestigd' = 'verwacht') {
	const account = db.select().from(accounts).where(eq(accounts.alias, 'sns')).get()!.id;
	const category = db.select().from(categories).where(eq(categories.name, 'Wonen')).get()!.id;
	const r = db
		.insert(recurring)
		.values({
			matchKey: `${counterparty.toLowerCase()}|`,
			counterparty,
			interval: 'maand',
			expectedDay: Number(date.slice(8, 10)),
			medianCents: 85000,
			minCents: 85000,
			maxCents: 85000,
			kind: 'vast',
			nextDate: date,
			categoryId: category,
			accountId: account,
			status: 'actief'
		})
		.returning()
		.get();
	return db
		.insert(transactions)
		.values({
			amountCents: -85000,
			date,
			counterparty,
			categoryId: category,
			accountId: account,
			source: 'verwacht',
			status,
			recurringId: r.id
		})
		.returning()
		.get().id;
}

/** VAPID-sleutels in de omgeving en één apparaat met een geldige sessie. */
function pushReady() {
	const vapid = createECDH('prime256v1');
	vapid.generateKeys();
	process.env.VAPID_PUBLIC_KEY = vapid.getPublicKey().toString('base64url');
	const d = vapid.getPrivateKey();
	process.env.VAPID_PRIVATE_KEY = Buffer.concat([Buffer.alloc(32 - d.length), d]).toString(
		'base64url'
	);
	process.env.VAPID_SUBJECT = 'https://budget.example';
	resetConfig();
	const phone = createECDH('prime256v1');
	phone.generateKeys();
	const { idHash } = createSession(db, { passkeyId: null, deviceName: 'telefoon' });
	db.insert(pushSubscriptions)
		.values({
			endpoint: `https://web.push.apple.com/${randomBytes(12).toString('base64url')}`,
			p256dh: phone.getPublicKey().toString('base64url'),
			auth: randomBytes(16).toString('base64url'),
			deviceName: 'telefoon',
			sessionIdHash: idHash
		})
		.run();
}

describe('wanneer een vaste last een melding krijgt', () => {
	it('alleen als de dag gekomen is, niet gemist en nog niet bevestigd', async () => {
		const due = post('Woonstichting', TODAY);
		post('Later deze maand', '2026-10-28');
		post('Al gemist', '2026-10-10');
		post('Al bevestigd', '2026-10-19', 'bevestigd');

		const calls: { kind: string; message: NotifyMessage }[] = [];
		const send: Send = async (kind, message) => {
			calls.push({ kind, message });
			return { status: 'verstuurd', sent: 1 };
		};
		expect(await notifyDueExpected(db, TODAY, send)).toBe(1);
		expect(calls).toEqual([
			{
				kind: 'vaste_last',
				message: {
					key: `verwacht:${due}`,
					// Op het vergrendelscherm standaard zonder bedrag of naam
					text: 'Een vaste last wacht op bevestiging',
					// Intl zet een vaste spatie na het euroteken
					detail: expect.stringMatching(/^Woonstichting: €\s850,00 wacht op bevestiging$/),
					url: '/'
				}
			}
		]);
	});

	it('één melding per post: de tweede keer is dubbel', async () => {
		pushReady();
		post('Woonstichting', TODAY);
		expect(await notifyDueExpected(db, TODAY)).toBe(1);
		expect(sent).toHaveLength(1);
		expect(await notifyDueExpected(db, '2026-10-21')).toBe(0);
		expect(sent).toHaveLength(1);
	});

	it('de schakelaar "Vaste last klaar" uit: geen melding', async () => {
		pushReady();
		post('Woonstichting', TODAY);
		setNotificationSetting(db, 'vaste_last', false);
		expect(await notifyDueExpected(db, TODAY)).toBe(0);
		expect(sent).toEqual([]);
	});
});

describe('ochtendjob', () => {
	it('niet midden in de nacht: overdag meteen, anders om 9 uur', () => {
		expect(isDaytime(new Date(2026, 9, 1, 0, 5))).toBe(false);
		expect(isDaytime(new Date(2026, 9, 1, 9, 0))).toBe(true);
		expect(isDaytime(new Date(2026, 9, 1, 21, 0))).toBe(false);
		expect(nextMorning(new Date(2026, 9, 1, 0, 5))).toEqual(new Date(2026, 9, 1, 9, 0));
		expect(nextMorning(new Date(2026, 9, 31, 22, 0))).toEqual(new Date(2026, 10, 1, 9, 0));
	});

	it('draait om 9 uur, stuurt de melding en plant de volgende ochtend in', async () => {
		pushReady();
		post('Woonstichting', TODAY);
		// De maandjob maakte de post om 00:05; de melding wacht tot de ochtend
		scheduleRecurringNotifications(db, new Date(2026, 9, 20, 0, 5));
		expect(runDueJobs(db, new Date(2026, 9, 20, 8, 59))).toBe(0);
		expect(runDueJobs(db, new Date(2026, 9, 20, 9, 0, 30))).toBe(1);
		await vi.waitFor(() => expect(sent).toHaveLength(1));

		const next = db
			.select()
			.from(jobs)
			.where(and(eq(jobs.kind, NOTIFY_JOB), eq(jobs.status, 'wachtend')))
			.all();
		expect(next.map((j) => new Date(j.runAt))).toEqual([new Date(2026, 9, 21, 9, 0)]);
	});
});

/** Een melding-functie die alleen opschrijft wat hij zou sturen. */
function recorder() {
	const calls: { kind: string; message: NotifyMessage }[] = [];
	const send: Send = async (kind, message) => {
		calls.push({ kind, message });
		return { status: 'verstuurd', sent: 1 };
	};
	return { calls, send };
}

/** Een post te krijgen (of te betalen) bij een nieuwe persoon. */
function owedPost(
	name: string,
	date: string,
	direction: 'te_krijgen' | 'te_betalen' = 'te_krijgen'
) {
	return createOwed(db, {
		personId: createPerson(db, name),
		direction,
		amountCents: 1250,
		description: 'Etentje',
		date
	});
}

describe('Tikkie staat 14 dagen open', () => {
	it('alleen posten te krijgen die 14 dagen of langer openstaan', async () => {
		const old = owedPost('Sanne', '2026-10-06');
		owedPost('Tim', '2026-10-07');
		owedPost('Joost', '2026-09-01', 'te_betalen');

		const { calls, send } = recorder();
		expect(await notifyOpenTikkies(db, TODAY, send)).toBe(1);
		expect(calls).toEqual([
			{
				kind: 'tikkie',
				message: {
					key: `open:${old}`,
					text: 'Een Tikkie staat 14 dagen open',
					detail: expect.stringMatching(/^Sanne moet je nog €\s12,50 terugbetalen$/),
					url: '/te-krijgen'
				}
			}
		]);
	});

	it('meerdere tegelijk: één gebundelde melding, daarna niet opnieuw', async () => {
		pushReady();
		owedPost('Sanne', '2026-09-01');
		owedPost('Tim', '2026-09-15');
		expect(await notifyOpenTikkies(db, TODAY)).toBe(1);
		expect(sent).toHaveLength(1);
		expect(await notifyOpenTikkies(db, '2026-10-21')).toBe(0);
		expect(sent).toHaveLength(1);

		// Een nieuwe post die later 14 dagen open is, krijgt wel zijn eigen melding
		owedPost('Joost', '2026-10-10');
		expect(await notifyOpenTikkies(db, '2026-10-24')).toBe(1);
		expect(sent).toHaveLength(2);
	});

	it('meerdere tegelijk: aantal en totaal, zonder namen op het vergrendelscherm', async () => {
		owedPost('Sanne', '2026-09-01');
		owedPost('Tim', '2026-09-15');
		const { calls, send } = recorder();
		await notifyOpenTikkies(db, TODAY, send);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.message.text).toBe('2 Tikkies staan 14 dagen open');
		expect(calls[0]!.message.detail).toMatch(/samen €\s25,00$/);
	});

	it('de schakelaar uit: geen melding, en na aanzetten alsnog', async () => {
		pushReady();
		owedPost('Sanne', '2026-09-01');
		setNotificationSetting(db, 'tikkie', false);
		expect(await notifyOpenTikkies(db, TODAY)).toBe(0);
		expect(sent).toEqual([]);
		setNotificationSetting(db, 'tikkie', true);
		expect(await notifyOpenTikkies(db, TODAY)).toBe(1);
		expect(sent).toHaveLength(1);
	});
});

describe('categorie op 90%', () => {
	const MONTH = TODAY.slice(0, 7);
	const catId = (name: string) =>
		db.select().from(categories).where(eq(categories.name, name)).get()!.id;

	/** Een bevestigde uitgave (of terugboeking, positief) in een categorie. */
	function spend(categoryName: string, amountCents: number, date = TODAY) {
		const account = db.select().from(accounts).where(eq(accounts.alias, 'sns')).get()!.id;
		return db
			.insert(transactions)
			.values({
				amountCents,
				date,
				counterparty: 'Winkel',
				categoryId: catId(categoryName),
				accountId: account,
				source: 'handmatig',
				status: 'bevestigd'
			})
			.returning()
			.get().id;
	}

	it('meet het vrije deel: zonder limiet of zonder vrij deel niets', () => {
		expect(freeShareUsed({ limitCents: 0, otherCents: 500, freeLimitCents: 0 })).toBeNull();
		expect(freeShareUsed({ limitCents: 85000, otherCents: 0, freeLimitCents: 0 })).toBeNull();
		expect(freeShareUsed({ limitCents: 30000, otherCents: 27000, freeLimitCents: 30000 })).toBe(
			0.9
		);
	});

	it('vanaf 90% een melding, daaronder niet', async () => {
		setBudget(db, MONTH, catId('Boodschappen'), 30000);
		setBudget(db, MONTH, catId('Vervoer'), 10000);
		spend('Boodschappen', -27000);
		spend('Vervoer', -8999);

		const { calls, send } = recorder();
		expect(await notifyBudgetThreshold(db, TODAY, send)).toBe(1);
		expect(calls).toEqual([
			{
				kind: 'budget_90',
				message: {
					key: `${MONTH}:${catId('Boodschappen')}`,
					text: 'Een categorie zit op 90% van de limiet',
					detail: expect.stringMatching(
						/^Boodschappen zit op 90% van de limiet: €\s270,00 van €\s300,00$/
					),
					url: '/budget'
				}
			}
		]);
	});

	it('over de limiet in één keer: zegt dat ook', async () => {
		setBudget(db, MONTH, catId('Boodschappen'), 30000);
		spend('Boodschappen', -36000);
		const { calls, send } = recorder();
		await notifyBudgetThreshold(db, TODAY, send);
		expect(calls[0]!.message.text).toBe('Een categorie zit over de limiet');
		expect(calls[0]!.message.detail).toMatch(/zit op 120% van de limiet/);
	});

	it('geplande vaste lasten tellen niet mee in de 90%', async () => {
		setBudget(db, MONTH, catId('Wonen'), 100000);
		post('Woonstichting', '2026-10-01', 'bevestigd');
		// 900 van 1000 uitgegeven, maar van het vrije deel (150) is maar 50 op
		spend('Wonen', -5000);
		const { calls, send } = recorder();
		expect(await notifyBudgetThreshold(db, TODAY, send)).toBe(0);
		expect(calls).toEqual([]);

		// Met 140 van de 150 wel
		spend('Wonen', -9000);
		expect(await notifyBudgetThreshold(db, TODAY, send)).toBe(1);
	});

	it('één melding per categorie per maand; weer onder 90% en erboven: opnieuw', async () => {
		pushReady();
		setBudget(db, MONTH, catId('Boodschappen'), 30000);
		spend('Boodschappen', -27000);
		expect(await notifyBudgetThreshold(db, TODAY)).toBe(1);
		expect(await notifyBudgetThreshold(db, TODAY)).toBe(0);
		expect(sent).toHaveLength(1);

		// Een terugboeking: weer onder de 90%
		const refund = spend('Boodschappen', 3000);
		expect(await notifyBudgetThreshold(db, TODAY)).toBe(0);
		db.delete(transactions).where(eq(transactions.id, refund)).run();
		expect(await notifyBudgetThreshold(db, TODAY)).toBe(1);
		expect(sent).toHaveLength(2);

		// Een nieuwe maand begint opnieuw
		spend('Boodschappen', -28000, '2026-11-03');
		expect(await notifyBudgetThreshold(db, '2026-11-03')).toBe(1);
		expect(sent).toHaveLength(3);
	});

	it('de schakelaar uit: geen melding', async () => {
		pushReady();
		setBudget(db, MONTH, catId('Boodschappen'), 30000);
		spend('Boodschappen', -29000);
		setNotificationSetting(db, 'budget_90', false);
		expect(await notifyBudgetThreshold(db, TODAY)).toBe(0);
		expect(sent).toEqual([]);
	});
});
