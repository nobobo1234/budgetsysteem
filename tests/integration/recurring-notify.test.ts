// Vaste lasten → pushmeldingen. Een nagebootste push-dienst: nooit echte netwerkaanroepen, en
// de VAPID- en apparaatsleutels worden per test gemaakt.
import { createECDH, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../../src/lib/server/auth/session.ts';
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
