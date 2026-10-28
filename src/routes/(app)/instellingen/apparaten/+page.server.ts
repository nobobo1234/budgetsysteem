import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { activePasskeys } from '#lib/server/auth/passkey.ts';
import { hasRecentReauth } from '#lib/server/auth/session.ts';
import { db } from '#lib/server/db/index.ts';
import { requireReauth, requireSession } from '#lib/server/http.ts';
import {
	currentShortcutStatus,
	signedShortcutPath
} from '#lib/server/receipts/shortcut-download.ts';
import {
	MAX_ACTIVE_TOKENS,
	activeUploadTokens,
	createUploadToken,
	isBlocked,
	revokeUploadToken
} from '#lib/server/receipts/tokens.ts';
import type { Actions, PageServerLoad } from './$types';

// Apparaten die bonnetjes mogen sturen via het deelmenu (spec: Uploaden via het deelmenu).
// Een token aanmaken vraagt opnieuw om je passkey; intrekken kan altijd met één tik.

export const load: PageServerLoad = ({ locals }) => {
	const session = locals.session;
	if (!session) error(401, 'Niet ingelogd');
	const now = new Date();
	return {
		reauthFresh: hasRecentReauth(session),
		passkeys: activePasskeys(db()).length,
		shortcut: currentShortcutStatus(now),
		// Waar het ondertekende bestand moet staan, voor de uitleg bij "geen of een ander bestand"
		shortcutPath: signedShortcutPath(),
		tokens: activeUploadTokens(db()).map((t) => ({
			id: t.id,
			name: t.name,
			createdAt: t.createdAt,
			lastUsedAt: t.lastUsedAt,
			blockedUntil: isBlocked(t, now) ? t.blockedUntil : null
		}))
	};
};

const nameSchema = z.object({ name: z.string().trim().min(1).max(40) });
const idSchema = z.object({ id: z.uuid() });

export const actions: Actions = {
	create: async (event) => {
		requireReauth(event);
		const parsed = nameSchema.safeParse(Object.fromEntries(await event.request.formData()));
		if (!parsed.success) return fail(400, { message: 'Geef het apparaat een naam.' });
		if (activeUploadTokens(db()).length >= MAX_ACTIVE_TOKENS) {
			return fail(400, {
				message: `Je hebt al ${MAX_ACTIVE_TOKENS} tokens. Trek er eerst een in.`
			});
		}
		const { id, token } = createUploadToken(db(), parsed.data.name);
		// Het token zelf staat alleen in dit antwoord; daarna nergens meer
		return { created: { id, name: parsed.data.name, token } };
	},
	revoke: async (event) => {
		requireSession(event);
		const parsed = idSchema.safeParse(Object.fromEntries(await event.request.formData()));
		if (!parsed.success) return fail(400, { message: 'Onbekend token.' });
		if (!revokeUploadToken(db(), parsed.data.id)) {
			return fail(404, { message: 'Dit token is al ingetrokken.' });
		}
		return { revoked: true };
	}
};
