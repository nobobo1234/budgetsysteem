// TER REVIEW (Noah): sessies, herstelcode, setup-token en challenges.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeChallenge, storeChallenge } from '../../src/lib/server/auth/challenge.ts';
import { recoveryCode } from '../../src/lib/server/auth/crypto.ts';
import {
	checkSetupToken,
	consumeRecoveryCode,
	consumeSetupToken,
	newRecoveryCode,
	newSetupToken
} from '../../src/lib/server/auth/recovery.ts';
import {
	createSession,
	hasRecentReauth,
	markReauth,
	revokeSession,
	validateSession
} from '../../src/lib/server/auth/session.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import { recoveryCodes, sessions, setupTokens } from '../../src/lib/server/db/schema.ts';
import { RateLimiter } from '../../src/lib/server/ratelimit.ts';
import { fakeCookies, tempDatabase } from './helpers.ts';

let db: DB;
let cleanup: () => void;
beforeEach(() => ({ db, cleanup } = tempDatabase()));
afterEach(() => {
	vi.useRealTimers();
	cleanup();
});

describe('sessies', () => {
	it('slaat alleen de hash op en het ID heeft minstens 128 bits', () => {
		const { token, idHash } = createSession(db, { passkeyId: null, deviceName: 'test' });
		expect(Buffer.from(token, 'base64url').length).toBeGreaterThanOrEqual(16);
		const rows = db.select().from(sessions).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.idHash).toBe(idHash);
		expect(JSON.stringify(rows)).not.toContain(token);
	});

	it('elke login een nieuw ID', () => {
		const a = createSession(db, { passkeyId: null, deviceName: 'a' });
		const b = createSession(db, { passkeyId: null, deviceName: 'a' });
		expect(a.token).not.toBe(b.token);
	});

	it('is 30 dagen geldig, daarna niet meer', () => {
		vi.useFakeTimers({ now: new Date('2026-10-01T12:00:00Z') });
		const { token } = createSession(db, { passkeyId: null, deviceName: 'test' });
		vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
		expect(validateSession(db, token)).not.toBeNull();
		vi.setSystemTime(new Date('2026-11-01T12:00:01Z'));
		expect(validateSession(db, token)).toBeNull();
	});

	it('een ingetrokken sessie werkt niet meer', () => {
		const { token, idHash } = createSession(db, { passkeyId: null, deviceName: 'test' });
		revokeSession(db, idHash);
		expect(validateSession(db, token)).toBeNull();
	});

	it('herbevestiging is vijf minuten geldig', () => {
		const { token, idHash } = createSession(db, { passkeyId: null, deviceName: 'test' });
		expect(hasRecentReauth(validateSession(db, token)!)).toBe(false);
		markReauth(db, idHash);
		const session = validateSession(db, token)!;
		expect(hasRecentReauth(session)).toBe(true);
		expect(hasRecentReauth(session, Date.now() + 6 * 60 * 1000)).toBe(false);
	});
});

describe('herstelcode', () => {
	it('heeft 100 bits in groepjes van vier', () => {
		expect(recoveryCode()).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
	});

	it('werkt één keer, ongeacht hoofdletters en streepjes, en staat alleen als hash in de database', () => {
		const code = newRecoveryCode(db);
		expect(JSON.stringify(db.select().from(recoveryCodes).all())).not.toContain(
			code.replaceAll('-', '')
		);
		expect(consumeRecoveryCode(db, code.toLowerCase().replaceAll('-', ' '))).toBe(true);
		expect(consumeRecoveryCode(db, code)).toBe(false);
	});

	it('een nieuwe code maakt de oude ongeldig', () => {
		const old = newRecoveryCode(db);
		newRecoveryCode(db);
		expect(consumeRecoveryCode(db, old)).toBe(false);
	});

	it('weigert onzin', () => {
		newRecoveryCode(db);
		expect(consumeRecoveryCode(db, '')).toBe(false);
		expect(consumeRecoveryCode(db, 'AAAA-AAAA-AAAA-AAAA-AAAA')).toBe(false);
	});
});

describe('setup-token', () => {
	it('is eenmalig, verloopt en staat alleen als hash in de database', () => {
		const token = newSetupToken(db);
		expect(JSON.stringify(db.select().from(setupTokens).all())).not.toContain(token);
		const hash = checkSetupToken(db, token);
		expect(hash).not.toBeNull();
		expect(consumeSetupToken(db, hash!)).toBe(true);
		expect(consumeSetupToken(db, hash!)).toBe(false);
		expect(checkSetupToken(db, token)).toBeNull();
	});

	it('werkt niet meer na een kwartier', () => {
		const token = newSetupToken(db);
		db.update(setupTokens)
			.set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
			.run();
		expect(checkSetupToken(db, token)).toBeNull();
	});
});

describe('challenges', () => {
	it('werken één keer en alleen voor hun eigen doel', () => {
		const cookies = fakeCookies();
		storeChallenge(cookies, 'abc', 'login');
		const copy = fakeCookies(Object.fromEntries(cookies.jar));
		expect(consumeChallenge(cookies, 'login')?.challenge).toBe('abc');
		expect(consumeChallenge(copy, 'login')).toBeNull();

		const other = fakeCookies();
		storeChallenge(other, 'def', 'login');
		expect(consumeChallenge(other, 'register')).toBeNull();
	});
});

describe('rate limiting', () => {
	it('laat tot het maximum door en reset na het venster', () => {
		const limiter = new RateLimiter(3, 1000);
		expect([1, 2, 3, 4].map(() => limiter.hit('ip', 0))).toEqual([true, true, true, false]);
		expect(limiter.hit('ander-ip', 0)).toBe(true);
		expect(limiter.hit('ip', 1001)).toBe(true);
	});

	it('groeit niet onbeperkt', () => {
		const limiter = new RateLimiter(1, 1000, 10);
		for (let i = 0; i < 100; i++) limiter.hit(`ip-${i}`, 0);
		expect(
			(limiter as unknown as { windows: Map<string, unknown> }).windows.size
		).toBeLessThanOrEqual(10);
	});
});

describe('database', () => {
	it('opent met WAL, busy_timeout en foreign keys', () => {
		expect(db.$client.pragma('journal_mode', { simple: true })).toBe('wal');
		expect(db.$client.pragma('busy_timeout', { simple: true })).toBe(5000);
		expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
	});

	it('startdata wordt maar één keer gezaaid', async () => {
		const { seed } = await import('../../src/lib/server/db/seed.ts');
		const { categories } = await import('../../src/lib/server/db/schema.ts');
		const before = db.select().from(categories).all().length;
		seed(db);
		expect(db.select().from(categories).all().length).toBe(before);
		expect(before).toBe(24);
		expect(db.select().from(sessions).where(eq(sessions.deviceName, 'x')).all()).toEqual([]);
	});
});
