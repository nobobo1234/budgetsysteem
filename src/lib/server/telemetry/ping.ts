import { log } from '../log.ts';

// Externe beschikbaarheidscheck (spec: Telemetrie en monitoring): de app pingt een dienst die
// alarm slaat als de ping 15 minuten uitblijft. Ligt de VPS of de app plat, dan merk je het zo.
// De URL bevat een geheim en komt nooit in een logregel.

export const PING_INTERVAL_MS = 5 * 60_000;
const PING_TIMEOUT_MS = 10_000;

/** Eén ping, alleen als de app gezond is. Geeft terug of de ping gelukt is. */
export async function ping(
	url: string,
	healthy: () => boolean,
	fetcher: typeof fetch = fetch
): Promise<boolean> {
	if (!healthy()) {
		log.warn('geen ping: database niet bereikbaar');
		return false;
	}
	try {
		const response = await fetcher(url, {
			method: 'GET',
			signal: AbortSignal.timeout(PING_TIMEOUT_MS),
			// Alleen de ping zelf: geen cookies, geen referrer
			credentials: 'omit',
			redirect: 'error'
		});
		if (!response.ok) log.warn({ status: response.status }, 'ping geweigerd');
		return response.ok;
	} catch (e) {
		log.warn({ err: { name: e instanceof Error ? e.name : 'Onbekend' } }, 'ping mislukt');
		return false;
	}
}

/** Pingt direct en daarna elke vijf minuten. Houdt het proces niet in leven. */
export function startPinger(url: string, healthy: () => boolean): () => void {
	void ping(url, healthy);
	const timer = setInterval(() => void ping(url, healthy), PING_INTERVAL_MS);
	timer.unref();
	return () => clearInterval(timer);
}
