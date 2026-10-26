import { USAGE_KEY, type EntryKind } from './usage.ts';

// De wachtrij van je eigen gebruik (zie usage.ts): metingen wachten in localStorage tot ze
// verstuurd zijn, zodat offline invoer telt op de dag waarop je hem invoerde. Lukt opslaan of
// versturen niet, dan is de meting weg.

interface Entry {
	id: string;
	day: string;
	kind: EntryKind;
	durationMs: number | null;
}

const MAX_QUEUED = 100;
const PER_REQUEST = 20;

function read(): Entry[] {
	try {
		const list: unknown = JSON.parse(localStorage.getItem(USAGE_KEY) ?? '[]');
		return Array.isArray(list) ? (list as Entry[]) : [];
	} catch {
		return [];
	}
}

function write(list: Entry[]): void {
	try {
		if (list.length === 0) localStorage.removeItem(USAGE_KEY);
		else localStorage.setItem(USAGE_KEY, JSON.stringify(list.slice(-MAX_QUEUED)));
	} catch {
		// Privévenster of vol: dan geen meting
	}
}

/** Zet een invoer in de wachtrij en verstuurt hem. */
export function addEntry(entry: Omit<Entry, 'id'>): void {
	write([...read(), { id: crypto.randomUUID(), ...entry }]);
	void flushUsage();
}

let flushing: Promise<void> | null = null;

/** Verstuurt wat wacht. Bij geen verbinding, geen sessie of een serverfout: later opnieuw. */
export function flushUsage(): Promise<void> {
	flushing ??= (async () => {
		for (let batch = read().slice(0, PER_REQUEST); batch.length > 0;) {
			let response: Response;
			try {
				response = await fetch('/api/usage', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ entries: batch }),
					credentials: 'same-origin',
					keepalive: true
				});
			} catch {
				return;
			}
			// Een andere 4xx wordt nooit geaccepteerd: weggooien, anders blijft hij hangen
			const retry = response.status === 401 || response.status === 429 || response.status >= 500;
			if (retry) return;
			const sent = new Set(batch.map((e) => e.id));
			const rest = read().filter((e) => !sent.has(e.id));
			write(rest);
			batch = rest.slice(0, PER_REQUEST);
		}
	})().finally(() => {
		flushing = null;
	});
	return flushing;
}

// Opnieuw proberen bij verbinding of terug op de voorgrond
addEventListener('online', () => void flushUsage());
addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'visible') void flushUsage();
});
