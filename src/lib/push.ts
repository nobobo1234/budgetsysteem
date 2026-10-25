import { postJson } from './api.ts';

// Pushmeldingen in de browser. Een abonnement hoort bij een sessie: na opnieuw inloggen
// koppelt de app het abonnement van dit apparaat aan de nieuwe sessie.

export function pushSupported(): boolean {
	return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
	const registration = await navigator.serviceWorker.getRegistration();
	return (await registration?.pushManager.getSubscription()) ?? null;
}

/** Abonnement van dit apparaat (opnieuw) doorgeven. Geeft het ID terug, of `null`. */
export async function syncSubscription(subscription: PushSubscription): Promise<string | null> {
	const result = await postJson<{ id: string | null }>(
		'/api/push/subscription',
		subscription.toJSON()
	);
	return result.ok ? result.data.id : null;
}

/** Bij het openen van de app: stil bijwerken als dit apparaat meldingen heeft. */
export async function refreshSubscription(): Promise<void> {
	try {
		if (!pushSupported() || Notification.permission !== 'granted') return;
		const subscription = await currentSubscription();
		if (subscription) await syncSubscription(subscription);
	} catch {
		// Geen verbinding of geen service worker: de volgende keer opnieuw
	}
}
