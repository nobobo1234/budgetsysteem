import { toIsoDate } from './dates.ts';

// Je eigen gebruik (spec: Telemetrie en monitoring, Volhouden): per invoer alleen de dag, de
// soort en hoe lang het duurde van het openen van de app (of terugkeren naar de voorgrond) tot
// het opslaan. Nooit een bedrag of naam. Deze module meet de tijd; de wachtrij en het versturen
// (usage-queue.ts) laden pas als er iets te doen is. De server gebruikt dezelfde soorten en
// grens om te valideren.

export const ENTRY_KINDS = ['snelinvoer', 'verwacht', 'bon'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/** Langer dan een half uur open is geen meting van invoeren meer: dan telt alleen de dag. */
export const MAX_DURATION_MS = 30 * 60_000;

/** Sleutel in localStorage waaronder de wachtrij staat */
export const USAGE_KEY = 'gebruik';

// Milliseconden sinds het openen (performance.now() telt vanaf het laden van de pagina), of
// `null` als de tijd al gemeten is: alleen de eerste invoer na het openen telt.
let openedAt: number | null = 0;

// Lukt laden niet (offline en niet in de cache), dan is de meting weg: telemetrie mag de app
// nooit hinderen.
const queue = () => import('./usage-queue.ts');

/** Een invoer is opgeslagen (ook als hij nog in de offline wachtrij staat). */
export function recordEntry(kind: EntryKind): void {
	const ms = openedAt === null ? null : Math.round(performance.now() - openedAt);
	openedAt = null;
	const durationMs = ms !== null && ms >= 0 && ms <= MAX_DURATION_MS ? ms : null;
	const entry = { day: toIsoDate(new Date()), kind, durationMs };
	queue()
		.then((m) => m.addEntry(entry))
		.catch(() => {});
}

const reopen = () => (openedAt = performance.now());

/** Begint opnieuw te tellen als de app terugkomt op de voorgrond, en verstuurt wat nog wacht. */
export function startUsage(): void {
	if (document.visibilityState !== 'visible') openedAt = null;
	addEventListener('visibilitychange', () => document.visibilityState === 'visible' && reopen());
	// Terug uit de back/forward-cache: dat is ook openen
	addEventListener('pageshow', (event) => event.persisted && reopen());
	try {
		if (!localStorage.getItem(USAGE_KEY)) return;
	} catch {
		return; // Geen localStorage: dan wacht er ook niets
	}
	queue()
		.then((m) => m.flushUsage())
		.catch(() => {});
}
