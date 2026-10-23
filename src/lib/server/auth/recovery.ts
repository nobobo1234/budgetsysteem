import { and, eq, gt, isNull } from 'drizzle-orm';
import type { DB } from '../db/index.ts';
import { recoveryCodes, setupTokens } from '../db/schema.ts';
import { normalizeRecoveryCode, randomToken, recoveryCode, safeEqual, sha256 } from './crypto.ts';

// Herstelcode op papier en het eenmalige setup-token: beide alleen als hash opgeslagen.

/** Maakt een nieuwe herstelcode en maakt alle oude ongeldig. De code wordt één keer getoond. */
export function newRecoveryCode(db: DB): string {
	const code = recoveryCode();
	db.transaction((tx) => {
		tx.update(recoveryCodes)
			.set({ usedAt: new Date().toISOString() })
			.where(isNull(recoveryCodes.usedAt))
			.run();
		tx.insert(recoveryCodes)
			.values({ codeHash: sha256(normalizeRecoveryCode(code)) })
			.run();
	});
	return code;
}

export function hasRecoveryCode(db: DB): boolean {
	return db.select().from(recoveryCodes).where(isNull(recoveryCodes.usedAt)).get() !== undefined;
}

/** Verbruikt de herstelcode als hij klopt. Daarna werkt hij nooit meer. */
export function consumeRecoveryCode(db: DB, input: string): boolean {
	const normalized = normalizeRecoveryCode(input);
	if (normalized.length !== 20) return false;
	const hash = sha256(normalized);
	return db.transaction((tx) => {
		const active = tx.select().from(recoveryCodes).where(isNull(recoveryCodes.usedAt)).all();
		const match = active.find((c) => safeEqual(c.codeHash, hash));
		if (!match) return false;
		tx.update(recoveryCodes)
			.set({ usedAt: new Date().toISOString() })
			.where(eq(recoveryCodes.id, match.id))
			.run();
		return true;
	});
}

export const SETUP_TOKEN_MINUTES = 15;

/** Eenmalig token om de eerste passkey te registreren; alleen aan te maken op de server zelf. */
export function newSetupToken(db: DB): string {
	const token = randomToken(32);
	db.insert(setupTokens)
		.values({
			tokenHash: sha256(token),
			expiresAt: new Date(Date.now() + SETUP_TOKEN_MINUTES * 60 * 1000).toISOString()
		})
		.run();
	return token;
}

/** Hash van een geldig, ongebruikt setup-token, of `null`. Verbruikt het token niet. */
export function checkSetupToken(db: DB, token: string): string | null {
	if (token.length < 20 || token.length > 100) return null;
	const hash = sha256(token);
	const row = db
		.select()
		.from(setupTokens)
		.where(
			and(
				eq(setupTokens.tokenHash, hash),
				isNull(setupTokens.usedAt),
				gt(setupTokens.expiresAt, new Date().toISOString())
			)
		)
		.get();
	return row ? hash : null;
}

export function consumeSetupToken(db: DB, tokenHash: string): boolean {
	const result = db
		.update(setupTokens)
		.set({ usedAt: new Date().toISOString() })
		.where(
			and(
				eq(setupTokens.tokenHash, tokenHash),
				isNull(setupTokens.usedAt),
				gt(setupTokens.expiresAt, new Date().toISOString())
			)
		)
		.run();
	return result.changes === 1;
}
