import { error } from '@sveltejs/kit';
import { requireSession } from '#lib/server/http.ts';
import { SHORTCUT_NAME } from '#lib/server/receipts/shortcut.ts';
import { currentShortcut } from '#lib/server/receipts/shortcut-download.ts';
import type { RequestHandler } from './$types';

// De iOS-opdracht voor het deelmenu als download (spec: Uploaden via het deelmenu, stap 2).
// Ondertekend en zonder token; dat plak je bij installeren. Net als de rest alleen met sessie.
// Alleen als er een geldig bestand in het datavolume staat, het naar deze app stuurt en het
// certificaat nog geldig is (docs/ios-opdracht.md).
export const GET: RequestHandler = (event) => {
	requireSession(event);
	const { status, bytes } = currentShortcut();
	if (status.state === 'missing') error(404, 'Er is nog geen ondertekende opdracht geïnstalleerd.');
	if (status.state === 'invalid') error(409, 'Het bestand met de opdracht is ongeldig.');
	if (status.state === 'other-host') {
		error(409, `De opdracht stuurt naar ${status.host}, niet naar deze app.`);
	}
	if (status.state === 'expired') error(410, 'Het certificaat van de opdracht is verlopen.');
	if (!bytes) error(404, 'Er is nog geen ondertekende opdracht geïnstalleerd.');
	return new Response(bytes, {
		headers: {
			'content-type': 'application/octet-stream',
			'content-length': String(bytes.length),
			'content-disposition': `attachment; filename="${SHORTCUT_NAME}.shortcut"`,
			'x-content-type-options': 'nosniff'
		}
	});
};
