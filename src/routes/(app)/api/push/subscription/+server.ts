import { error } from '@sveltejs/kit';
import { deviceNameFrom } from '#lib/server/auth/session.ts';
import { db } from '#lib/server/db/index.ts';
import { json, readJson, requireSession } from '#lib/server/http.ts';
import {
	removeSubscription,
	saveSubscription,
	subscriptionIdFor,
	subscriptionSchema,
	unsubscribeSchema
} from '#lib/server/push/subscriptions.ts';
import type { RequestHandler } from './$types';

// Pushmeldingen aan- en afmelden voor dit apparaat. Het endpoint en de sleutels komen van de
// push-dienst van de browser; alleen bekende push-diensten worden aangenomen.
export const POST: RequestHandler = async (event) => {
	const session = requireSession(event);
	const parsed = subscriptionSchema.safeParse(await readJson(event.request, 4096));
	if (!parsed.success) error(400, 'Ongeldig abonnement');
	const result = saveSubscription(
		db(),
		parsed.data,
		deviceNameFrom(event.request.headers.get('user-agent')),
		session.idHash
	);
	if (result === 'te_veel') error(409, 'Te veel apparaten met meldingen. Verwijder er eerst één.');
	// Het ID laat de instellingen "dit apparaat" herkennen; endpoint en sleutels gaan niet terug
	return json({ ok: true, id: subscriptionIdFor(db(), parsed.data.endpoint) }, 201);
};

export const DELETE: RequestHandler = async (event) => {
	requireSession(event);
	const parsed = unsubscribeSchema.safeParse(await readJson(event.request, 4096));
	if (!parsed.success) error(400, 'Ongeldig verzoek');
	removeSubscription(db(), parsed.data.endpoint);
	return json({ ok: true });
};
