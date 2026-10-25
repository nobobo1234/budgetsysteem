// Pushmeldingen met een nagebootste push-dienst: nooit echte netwerkaanroepen. De VAPID- en
// apparaatsleutels worden per test gemaakt; er staan geen echte sleutels in de repo.
import { createDecipheriv, createECDH, hkdfSync, randomBytes, type ECDH } from 'node:crypto';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DELETE as unsubscribe,
	POST as subscribe
} from '../../src/routes/(app)/api/push/subscription/+server.ts';
import { actions } from '../../src/routes/(app)/instellingen/meldingen/+page.server.ts';
import { createSession, revokeSession, type Session } from '../../src/lib/server/auth/session.ts';
import { resetConfig } from '../../src/lib/server/config.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import { notificationsSent, pushSubscriptions, sessions } from '../../src/lib/server/db/schema.ts';
import {
	getNotificationSettings,
	notify,
	pruneNotifications,
	releaseNotification,
	setNotificationSetting,
	usePushTransport
} from '../../src/lib/server/push/notify.ts';
import { MAX_SUBSCRIPTIONS } from '../../src/lib/server/push/subscriptions.ts';
import type { PushRequest } from '../../src/lib/server/push/webpush.ts';
import { alertNewErrors, checkAlerts } from '../../src/lib/server/telemetry/alerts.ts';
import type { TelemetryDB } from '../../src/lib/server/telemetry/db.ts';
import { healthPaths } from '../../src/lib/server/telemetry/health.ts';
import { errors } from '../../src/lib/server/telemetry/schema.ts';
import { fakeEvent, tempDatabase, tempTelemetry } from './helpers.ts';

interface Device {
	ecdh: ECDH;
	auth: Buffer;
	endpoint: string;
}

function device(host = 'fcm.googleapis.com'): Device {
	const ecdh = createECDH('prime256v1');
	ecdh.generateKeys();
	return {
		ecdh,
		auth: randomBytes(16),
		endpoint: `https://${host}/fcm/send/${randomBytes(12).toString('base64url')}`
	};
}

function subscriptionJson(d: Device) {
	return {
		endpoint: d.endpoint,
		expirationTime: null,
		keys: {
			p256dh: d.ecdh.getPublicKey().toString('base64url'),
			auth: d.auth.toString('base64url')
		}
	};
}

/** Ontsleutelt wat de push-dienst krijgt, zoals het apparaat dat doet (RFC 8291). */
function decrypt(
	d: Device,
	body: Uint8Array
): { title: string; body: string; url: string; tag: string } {
	const buf = Buffer.from(body);
	const salt = buf.subarray(0, 16);
	const idLength = buf.readUInt8(20);
	const asPublic = buf.subarray(21, 21 + idLength);
	const data = buf.subarray(21 + idLength);
	const secret = d.ecdh.computeSecret(asPublic);
	const info = Buffer.concat([Buffer.from('WebPush: info\0'), d.ecdh.getPublicKey(), asPublic]);
	const ikm = Buffer.from(hkdfSync('sha256', secret, d.auth, info, 32));
	const cek = Buffer.from(
		hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
	);
	const nonce = Buffer.from(
		hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
	);
	const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
	decipher.setAuthTag(data.subarray(data.length - 16));
	const plain = Buffer.concat([
		decipher.update(data.subarray(0, data.length - 16)),
		decipher.final()
	]);
	expect(plain.at(-1)).toBe(0x02);
	return JSON.parse(plain.subarray(0, -1).toString('utf8'));
}

let db: DB;
let telemetry: TelemetryDB;
let telemetryDir: string;
let session: Session;
let cleanups: (() => void)[];
let sent: PushRequest[];
let respond: (request: PushRequest) => number | Promise<number>;
const ENV_KEYS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] as const;

function setVapid(on: boolean) {
	if (on) {
		const vapid = createECDH('prime256v1');
		vapid.generateKeys();
		process.env.VAPID_PUBLIC_KEY = vapid.getPublicKey().toString('base64url');
		// Altijd 32 bytes: getPrivateKey laat een voorloopnul weg
		const d = vapid.getPrivateKey();
		process.env.VAPID_PRIVATE_KEY = Buffer.concat([Buffer.alloc(32 - d.length), d]).toString(
			'base64url'
		);
		process.env.VAPID_SUBJECT = 'https://budget.example';
	} else {
		for (const k of ENV_KEYS) delete process.env[k];
	}
	resetConfig();
}

beforeEach(() => {
	const main = tempDatabase();
	const t = tempTelemetry();
	db = main.db;
	telemetry = t.telemetry;
	telemetryDir = t.dir;
	cleanups = [main.cleanup, t.cleanup];
	const { idHash } = createSession(db, { passkeyId: null, deviceName: 'test' });
	session = db.select().from(sessions).where(eq(sessions.idHash, idHash)).get()!;
	setVapid(true);
	sent = [];
	respond = () => 201;
	usePushTransport(async (request) => {
		sent.push(request);
		return respond(request);
	});
});

afterEach(() => {
	usePushTransport(undefined);
	setVapid(false);
	cleanups.forEach((c) => c());
});

async function status(promise: Promise<unknown> | unknown): Promise<number> {
	try {
		const result = await promise;
		if (result instanceof Response) return result.status;
		if (result && typeof result === 'object' && 'status' in result)
			return (result as { status: number }).status;
		return 200;
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e) return (e as { status: number }).status;
		throw e;
	}
}

const subscriptionEvent = (method: 'POST' | 'DELETE', body: unknown) =>
	fakeEvent({
		path: '/api/push/subscription',
		routeId: '/(app)/api/push/subscription',
		method,
		body,
		session,
		headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) Safari' }
	}) as never;

function formEvent(action: string, fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	const event = fakeEvent({
		path: `/instellingen/meldingen?/${action}`,
		routeId: '/(app)/instellingen/meldingen',
		method: 'POST',
		session
	});
	return {
		...event,
		request: new Request(event.url, { method: 'POST', body, headers: { origin: event.url.origin } })
	} as never;
}

async function register(d = device()): Promise<Device> {
	expect(await status(subscribe(subscriptionEvent('POST', subscriptionJson(d))))).toBe(201);
	return d;
}

describe('abonnement aan- en afmelden', () => {
	it('slaat het abonnement op met de naam van het apparaat', async () => {
		const d = await register();
		const rows = db.select().from(pushSubscriptions).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.endpoint).toBe(d.endpoint);
		expect(rows[0]!.deviceName).not.toBe('');
	});

	it('hetzelfde apparaat opnieuw geeft geen tweede abonnement', async () => {
		const d = await register();
		await register(d);
		expect(db.select().from(pushSubscriptions).all()).toHaveLength(1);
	});

	it('weigert een onbekende push-dienst (geen SSRF) en ongeldige sleutels', async () => {
		for (const host of ['localhost', '169.254.169.254', 'push.example.net']) {
			const bad = subscriptionJson(device(host));
			expect(await status(subscribe(subscriptionEvent('POST', bad)))).toBe(400);
		}
		const d = subscriptionJson(device());
		expect(
			await status(subscribe(subscriptionEvent('POST', { ...d, keys: { ...d.keys, auth: 'x' } })))
		).toBe(400);
		expect(await status(subscribe(subscriptionEvent('POST', { ...d, extra: 1 })))).toBe(400);
		expect(db.select().from(pushSubscriptions).all()).toHaveLength(0);
	});

	it(`hooguit ${MAX_SUBSCRIPTIONS} apparaten`, async () => {
		for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) await register();
		expect(await status(subscribe(subscriptionEvent('POST', subscriptionJson(device()))))).toBe(
			409
		);
	});

	it('afmelden verwijdert het abonnement', async () => {
		const d = await register();
		expect(await status(unsubscribe(subscriptionEvent('DELETE', { endpoint: d.endpoint })))).toBe(
			200
		);
		expect(db.select().from(pushSubscriptions).all()).toHaveLength(0);
	});
});

describe('notify', () => {
	it('stuurt naar alle apparaten, versleuteld en zonder bedragen op het vergrendelscherm', async () => {
		const a = await register();
		const b = await register(device('web.push.apple.com'));
		const result = await notify(
			'vaste_last',
			{
				key: 'r1:2026-11-01',
				text: 'Een vaste last wacht',
				detail: 'Vattenfall: € 84,20',
				url: '/vaste-lasten'
			},
			db
		);
		expect(result).toEqual({ status: 'verstuurd', sent: 2 });
		expect(sent.map((r) => r.url).sort()).toEqual([a.endpoint, b.endpoint].sort());
		const forA = sent.find((r) => r.url === a.endpoint)!;
		expect(forA.headers.authorization).toMatch(/^vapid t=.+, k=/);
		expect(Buffer.from(forA.body).toString('utf8')).not.toContain('vaste last');
		const payload = decrypt(a, forA.body);
		expect(payload).toMatchObject({
			title: 'Vaste lasten',
			body: 'Een vaste last wacht',
			url: '/vaste-lasten'
		});
		expect(JSON.stringify(payload)).not.toContain('84,20');
		expect(JSON.stringify(payload)).not.toContain('Vattenfall');
	});

	it('met bedragen en namen als dat aan staat', async () => {
		const a = await register();
		setNotificationSetting(db, 'vergrendelscherm', true);
		await notify('vaste_last', { text: 'Een vaste last wacht', detail: 'Vattenfall: € 84,20' }, db);
		expect(decrypt(a, sent[0]!.body).body).toBe('Vattenfall: € 84,20');
	});

	it('respecteert de schakelaar per soort', async () => {
		await register();
		setNotificationSetting(db, 'bon', false);
		expect(await notify('bon', { text: 'Bon gelezen' }, db)).toEqual({ status: 'uit', sent: 0 });
		expect(await notify('maand', { text: 'Maand voorbij' }, db)).toMatchObject({
			status: 'verstuurd'
		});
		expect(sent).toHaveLength(1);
	});

	it('beveiliging is niet uit te zetten', async () => {
		await register();
		expect(setNotificationSetting(db, 'beveiliging', false)).toBe(false);
		expect(getNotificationSettings(db).beveiliging).toBe(true);
		expect(await notify('beveiliging', { text: 'Passkey toegevoegd' }, db)).toMatchObject({
			status: 'verstuurd'
		});
		expect(sent[0]!.headers.urgency).toBe('high');
	});

	it('ontdubbelt op soort en sleutel, tot de sleutel is vrijgegeven', async () => {
		await register();
		const msg = { key: 'schijf', text: 'Schijf vol' };
		expect((await notify('schijf', msg, db)).status).toBe('verstuurd');
		expect((await notify('schijf', msg, db)).status).toBe('dubbel');
		// Andere soort met dezelfde sleutel is een andere melding
		expect((await notify('backup', { key: 'schijf', text: 'x' }, db)).status).toBe('verstuurd');
		releaseNotification('schijf', 'schijf', db);
		expect((await notify('schijf', msg, db)).status).toBe('verstuurd');
		expect(sent).toHaveLength(3);
	});

	it('twee gelijktijdige meldingen met dezelfde sleutel gaan één keer uit', async () => {
		await register();
		const msg = { key: 'r1', text: 'x' };
		const results = await Promise.all([notify('tikkie', msg, db), notify('tikkie', msg, db)]);
		expect(results.map((r) => r.status).sort()).toEqual(['dubbel', 'verstuurd']);
		expect(sent).toHaveLength(1);
	});

	it('kwam hij nergens aan, dan gaat de volgende poging wel uit', async () => {
		await register();
		respond = () => 503;
		expect(await notify('fout', { key: 'f1', text: 'x' }, db)).toEqual({
			status: 'mislukt',
			sent: 0
		});
		respond = () => 201;
		expect((await notify('fout', { key: 'f1', text: 'x' }, db)).status).toBe('verstuurd');
	});

	it('ruimt verlopen abonnementen op (404 en 410) en houdt de rest', async () => {
		const gone = await register();
		const missing = await register();
		const ok = await register();
		respond = (r) => (r.url === gone.endpoint ? 410 : r.url === missing.endpoint ? 404 : 201);
		expect(await notify('maand', { text: 'x' }, db)).toEqual({ status: 'verstuurd', sent: 1 });
		const left = db.select().from(pushSubscriptions).all();
		expect(left.map((s) => s.endpoint)).toEqual([ok.endpoint]);
		expect(left[0]!.lastSentAt).not.toBeNull();
	});

	it('gooit nooit: een netwerkfout geeft "mislukt"', async () => {
		await register();
		respond = () => {
			throw new TypeError('fetch failed');
		};
		await expect(notify('maand', { key: 'm', text: 'x' }, db)).resolves.toEqual({
			status: 'mislukt',
			sent: 0
		});
		expect(db.select().from(notificationsSent).all()).toHaveLength(0);
	});

	it('een apparaat met een ingetrokken of verlopen sessie krijgt niets meer', async () => {
		const kept = await register();
		const lost = await register();
		// Het tweede apparaat hoort bij een andere sessie, die daarna wordt ingetrokken
		const other = createSession(db, { passkeyId: null, deviceName: 'kwijt' });
		db.update(pushSubscriptions)
			.set({ sessionIdHash: other.idHash })
			.where(eq(pushSubscriptions.endpoint, lost.endpoint))
			.run();
		revokeSession(db, other.idHash);
		expect(await notify('maand', { text: 'x' }, db)).toEqual({ status: 'verstuurd', sent: 1 });
		expect(sent.map((r) => r.url)).toEqual([kept.endpoint]);
		expect(db.select().from(pushSubscriptions).all()).toHaveLength(1);

		// Verlopen sessie: ook weg
		db.update(sessions)
			.set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
			.where(eq(sessions.idHash, session.idHash))
			.run();
		expect((await notify('maand', { text: 'x' }, db)).status).toBe('geen_apparaten');
		expect(db.select().from(pushSubscriptions).all()).toHaveLength(0);
	});

	it('opnieuw doorgeven koppelt het apparaat aan de nieuwe sessie', async () => {
		const d = await register();
		const next = createSession(db, { passkeyId: null, deviceName: 'test' });
		revokeSession(db, session.idHash);
		session = db.select().from(sessions).where(eq(sessions.idHash, next.idHash)).get()!;
		await register(d);
		expect((await notify('maand', { text: 'x' }, db)).sent).toBe(1);
	});

	it('zonder sleutels of apparaten gebeurt er niets', async () => {
		expect((await notify('maand', { key: 'm', text: 'x' }, db)).status).toBe('geen_apparaten');
		await register();
		setVapid(false);
		expect((await notify('maand', { key: 'm', text: 'x' }, db)).status).toBe('geen_sleutels');
		expect(sent).toHaveLength(0);
		expect(db.select().from(notificationsSent).all()).toHaveLength(0);
	});

	it('alleen een pad binnen de app als link', async () => {
		const a = await register();
		for (const url of ['https://evil.example', '//evil.example', 'javascript:alert(1)']) {
			await notify('maand', { text: 'x', url }, db);
			expect(decrypt(a, sent.at(-1)!.body).url).toBe('/');
		}
	});

	it('ruimt ontdubbel-sleutels na 90 dagen op', async () => {
		await register();
		await notify('maand', { key: '2026-09', text: 'x' }, db);
		pruneNotifications(db, new Date(Date.now() + 91 * 86_400_000));
		expect(db.select().from(notificationsSent).all()).toHaveLength(0);
	});
});

describe('instellingen (form actions)', () => {
	it('zet een schakelaar uit en weer aan', async () => {
		await actions.toggle!(formEvent('toggle', { key: 'tikkie' }));
		expect(getNotificationSettings(db).tikkie).toBe(false);
		await actions.toggle!(formEvent('toggle', { key: 'tikkie', enabled: 'on' }));
		expect(getNotificationSettings(db).tikkie).toBe(true);
	});

	it('weigert beveiliging en onbekende sleutels', async () => {
		expect(await status(actions.toggle!(formEvent('toggle', { key: 'beveiliging' })))).toBe(400);
		expect(await status(actions.toggle!(formEvent('toggle', { key: 'bestaat_niet' })))).toBe(400);
		expect(getNotificationSettings(db).beveiliging).toBe(true);
	});

	it('testmelding: alleen met een apparaat, en los van de schakelaars', async () => {
		expect(await status(actions.test!(formEvent('test', {})))).toBe(400);
		await register();
		for (const kind of [
			'vaste_last',
			'bon',
			'budget_90',
			'tikkie',
			'maand',
			'fout',
			'backup',
			'schijf'
		])
			setNotificationSetting(db, kind, false);
		expect(await actions.test!(formEvent('test', {}))).toEqual({ tested: 1 });
		expect(sent).toHaveLength(1);
	});

	it('een apparaat verwijderen', async () => {
		await register();
		const id = db.select().from(pushSubscriptions).get()!.id;
		await actions.removeDevice!(formEvent('removeDevice', { id }));
		expect(db.select().from(pushSubscriptions).all()).toHaveLength(0);
	});
});

// TER REVIEW (Noah): beveiligingsmeldingen bij passkey- en herstelgebeurtenissen.
describe('beveiligingsmeldingen', () => {
	it('een nieuwe passkey of inloggen met de herstelcode geeft een melding', async () => {
		const a = await register();
		const { securityEvent } = await import('../../src/lib/server/audit.ts');
		securityEvent(db, 'passkey_toegevoegd', 'cred-1');
		securityEvent(db, 'herstelcode_gebruikt');
		await vi.waitFor(() => expect(sent).toHaveLength(2));
		const bodies = sent.map((r) => decrypt(a, r.body));
		expect(bodies.every((p) => p.title === 'Beveiliging')).toBe(true);
		expect(bodies[0]!.body).toContain('passkey');
		expect(bodies[1]!.body).toContain('herstelcode');
	});

	it('gewone gebeurtenissen geven geen melding', async () => {
		await register();
		const { securityEvent } = await import('../../src/lib/server/audit.ts');
		securityEvent(db, 'login');
		securityEvent(db, 'login_mislukt');
		await new Promise((r) => setTimeout(r, 20));
		expect(sent).toHaveLength(0);
	});
});

describe('telemetrie-meldingen', () => {
	function paths() {
		const dataDir = join(telemetryDir, 'data');
		mkdirSync(dataDir, { recursive: true });
		const databasePath = join(dataDir, 'budget.db');
		writeFileSync(databasePath, '');
		return { databasePath, paths: healthPaths(databasePath) };
	}

	const deps = (p: ReturnType<typeof paths>, now = Date.now()) => ({
		db,
		telemetry,
		paths: p.paths,
		databasePath: p.databasePath,
		production: true,
		now
	});

	function touch(path: string, ms: number) {
		writeFileSync(path, '');
		utimesSync(path, ms / 1000, ms / 1000);
	}

	it('te oude restic-backup: één melding tot het opgelost is', async () => {
		const a = await register();
		const p = paths();
		const now = Date.now();
		mkdirSync(p.paths.litestreamDir, { recursive: true });
		touch(join(p.paths.litestreamDir, 'x.ltx'), now);
		touch(p.paths.resticMarker, now - 30 * 3_600_000);

		await checkAlerts(deps(p, now));
		await checkAlerts(deps(p, now));
		const backups = sent.map((r) => decrypt(a, r.body)).filter((m) => m.title === 'Backup');
		expect(backups).toHaveLength(1);
		expect(backups[0]!.body).toContain('restic');

		// Opgelost, daarna weer te oud: nieuwe melding
		touch(p.paths.resticMarker, now);
		await checkAlerts(deps(p, now));
		touch(p.paths.resticMarker, now - 30 * 3_600_000);
		await checkAlerts(deps(p, now));
		expect(sent.map((r) => decrypt(a, r.body)).filter((m) => m.title === 'Backup')).toHaveLength(2);
	});

	it('een nieuw soort fout: één melding per vingerafdruk, hooguit drie per ronde', async () => {
		const a = await register();
		const now = Date.now();
		const at = new Date(now - 60_000).toISOString();
		const row = (fp: string) => ({
			id: crypto.randomUUID(),
			at,
			source: 'verzoek' as const,
			name: 'TypeError',
			route: '/(app)/budget',
			method: 'POST',
			fingerprint: fp
		});
		telemetry
			.insert(errors)
			.values([row('aaaa'), row('aaaa'), row('bbbb')])
			.run();
		await alertNewErrors(db, telemetry, now);
		await alertNewErrors(db, telemetry, now);
		const bodies = sent.map((r) => decrypt(a, r.body).body);
		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toBe('Nieuw soort fout: TypeError op /budget.');

		telemetry
			.insert(errors)
			.values(['c', 'd', 'e', 'f'].map((f) => row(f.repeat(4))))
			.run();
		await alertNewErrors(db, telemetry, now);
		expect(sent).toHaveLength(5);
		await alertNewErrors(db, telemetry, now);
		expect(sent).toHaveLength(6);
	});

	it('de schakelaar voor fouten zet ze uit', async () => {
		await register();
		setNotificationSetting(db, 'fout', false);
		telemetry
			.insert(errors)
			.values({ id: crypto.randomUUID(), source: 'proces', name: 'Error', fingerprint: 'ffff' })
			.run();
		await alertNewErrors(db, telemetry);
		expect(sent).toHaveLength(0);
	});
});
