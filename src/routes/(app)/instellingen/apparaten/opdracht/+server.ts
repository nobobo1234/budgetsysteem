import { error } from '@sveltejs/kit';
import { requireSession } from '#lib/server/http.ts';
import { SHORTCUT_NAME } from '#lib/server/receipts/shortcut.ts';
import { currentShortcutStatus, shortcutBytes } from '#lib/server/receipts/shortcut-download.ts';
import type { RequestHandler } from './$types';

// De iOS-opdracht voor het deelmenu als download (spec: Uploaden via het deelmenu, stap 2).
// Ondertekend en zonder token; dat plak je bij installeren. Net als de rest alleen met sessie.
// Alleen als hij naar deze app stuurt en het certificaat nog geldig is.
export const GET: RequestHandler = (event) => {
	requireSession(event);
	const status = currentShortcutStatus();
	if (status.state === 'other-host') {
		error(409, `De opdracht stuurt naar ${status.host}, niet naar deze app.`);
	}
	if (status.state === 'expired') error(410, 'Het certificaat van de opdracht is verlopen.');
	return new Response(shortcutBytes, {
		headers: {
			'content-type': 'application/octet-stream',
			'content-length': String(shortcutBytes.length),
			'content-disposition': `attachment; filename="${SHORTCUT_NAME}.shortcut"`,
			'x-content-type-options': 'nosniff'
		}
	});
};
