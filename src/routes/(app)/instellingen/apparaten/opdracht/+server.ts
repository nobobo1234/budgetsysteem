import { requireSession } from '#lib/server/http.ts';
import { SHORTCUT_NAME } from '#lib/server/receipts/shortcut.ts';
import { SIGNED_SHORTCUT } from '#lib/server/receipts/shortcut-signed.ts';
import type { RequestHandler } from './$types';

// De iOS-opdracht voor het deelmenu als download (spec: Uploaden via het deelmenu, stap 2).
// Ondertekend en zonder token; dat plak je bij installeren. Net als de rest alleen met sessie.
const bytes = Buffer.from(SIGNED_SHORTCUT.base64, 'base64');

export const GET: RequestHandler = (event) => {
	requireSession(event);
	return new Response(bytes, {
		headers: {
			'content-type': 'application/octet-stream',
			'content-length': String(bytes.length),
			'content-disposition': `attachment; filename="${SHORTCUT_NAME}.shortcut"`,
			'x-content-type-options': 'nosniff'
		}
	});
};
