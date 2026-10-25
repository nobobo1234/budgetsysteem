import { error } from '@sveltejs/kit';
import { db } from '#lib/server/db/index.ts';
import { json } from '#lib/server/http.ts';
import { readImageBody, storeReceipt } from '#lib/server/receipts/store.ts';
import { admitUpload } from '#lib/server/receipts/tokens.ts';
import type { RequestHandler } from './$types';

// Upload vanuit het deelmenu (spec: Uploaden via het deelmenu). Het upload-token is al in
// hooks.server.ts gecontroleerd; zonder token komt een verzoek hier niet. De foto komt als
// ruwe body (image/jpeg of image/png), niet als formulier. Het antwoord is alleen "ontvangen"
// met een ID, nooit data.
export const POST: RequestHandler = async ({ request, locals }) => {
	const token = locals.uploadToken;
	if (!token) error(401, 'Niet ingelogd');
	if (!admitUpload(db(), token)) error(429, 'Te veel uploads. Probeer het over een uur opnieuw.');
	const image = await readImageBody(request);
	const { id } = await storeReceipt(db(), {
		...image,
		source: 'deelmenu',
		uploadTokenId: token.id
	});
	return json({ status: 'ontvangen', id }, 202);
};
