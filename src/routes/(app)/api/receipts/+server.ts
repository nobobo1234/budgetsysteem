import { error } from '@sveltejs/kit';
import { db } from '#lib/server/db/index.ts';
import { json, requireSession } from '#lib/server/http.ts';
import { RateLimiter } from '#lib/server/ratelimit.ts';
import { readImageBody, storeReceipt } from '#lib/server/receipts/store.ts';
import { MAX_UPLOADS_PER_HOUR } from '#lib/server/receipts/tokens.ts';
import type { RequestHandler } from './$types';

// Een bon uploaden vanuit de app zelf, met je sessie. Dezelfde controles en opslag als het
// deelmenu, en dezelfde grens per uur (elke bon kost een Haiku-aanroep).
const limiter = new RateLimiter(MAX_UPLOADS_PER_HOUR, 60 * 60 * 1000);

export const POST: RequestHandler = async (event) => {
	const session = requireSession(event);
	if (!limiter.hit(session.idHash)) error(429, 'Te veel bonnen in een uur. Probeer het later.');
	const image = await readImageBody(event.request);
	const { id } = await storeReceipt(db(), { ...image, source: 'app' });
	return json({ status: 'ontvangen', id }, 202);
};
