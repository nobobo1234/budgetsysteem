import { error } from '@sveltejs/kit';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { securityEvent } from '#lib/server/audit.ts';
import { consumeChallenge } from '#lib/server/auth/challenge.ts';
import { verifyAuthentication } from '#lib/server/auth/passkey.ts';
import { createSession, deviceNameFrom, setSessionCookie } from '#lib/server/auth/session.ts';
import { db } from '#lib/server/db/index.ts';
import { json, limitAuth, readJson } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	limitAuth(event);
	const body = await readJson(event.request);
	const challenge = consumeChallenge(event.cookies, 'login');
	if (!challenge) error(400, 'Inlogpoging verlopen. Probeer het opnieuw.');

	const passkey = await verifyAuthentication(
		db(),
		body as AuthenticationResponseJSON,
		challenge.challenge
	).catch(() => null);
	if (!passkey) {
		securityEvent(db(), 'login_mislukt');
		error(401, 'Deze passkey wordt niet herkend.');
	}

	const session = createSession(db(), {
		passkeyId: passkey.id,
		deviceName: deviceNameFrom(event.request.headers.get('user-agent'))
	});
	setSessionCookie(event.cookies, session.token, session.expiresAt);
	securityEvent(db(), 'login', passkey.id);
	return json({ ok: true });
};
