import { and, asc, count, eq, gt, isNull, notInArray, or } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/index.ts';
import { pushSubscriptions, sessions } from '../db/schema.ts';
import { isAllowedEndpoint } from './webpush.ts';

/** Ruim genoeg voor één persoon met een paar apparaten; meer is geen normaal gebruik. */
export const MAX_SUBSCRIPTIONS = 10;

const b64url = (min: number, max: number) =>
	z
		.string()
		.min(min)
		.max(max)
		.regex(/^[A-Za-z0-9_-]+=*$/);

/** `PushSubscription.toJSON()` van de browser; alleen push-diensten van de grote browsers. */
export const subscriptionSchema = z
	.object({
		endpoint: z.string().max(1024).refine(isAllowedEndpoint, 'Onbekende push-dienst'),
		expirationTime: z.number().nullable().optional(),
		keys: z
			.object({
				// 65 bytes = 87 tekens base64url (zonder opvulling)
				p256dh: b64url(87, 88),
				// 16 bytes = 22 tekens
				auth: b64url(22, 24)
			})
			.strict()
	})
	.strict();

export const unsubscribeSchema = z.object({ endpoint: z.string().max(1024) }).strict();

export type SaveResult = 'opgeslagen' | 'te_veel';

/** Slaat het abonnement van dit apparaat op, of werkt het bij als het endpoint al bekend is. */
export function saveSubscription(
	db: DB,
	sub: z.infer<typeof subscriptionSchema>,
	deviceName: string,
	sessionIdHash: string
): SaveResult {
	const p256dh = sub.keys.p256dh.replace(/=+$/, '');
	const auth = sub.keys.auth.replace(/=+$/, '');
	return db.transaction((tx) => {
		const existing = tx
			.select({ id: pushSubscriptions.id })
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.endpoint, sub.endpoint))
			.get();
		if (existing) {
			tx.update(pushSubscriptions)
				.set({ p256dh, auth, deviceName, sessionIdHash })
				.where(eq(pushSubscriptions.id, existing.id))
				.run();
			return 'opgeslagen';
		}
		const total = tx.select({ n: count() }).from(pushSubscriptions).get()!.n;
		if (total >= MAX_SUBSCRIPTIONS) return 'te_veel';
		tx.insert(pushSubscriptions)
			.values({ endpoint: sub.endpoint, p256dh, auth, deviceName, sessionIdHash })
			.run();
		return 'opgeslagen';
	});
}

/** Abonnementen zonder geldige sessie (uitgelogd, ingetrokken of verlopen) weg. */
export function pruneSubscriptions(db: DB, now = new Date()): void {
	const valid = db
		.select({ idHash: sessions.idHash })
		.from(sessions)
		.where(and(isNull(sessions.revokedAt), gt(sessions.expiresAt, now.toISOString())));
	db.delete(pushSubscriptions)
		.where(
			or(
				isNull(pushSubscriptions.sessionIdHash),
				notInArray(pushSubscriptions.sessionIdHash, valid)
			)
		)
		.run();
}

export function removeSubscription(db: DB, endpoint: string): void {
	db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run();
}

export function removeSubscriptionById(db: DB, id: string): void {
	db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)).run();
}

/** Apparaten met meldingen, zonder endpoint of sleutels. */
export function listDevices(db: DB) {
	pruneSubscriptions(db);
	return db
		.select({
			id: pushSubscriptions.id,
			deviceName: pushSubscriptions.deviceName,
			createdAt: pushSubscriptions.createdAt,
			lastSentAt: pushSubscriptions.lastSentAt
		})
		.from(pushSubscriptions)
		.orderBy(asc(pushSubscriptions.createdAt))
		.all();
}

/** ID van het abonnement bij dit endpoint, om "dit apparaat" te herkennen. */
export function subscriptionIdFor(db: DB, endpoint: string): string | null {
	return (
		db
			.select({ id: pushSubscriptions.id })
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.endpoint, endpoint))
			.get()?.id ?? null
	);
}
