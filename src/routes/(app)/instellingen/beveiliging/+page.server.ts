import { error, fail } from '@sveltejs/kit';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { securityEvent } from '#lib/server/audit.ts';
import { activePasskeys } from '#lib/server/auth/passkey.ts';
import { hasRecoveryCode, newRecoveryCode } from '#lib/server/auth/recovery.ts';
import {
	hasRecentReauth,
	revokeSession,
	revokeSessionsForPasskey
} from '#lib/server/auth/session.ts';
import { db } from '#lib/server/db/index.ts';
import { passkeys, sessions } from '#lib/server/db/schema.ts';
import { requireReauth, requireSession } from '#lib/server/http.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const session = locals.session;
	if (!session) error(401, 'Niet ingelogd');
	return {
		currentSession: session.idHash,
		reauthFresh: hasRecentReauth(session),
		passkeys: activePasskeys(db()).map((p) => ({
			id: p.id,
			deviceName: p.deviceName,
			backedUp: p.backedUp,
			createdAt: p.createdAt,
			lastUsedAt: p.lastUsedAt
		})),
		sessions: db()
			.select({
				idHash: sessions.idHash,
				deviceName: sessions.deviceName,
				createdAt: sessions.createdAt,
				lastUsedAt: sessions.lastUsedAt
			})
			.from(sessions)
			.where(and(isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date().toISOString())))
			.orderBy(desc(sessions.lastUsedAt))
			.all(),
		hasRecoveryCode: hasRecoveryCode(db())
	};
};

const hashSchema = z.object({ id: z.string().regex(/^[0-9a-f]{64}$/) });
const passkeySchema = z.object({ id: z.string().min(1).max(1024) });
export const actions: Actions = {
	revokeSession: async (event) => {
		requireSession(event);
		const parsed = hashSchema.safeParse(Object.fromEntries(await event.request.formData()));
		if (!parsed.success) return fail(400, { message: 'Onbekende sessie.' });
		revokeSession(db(), parsed.data.id);
		securityEvent(db(), 'sessie_ingetrokken');
		return { ok: true };
	},
	revokePasskey: async (event) => {
		const session = requireReauth(event);
		const parsed = passkeySchema.safeParse(Object.fromEntries(await event.request.formData()));
		if (!parsed.success) return fail(400, { message: 'Onbekende passkey.' });
		if (activePasskeys(db()).length <= 1) {
			return fail(400, { message: 'Je laatste passkey kun je niet verwijderen.' });
		}
		db()
			.update(passkeys)
			.set({ revokedAt: new Date().toISOString() })
			.where(and(eq(passkeys.id, parsed.data.id), isNull(passkeys.revokedAt)))
			.run();
		// Sessies die met deze passkey zijn gestart vervallen ook, behalve de huidige
		if (session.passkeyId !== parsed.data.id) revokeSessionsForPasskey(db(), parsed.data.id);
		securityEvent(db(), 'passkey_verwijderd', parsed.data.id);
		return { ok: true };
	},
	recoveryCode: async (event) => {
		requireReauth(event);
		const code = newRecoveryCode(db());
		securityEvent(db(), 'herstelcode_vernieuwd');
		return { recoveryCode: code };
	}
};
