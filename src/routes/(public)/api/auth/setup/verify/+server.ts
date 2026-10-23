import { error } from '@sveltejs/kit';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { eq } from 'drizzle-orm';
import { securityEvent } from '#lib/server/audit.ts';
import { consumeChallenge } from '#lib/server/auth/challenge.ts';
import { verifyRegistration } from '#lib/server/auth/passkey.ts';
import { consumeSetupToken, newRecoveryCode } from '#lib/server/auth/recovery.ts';
import { createSession, deviceNameFrom, setSessionCookie } from '#lib/server/auth/session.ts';
import { db } from '#lib/server/db/index.ts';
import { passkeys } from '#lib/server/db/schema.ts';
import { json, limitAuth, readJson } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	limitAuth(event);
	const body = await readJson(event.request);
	const challenge = consumeChallenge(event.cookies, 'setup');
	if (!challenge?.binding) error(400, 'Registratie verlopen. Probeer het opnieuw.');
	const tokenHash = challenge.binding;

	const deviceName = deviceNameFrom(event.request.headers.get('user-agent'));
	const passkey = await verifyRegistration(
		db(),
		body as RegistrationResponseJSON,
		challenge.challenge,
		deviceName
	).catch(() => null);
	if (!passkey) error(400, 'De passkey kon niet worden geregistreerd.');

	// Het token kan intussen gebruikt of verlopen zijn: pas nu verbruiken, anders terugdraaien
	if (!consumeSetupToken(db(), tokenHash)) {
		db().delete(passkeys).where(eq(passkeys.id, passkey.id)).run();
		error(401, 'Dit setup-token klopt niet of is verlopen.');
	}

	const session = createSession(db(), { passkeyId: passkey.id, deviceName, reauth: true });
	setSessionCookie(event.cookies, session.token, session.expiresAt);
	securityEvent(db(), 'setup_token_gebruikt');
	securityEvent(db(), 'passkey_toegevoegd', passkey.id);
	// Herstelcode voor op papier; wordt maar één keer getoond
	return json({ recoveryCode: newRecoveryCode(db()) });
};
