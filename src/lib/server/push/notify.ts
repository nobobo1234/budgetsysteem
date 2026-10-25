import { and, eq, lt } from 'drizzle-orm';
import {
	DEFAULT_SETTINGS,
	NOTIFICATION_KINDS,
	isSwitchableSetting,
	kindEnabled,
	notificationBody,
	type NotificationKind,
	type NotificationSettingKey,
	type NotificationSettings,
	type NotificationText
} from '../../notifications.ts';
import { sha256 } from '../auth/crypto.ts';
import { config } from '../config.ts';
import { db as defaultDb, type DB } from '../db/index.ts';
import { notificationSettings, notificationsSent, pushSubscriptions } from '../db/schema.ts';
import { log } from '../log.ts';
import { pruneSubscriptions } from './subscriptions.ts';
import { buildPushRequest, type PushRequest, type VapidKeys } from './webpush.ts';

/*
 * Pushmeldingen versturen. Voor andere onderdelen is dit de hele API:
 *
 *   await notify('vaste_last', {
 *     key: `${recurringId}:${date}`,          // ontdubbelen: deze sleutel gaat maar één keer uit
 *     text: 'Een vaste last wacht op bevestiging',     // zonder bedragen of namen
 *     detail: 'Vattenfall: € 84,20 wacht op bevestiging', // alleen als "bedragen en namen" aan staat
 *     url: '/vaste-lasten'                    // waar een tik op de melding naartoe gaat
 *   });
 *
 *   releaseNotification('schijf', 'schijf');  // opgelost: de volgende keer mag hij weer
 *
 * `notify` gooit nooit en wacht hooguit op de push-diensten; roep hem gerust aan zonder
 * `await` (met `void`). Hij respecteert de schakelaar per soort en de instelling voor het
 * vergrendelscherm, ontdubbelt op soort + sleutel en ruimt abonnementen op die de push-dienst
 * niet meer kent. Zet nooit IBANs, omschrijvingen of andere bankdata in `text` of `detail`.
 */

export interface NotifyMessage extends NotificationText {
	/** Sleutel om te ontdubbelen, bijvoorbeeld een ID; zonder sleutel gaat elke aanroep uit. */
	key?: string;
	/** Pad in de app (begint met `/`) dat opent bij een tik; standaard het startscherm. */
	url?: string;
}

export type NotifyStatus =
	'verstuurd' | 'uit' | 'dubbel' | 'geen_sleutels' | 'geen_apparaten' | 'mislukt';

export interface NotifyResult {
	status: NotifyStatus;
	/** Aantal apparaten dat de melding heeft aangenomen. */
	sent: number;
}

/** Stuurt één verzoek naar een push-dienst en geeft de HTTP-status terug. */
export type PushTransport = (request: PushRequest) => Promise<number>;

const SEND_TIMEOUT_MS = 10_000;
const TTL_SECONDS = 24 * 3600;
const MAX_TITLE = 60;
const MAX_BODY = 240;
export const SENT_RETENTION_DAYS = 90;

const fetchTransport: PushTransport = async (request) => {
	const response = await fetch(request.url, {
		method: 'POST',
		headers: request.headers,
		body: new Uint8Array(request.body),
		signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
		credentials: 'omit',
		redirect: 'error'
	});
	await response.body?.cancel();
	return response.status;
};

let transport: PushTransport = fetchTransport;

/** Alleen voor tests: nooit echte netwerkaanroepen. `undefined` zet de standaard terug. */
export function usePushTransport(next: PushTransport | undefined): void {
	transport = next ?? fetchTransport;
}

/** VAPID-sleutels uit de omgeving, of `null` als pushmeldingen niet zijn ingesteld. */
export function vapidKeys(): VapidKeys | null {
	const c = config();
	if (!c.VAPID_PUBLIC_KEY || !c.VAPID_PRIVATE_KEY) return null;
	return {
		publicKey: c.VAPID_PUBLIC_KEY,
		privateKey: c.VAPID_PRIVATE_KEY,
		subject: c.VAPID_SUBJECT ?? c.origin
	};
}

export function getNotificationSettings(db: DB): NotificationSettings {
	const settings = { ...DEFAULT_SETTINGS };
	for (const row of db.select().from(notificationSettings).all()) {
		if (Object.hasOwn(settings, row.key)) settings[row.key as NotificationSettingKey] = row.enabled;
	}
	return settings;
}

/** Zet één schakelaar. Beveiligingsmeldingen en onbekende sleutels worden geweigerd. */
export function setNotificationSetting(db: DB, key: string, enabled: boolean): boolean {
	if (!isSwitchableSetting(key)) return false;
	db.insert(notificationSettings)
		.values({ key, enabled })
		.onConflictDoUpdate({ target: notificationSettings.key, set: { enabled } })
		.run();
	return true;
}

/** Gooit de ontdubbel-sleutel weg, zodat een volgende melding weer uitgaat. */
export function releaseNotification(kind: NotificationKind, key: string, db: DB = defaultDb()) {
	db.delete(notificationsSent)
		.where(and(eq(notificationsSent.kind, kind), eq(notificationsSent.key, key)))
		.run();
}

/** Of deze sleutel al verstuurd is (en nog niet vrijgegeven). */
export function alreadySent(db: DB, kind: NotificationKind, key: string): boolean {
	return !!db
		.select({ kind: notificationsSent.kind })
		.from(notificationsSent)
		.where(and(eq(notificationsSent.kind, kind), eq(notificationsSent.key, key)))
		.get();
}

/** Legt sleutels vast als verstuurd, bijvoorbeeld omdat ze meegingen in één gebundelde melding. */
export function markSent(db: DB, kind: NotificationKind, keys: readonly string[]): void {
	if (keys.length === 0) return;
	db.insert(notificationsSent)
		.values(keys.map((key) => ({ kind, key })))
		.onConflictDoNothing()
		.run();
}

/** Bewaartermijn van de ontdubbel-sleutels. */
export function pruneNotifications(db: DB, now = new Date()): void {
	const cutoff = new Date(now.getTime() - SENT_RETENTION_DAYS * 86_400_000).toISOString();
	db.delete(notificationsSent).where(lt(notificationsSent.sentAt, cutoff)).run();
}

function safeUrl(url: string | undefined): string {
	// Alleen een pad binnen de app; geen `//host` of volledige URL
	return url && /^\/(?!\/)[^\s\\]*$/.test(url) ? url : '/';
}

function clip(text: string, max: number): string {
	const clean = text.replace(/\s+/g, ' ').trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

interface Payload {
	title: string;
	body: string;
	url: string;
	tag: string;
}

/** Naar alle apparaten. Verlopen abonnementen (404/410) worden opgeruimd. */
async function deliver(
	db: DB,
	keys: VapidKeys,
	payload: Payload,
	urgency: 'normal' | 'high'
): Promise<number> {
	pruneSubscriptions(db);
	const subscriptions = db.select().from(pushSubscriptions).all();
	const body = JSON.stringify(payload);
	const results = await Promise.all(
		subscriptions.map(async (sub) => {
			try {
				const status = await transport(
					buildPushRequest(sub, body, keys, {
						ttlSeconds: TTL_SECONDS,
						urgency,
						topic: payload.tag
					})
				);
				if (status >= 200 && status < 300) {
					db.update(pushSubscriptions)
						.set({ lastSentAt: new Date().toISOString() })
						.where(eq(pushSubscriptions.id, sub.id))
						.run();
					return true;
				}
				if (status === 404 || status === 410) {
					db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id)).run();
					log.info({ subscription: sub.id, status }, 'push-abonnement verlopen, verwijderd');
				} else {
					log.warn({ subscription: sub.id, status }, 'push geweigerd');
				}
			} catch (e) {
				log.warn(
					{ subscription: sub.id, err: { name: e instanceof Error ? e.name : 'Onbekend' } },
					'push mislukt'
				);
			}
			return false;
		})
	);
	return results.filter(Boolean).length;
}

/** Stuurt een pushmelding naar alle apparaten. Zie de uitleg bovenaan dit bestand. */
export async function notify(
	kind: NotificationKind,
	message: NotifyMessage,
	db: DB = defaultDb()
): Promise<NotifyResult> {
	let reserved = false;
	try {
		const settings = getNotificationSettings(db);
		if (!kindEnabled(settings, kind)) return { status: 'uit', sent: 0 };
		const keys = vapidKeys();
		if (!keys) return { status: 'geen_sleutels', sent: 0 };
		pruneSubscriptions(db);
		const hasDevice = db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).get();
		if (!hasDevice) return { status: 'geen_apparaten', sent: 0 };

		if (message.key !== undefined) {
			// Eerst vastleggen, dan versturen: twee gelijktijdige aanroepen sturen zo niet dubbel
			const inserted = db
				.insert(notificationsSent)
				.values({ kind, key: message.key })
				.onConflictDoNothing()
				.run();
			if (inserted.changes === 0) return { status: 'dubbel', sent: 0 };
			reserved = true;
		}

		const info = NOTIFICATION_KINDS[kind];
		const sent = await deliver(
			db,
			keys,
			{
				title: clip(info.title, MAX_TITLE),
				body: clip(notificationBody(settings, message), MAX_BODY),
				url: safeUrl(message.url),
				// Zelfde soort en sleutel vervangt de melding op het apparaat
				tag: message.key === undefined ? kind : `${kind}-${sha256(message.key).slice(0, 16)}`
			},
			kind === 'beveiliging' ? 'high' : 'normal'
		);
		// Niemand bereikt: sleutel weer vrijgeven, zodat een volgende poging wel uitgaat
		if (sent === 0 && reserved) releaseNotification(kind, message.key!, db);
		return { status: sent > 0 ? 'verstuurd' : 'mislukt', sent };
	} catch (e) {
		if (reserved) {
			try {
				releaseNotification(kind, message.key!, db);
			} catch {
				// database weg; dan valt er niets vrij te geven
			}
		}
		log.warn({ kind, err: { name: e instanceof Error ? e.name : 'Onbekend' } }, 'melding mislukt');
		return { status: 'mislukt', sent: 0 };
	}
}

/** Testmelding vanuit de instellingen: los van schakelaars en ontdubbelen. */
export async function sendTestNotification(db: DB = defaultDb()): Promise<NotifyResult> {
	const keys = vapidKeys();
	if (!keys) return { status: 'geen_sleutels', sent: 0 };
	const sent = await deliver(
		db,
		keys,
		{
			title: 'Budget',
			body: 'Meldingen werken op dit apparaat.',
			url: '/instellingen/meldingen',
			tag: 'test'
		},
		'normal'
	);
	return { status: sent > 0 ? 'verstuurd' : 'mislukt', sent };
}
