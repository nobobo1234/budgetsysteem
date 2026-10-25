import { and, desc, eq, isNull } from 'drizzle-orm';
import { securityEvent } from '../audit.ts';
import { randomToken, sha256 } from '../auth/crypto.ts';
import type { DB } from '../db/index.ts';
import { uploadTokens } from '../db/schema.ts';
import { RateLimiter } from '../ratelimit.ts';

// Upload-tokens voor het deelmenu (spec: Uploaden via het deelmenu). 32 bytes uit een
// cryptografische bron, één keer getoond, in de database alleen de SHA-256. Een token mag
// alleen `POST /api/ingest` (zie hooks.server.ts) en maximaal 30 uploads per uur; daarboven
// is hij een uur geblokkeerd en krijg je een pushmelding.

export type UploadToken = typeof uploadTokens.$inferSelect;

/** Herkenbaar voorvoegsel, zodat secret-scanners een gelekt token vinden. */
const PREFIX = 'bon_';
const TOKEN_PATTERN = /^bon_[A-Za-z0-9_-]{43}$/;
export const MAX_UPLOADS_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;
export const MAX_ACTIVE_TOKENS = 10;

/** Telt per token; een herstart begint opnieuw, maar een blokkade staat in de database. */
const uploadLimiter = new RateLimiter(MAX_UPLOADS_PER_HOUR, HOUR_MS);

/** Alleen voor tests. */
export function resetUploadLimits(): void {
	uploadLimiter.clear();
}

export function createUploadToken(db: DB, name: string): { id: string; token: string } {
	const token = PREFIX + randomToken(32);
	const id = db
		.insert(uploadTokens)
		.values({ tokenHash: sha256(token), name })
		.returning({ id: uploadTokens.id })
		.get().id;
	securityEvent(db, 'upload_token_aangemaakt', id);
	return { id, token };
}

export function activeUploadTokens(db: DB): UploadToken[] {
	return db
		.select()
		.from(uploadTokens)
		.where(isNull(uploadTokens.revokedAt))
		.orderBy(desc(uploadTokens.createdAt))
		.all();
}

/** `true` als er een actief token was om in te trekken. */
export function revokeUploadToken(db: DB, id: string): boolean {
	const result = db
		.update(uploadTokens)
		.set({ revokedAt: new Date().toISOString() })
		.where(and(eq(uploadTokens.id, id), isNull(uploadTokens.revokedAt)))
		.run();
	if (result.changes === 0) return false;
	uploadLimiter.reset(id);
	securityEvent(db, 'upload_token_ingetrokken', id);
	return true;
}

/** Het actieve token uit `Authorization: Bearer <token>`, of `null`. */
export function verifyUploadToken(db: DB, authorization: string | null): UploadToken | null {
	const match = /^Bearer ([^\s]+)$/.exec(authorization ?? '');
	const token = match?.[1];
	if (!token || !TOKEN_PATTERN.test(token)) return null;
	return (
		db
			.select()
			.from(uploadTokens)
			.where(and(eq(uploadTokens.tokenHash, sha256(token)), isNull(uploadTokens.revokedAt)))
			.get() ?? null
	);
}

export function isBlocked(token: UploadToken, now = new Date()): boolean {
	return token.blockedUntil !== null && Date.parse(token.blockedUntil) > now.getTime();
}

/**
 * Telt een upload mee voor dit token. `false` als het token geblokkeerd is of nu de grens
 * van 30 per uur overschrijdt; dan blokkeert hij een uur en volgt één pushmelding.
 */
export function admitUpload(db: DB, token: UploadToken, now = new Date()): boolean {
	if (isBlocked(token, now)) return false;
	if (!uploadLimiter.hit(token.id, now.getTime())) {
		db.update(uploadTokens)
			.set({ blockedUntil: new Date(now.getTime() + HOUR_MS).toISOString() })
			.where(eq(uploadTokens.id, token.id))
			.run();
		uploadLimiter.reset(token.id);
		securityEvent(db, 'upload_token_geblokkeerd', token.id);
		return false;
	}
	db.update(uploadTokens)
		.set({ lastUsedAt: now.toISOString() })
		.where(eq(uploadTokens.id, token.id))
		.run();
	securityEvent(db, 'upload_token_gebruikt', token.id);
	return true;
}
