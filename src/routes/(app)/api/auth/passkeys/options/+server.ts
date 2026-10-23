import { storeChallenge } from '#lib/server/auth/challenge.ts';
import { registrationOptions } from '#lib/server/auth/passkey.ts';
import { db } from '#lib/server/db/index.ts';
import { json, requireReauth } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

// Passkey toevoegen vraagt een verse bevestiging met een bestaande passkey (of de herstelcode).
export const POST: RequestHandler = async (event) => {
	requireReauth(event);
	const options = await registrationOptions(db());
	storeChallenge(event.cookies, options.challenge, 'register');
	return json(options);
};
