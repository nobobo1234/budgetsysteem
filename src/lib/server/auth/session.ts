import type { Cookies } from '@sveltejs/kit';
import { and, eq, gt, isNull, lt, or, isNotNull } from 'drizzle-orm';
import { config } from '../config.ts';
import type { DB } from '../db/index.ts';
import { sessions } from '../db/schema.ts';
import { randomToken, sha256 } from './crypto.ts';

export const SESSION_DAYS = 30;
/** Gevoelige acties vragen een passkey-bevestiging die niet ouder is dan dit. */
export const REAUTH_MINUTES = 5;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export type Session = typeof sessions.$inferSelect;

export function sessionCookieName(): string {
	// __Host- vereist Secure; alleen lokaal over http valt dat weg
	return config().COOKIE_SECURE ? '__Host-session' : 'session';
}

/**
 * Nieuwe sessie met een sessie-ID van 256 bits. Bij elke login een nieuw ID; in de database
 * staat alleen de hash.
 */
export function createSession(
	db: DB,
	opts: { passkeyId: string | null; deviceName: string; reauth?: boolean }
): { token: string; expiresAt: Date; idHash: string } {
	const token = randomToken(32);
	const idHash = sha256(token);
	const now = new Date();
	const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
	db.insert(sessions)
		.values({
			idHash,
			passkeyId: opts.passkeyId,
			deviceName: opts.deviceName,
			expiresAt: expiresAt.toISOString(),
			lastUsedAt: now.toISOString(),
			reauthAt: opts.reauth ? now.toISOString() : null
		})
		.run();
	return { token, expiresAt, idHash };
}

export function validateSession(db: DB, token: string): Session | null {
	if (token.length < 20 || token.length > 100) return null;
	const now = new Date();
	const session = db
		.select()
		.from(sessions)
		.where(
			and(
				eq(sessions.idHash, sha256(token)),
				isNull(sessions.revokedAt),
				gt(sessions.expiresAt, now.toISOString())
			)
		)
		.get();
	if (!session) return null;
	const last = session.lastUsedAt ? Date.parse(session.lastUsedAt) : 0;
	if (now.getTime() - last > TOUCH_INTERVAL_MS) {
		db.update(sessions)
			.set({ lastUsedAt: now.toISOString() })
			.where(eq(sessions.idHash, session.idHash))
			.run();
	}
	return session;
}

export function revokeSession(db: DB, idHash: string): void {
	db.update(sessions)
		.set({ revokedAt: new Date().toISOString() })
		.where(and(eq(sessions.idHash, idHash), isNull(sessions.revokedAt)))
		.run();
}

export function revokeSessionsForPasskey(db: DB, passkeyId: string): void {
	db.update(sessions)
		.set({ revokedAt: new Date().toISOString() })
		.where(and(eq(sessions.passkeyId, passkeyId), isNull(sessions.revokedAt)))
		.run();
}

export function markReauth(db: DB, idHash: string): void {
	db.update(sessions)
		.set({ reauthAt: new Date().toISOString() })
		.where(eq(sessions.idHash, idHash))
		.run();
}

export function hasRecentReauth(session: Session, now = Date.now()): boolean {
	if (!session.reauthAt) return false;
	return now - Date.parse(session.reauthAt) <= REAUTH_MINUTES * 60 * 1000;
}

/** Verlopen en lang geleden ingetrokken sessies opruimen. */
export function pruneSessions(db: DB): void {
	const now = new Date();
	const old = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
	db.delete(sessions)
		.where(
			or(
				lt(sessions.expiresAt, now.toISOString()),
				and(isNotNull(sessions.revokedAt), lt(sessions.revokedAt, old))
			)
		)
		.run();
}

export function setSessionCookie(cookies: Cookies, token: string, expiresAt: Date): void {
	cookies.set(sessionCookieName(), token, {
		path: '/',
		httpOnly: true,
		secure: config().COOKIE_SECURE,
		sameSite: 'lax',
		expires: expiresAt
	});
}

export function clearSessionCookie(cookies: Cookies): void {
	cookies.delete(sessionCookieName(), { path: '/', secure: config().COOKIE_SECURE });
}

/** Grove apparaatnaam uit de user-agent, alleen voor het overzicht van actieve apparaten. */
export function deviceNameFrom(userAgent: string | null): string {
	const ua = userAgent ?? '';
	const os = /iPhone/.test(ua)
		? 'iPhone'
		: /iPad/.test(ua)
			? 'iPad'
			: /Android/.test(ua)
				? 'Android'
				: /Mac OS X/.test(ua)
					? 'Mac'
					: /Windows/.test(ua)
						? 'Windows'
						: /Linux/.test(ua)
							? 'Linux'
							: 'Onbekend apparaat';
	const browser = /Edg\//.test(ua)
		? 'Edge'
		: /Firefox\//.test(ua)
			? 'Firefox'
			: /Chrome\//.test(ua)
				? 'Chrome'
				: /Safari\//.test(ua)
					? 'Safari'
					: '';
	return browser ? `${os} · ${browser}` : os;
}
