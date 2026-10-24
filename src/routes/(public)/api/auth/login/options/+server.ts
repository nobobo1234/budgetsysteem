import { storeChallenge } from '#lib/server/auth/challenge.ts';
import { authenticationOptions } from '#lib/server/auth/passkey.ts';
import { json, limitAuth } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	limitAuth(event);
	const options = await authenticationOptions();
	storeChallenge(event.cookies, options.challenge, 'login');
	return json(options);
};
