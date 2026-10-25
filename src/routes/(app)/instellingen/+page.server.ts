import { redirect } from '@sveltejs/kit';
import { clearSessionCookie, revokeSession } from '#lib/server/auth/session.ts';
import { db } from '#lib/server/db/index.ts';
import { requireSession } from '#lib/server/http.ts';
import { meerTiles } from '#lib/server/meer.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ tiles: meerTiles(db()) });

export const actions: Actions = {
	logout: async (event) => {
		const session = requireSession(event);
		revokeSession(db(), session.idHash);
		clearSessionCookie(event.cookies);
		redirect(303, '/login?uitgelogd=1');
	}
};
