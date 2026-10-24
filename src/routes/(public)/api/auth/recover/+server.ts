import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { securityEvent } from '#lib/server/audit.ts';
import { consumeRecoveryCode } from '#lib/server/auth/recovery.ts';
import { createSession, deviceNameFrom, setSessionCookie } from '#lib/server/auth/session.ts';
import { db } from '#lib/server/db/index.ts';
import { json, limitAuth, readJson } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

const schema = z.object({ code: z.string().min(1).max(64) }).strict();

// Herstelcode op papier: eenmalig. Daarna voeg je meteen een nieuwe passkey toe.
export const POST: RequestHandler = async (event) => {
	limitAuth(event);
	const parsed = schema.safeParse(await readJson(event.request));
	if (!parsed.success || !consumeRecoveryCode(db(), parsed.data.code)) {
		securityEvent(db(), 'login_mislukt');
		error(401, 'Deze herstelcode klopt niet of is al gebruikt.');
	}
	const session = createSession(db(), {
		passkeyId: null,
		deviceName: deviceNameFrom(event.request.headers.get('user-agent')),
		reauth: true
	});
	setSessionCookie(event.cookies, session.token, session.expiresAt);
	securityEvent(db(), 'herstelcode_gebruikt');
	return json({ ok: true });
};
