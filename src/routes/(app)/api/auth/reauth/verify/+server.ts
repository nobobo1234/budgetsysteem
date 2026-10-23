import { error } from '@sveltejs/kit';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { securityEvent } from '#lib/server/audit.ts';
import { consumeChallenge } from '#lib/server/auth/challenge.ts';
import { verifyAuthentication } from '#lib/server/auth/passkey.ts';
import { markReauth } from '#lib/server/auth/session.ts';
import { db } from '#lib/server/db/index.ts';
import { json, limitAuth, readJson, requireSession } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

// Opnieuw bevestigen met je passkey, voor gevoelige acties (5 minuten geldig).
export const POST: RequestHandler = async (event) => {
	const session = requireSession(event);
	limitAuth(event);
	const body = await readJson(event.request);
	const challenge = consumeChallenge(event.cookies, 'reauth');
	if (!challenge) error(400, 'Bevestiging verlopen. Probeer het opnieuw.');
	const passkey = await verifyAuthentication(
		db(),
		body as AuthenticationResponseJSON,
		challenge.challenge
	).catch(() => null);
	if (!passkey) {
		securityEvent(db(), 'login_mislukt');
		error(401, 'Deze passkey wordt niet herkend.');
	}
	markReauth(db(), session.idHash);
	return json({ ok: true });
};
