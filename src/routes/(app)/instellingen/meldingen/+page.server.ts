import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '#lib/server/db/index.ts';
import { requireSession } from '#lib/server/http.ts';
import {
	getNotificationSettings,
	sendTestNotification,
	setNotificationSetting,
	vapidKeys
} from '#lib/server/push/notify.ts';
import { listDevices, removeSubscriptionById } from '#lib/server/push/subscriptions.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.session) error(401, 'Niet ingelogd');
	return {
		// Publieke sleutel voor `pushManager.subscribe`; de privésleutel verlaat de server nooit
		vapidPublicKey: vapidKeys()?.publicKey ?? null,
		settings: getNotificationSettings(db()),
		devices: listDevices(db())
	};
};

const toggleSchema = z.object({ key: z.string().min(1).max(40) });
const deviceSchema = z.object({ id: z.uuid() });

export const actions: Actions = {
	toggle: async (event) => {
		requireSession(event);
		const form = await event.request.formData();
		const parsed = toggleSchema.safeParse({ key: form.get('key') });
		// Een aangevinkte checkbox stuurt `enabled`, een uitgevinkte niets
		const enabled = form.get('enabled') === 'on';
		if (!parsed.success || !setNotificationSetting(db(), parsed.data.key, enabled)) {
			return fail(400, { message: 'Deze melding kun je niet aan- of uitzetten.' });
		}
		return { toggled: parsed.data.key, enabled };
	},
	removeDevice: async (event) => {
		requireSession(event);
		const parsed = deviceSchema.safeParse(Object.fromEntries(await event.request.formData()));
		if (!parsed.success) return fail(400, { message: 'Onbekend apparaat.' });
		removeSubscriptionById(db(), parsed.data.id);
		return { removed: true };
	},
	test: async (event) => {
		requireSession(event);
		if (listDevices(db()).length === 0) {
			return fail(400, { message: 'Zet eerst meldingen aan op dit apparaat.' });
		}
		const result = await sendTestNotification(db());
		if (result.status === 'geen_sleutels') {
			return fail(503, { message: 'Pushmeldingen zijn op de server nog niet ingesteld.' });
		}
		if (result.sent === 0) return fail(502, { message: 'De testmelding kwam niet aan.' });
		return { tested: result.sent };
	}
};
