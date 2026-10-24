import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { storeChallenge } from '#lib/server/auth/challenge.ts';
import { registrationOptions } from '#lib/server/auth/passkey.ts';
import { checkSetupToken } from '#lib/server/auth/recovery.ts';
import { db } from '#lib/server/db/index.ts';
import { json, limitAuth, readJson } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

const schema = z.object({ token: z.string().min(1).max(100) }).strict();

export const POST: RequestHandler = async (event) => {
	limitAuth(event);
	const parsed = schema.safeParse(await readJson(event.request));
	const tokenHash = parsed.success ? checkSetupToken(db(), parsed.data.token.trim()) : null;
	if (!tokenHash) error(401, 'Dit setup-token klopt niet of is verlopen.');
	const options = await registrationOptions(db());
	storeChallenge(event.cookies, options.challenge, 'setup', tokenHash);
	return json(options);
};
