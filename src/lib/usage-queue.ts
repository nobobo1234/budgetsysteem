import type { EntryKind } from './usage.ts';

// De wachtrij van je eigen gebruik (zie usage.ts): metingen wachten in localStorage tot ze
// verstuurd zijn, zodat offline invoer telt op de dag waarop je hem invoerde. Deze module laadt
// pas bij de eerste invoer of als er nog iets wacht, buiten de eerste JS-bundel. Lukt opslaan
// of versturen niet, dan is de meting weg.

interface Entry {
	id: string;
	day: string;
	kind: EntryKind;
	durationMs: number | null;
}

// Sleutel in localStorage; usage.ts kijkt met dezelfde sleutel of er iets wacht
const USAGE_KEY = 'gebruik';
const MAX_QUEUED = 100;
const PER_REQUEST = 20;
/** Langer dan een half uur open is geen meting van invoeren meer: dan telt alleen de dag. */
const MAX_DURATION_MS = 30 * 60_000;

// Zoals toIsoDate in dates.ts, maar zonder import: dan hoeft de layout bij het laden van deze
// module geen andere chunks voor te laden (scheelt bytes in de eerste bundel)
const isoDay = (d: Date) =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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

/**
 * Zet een invoer in de wachtrij met de dag van `at` (lokale tijd) en de tijd sinds openen in
 * milliseconden (`null` als die niet gemeten is), en verstuurt hem.
 */
export function addEntry(kind: EntryKind, at: Date, sinceOpenMs: number | null): void {
	const ms = sinceOpenMs === null ? null : Math.round(sinceOpenMs);
	const durationMs = ms !== null && ms >= 0 && ms <= MAX_DURATION_MS ? ms : null;
	write([...read(), { id: crypto.randomUUID(), day: isoDay(at), kind, durationMs }]);
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

let started = false;

/** Bij het laden: versturen wat wacht, en opnieuw bij verbinding of terug op de voorgrond. */
export function startQueue(): void {
	if (started) return;
	started = true;
	addEventListener('online', () => void flushUsage());
	addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') void flushUsage();
	});
	void flushUsage();
}
