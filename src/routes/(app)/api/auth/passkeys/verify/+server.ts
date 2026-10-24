import { error } from '@sveltejs/kit';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { securityEvent } from '#lib/server/audit.ts';
import { consumeChallenge } from '#lib/server/auth/challenge.ts';
import { verifyRegistration } from '#lib/server/auth/passkey.ts';
import { deviceNameFrom } from '#lib/server/auth/session.ts';
import { db } from '#lib/server/db/index.ts';
import { json, readJson, requireReauth } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	requireReauth(event);
	const body = await readJson(event.request);
	const challenge = consumeChallenge(event.cookies, 'register');
	if (!challenge) error(400, 'Registratie verlopen. Probeer het opnieuw.');
	const passkey = await verifyRegistration(
		db(),
		body as RegistrationResponseJSON,
		challenge.challenge,
		deviceNameFrom(event.request.headers.get('user-agent'))
	).catch(() => null);
	if (!passkey) error(400, 'De passkey kon niet worden geregistreerd.');
	securityEvent(db(), 'passkey_toegevoegd', passkey.id);
	return json({ ok: true });
};
