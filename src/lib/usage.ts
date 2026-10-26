import { toIsoDate } from './dates.ts';

// Je eigen gebruik (spec: Telemetrie en monitoring, Volhouden): per invoer alleen de dag, de
// soort en hoe lang het duurde van het openen van de app (of terugkeren naar de voorgrond) tot
// het opslaan. Nooit een bedrag of naam. Metingen wachten in localStorage tot ze verstuurd zijn,
// zodat offline invoer telt op de dag waarop je hem invoerde. Telemetrie mag de app nooit
// hinderen: lukt opslaan of versturen niet, dan is de meting weg.

export type EntryKind = 'snelinvoer' | 'verwacht' | 'bon';

interface Entry {
	id: string;
	day: string;
	kind: EntryKind;
	durationMs: number | null;
}

const KEY = 'gebruik';
const MAX_QUEUED = 100;
const PER_REQUEST = 20;
const MAX_DURATION_MS = 30 * 60_000;

// Milliseconden sinds het openen (performance.now() telt vanaf het laden van de pagina), of
// `null` als de tijd al gemeten is: alleen de eerste invoer na het openen telt.
let openedAt: number | null = 0;

function read(): Entry[] {
	try {
		const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
		return Array.isArray(list) ? (list as Entry[]) : [];
	} catch {
		return [];
	}
}

function write(list: Entry[]): void {
	try {
		if (list.length === 0) localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_QUEUED)));
	} catch {
		// Privévenster of vol: dan geen meting
	}
}

/** Een invoer is opgeslagen (ook als hij nog in de offline wachtrij staat). */
export function recordEntry(kind: EntryKind): void {
	const ms = openedAt === null ? null : Math.round(performance.now() - openedAt);
	openedAt = null;
	write([
		...read(),
		{
			id: crypto.randomUUID(),
			day: toIsoDate(new Date()),
			kind,
			durationMs: ms !== null && ms >= 0 && ms <= MAX_DURATION_MS ? ms : null
		}
	]);
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

/** Begint opnieuw te tellen als de app terugkomt op de voorgrond. */
export function startUsage(): void {
	if (started) return;
	started = true;
	if (document.visibilityState !== 'visible') openedAt = null;
	addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') openedAt = performance.now();
	});
	// Terug uit de back/forward-cache: dat is ook openen
	addEventListener('pageshow', (event) => {
		if (event.persisted) openedAt = performance.now();
	});
	void flushUsage();
}
