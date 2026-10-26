// Je eigen gebruik (spec: Telemetrie en monitoring, Volhouden): per invoer alleen de dag, de
// soort en hoe lang het duurde van het openen van de app (of terugkeren naar de voorgrond) tot
// het opslaan. Nooit een bedrag of naam. Alleen dit kleine stuk zit in de eerste JS-bundel: het
// meet de tijd. De wachtrij en het versturen (usage-queue.ts) laden pas als er iets te doen is.
//
// Een pagina meldt een opgeslagen invoer met `dispatchEvent(new CustomEvent('invoer', { detail:
// 'snelinvoer' }))` in plaats van deze module te importeren. Zo importeert alleen de layout hem
// en wordt hij geen eigen chunk: elk extra script kost in het performance-budget ook headers.

export type EntryKind = 'snelinvoer' | 'verwacht' | 'bon';

// Milliseconden sinds het openen (performance.now() telt vanaf het laden van de pagina), of
// `null` als de tijd al gemeten is: alleen de eerste invoer na het openen telt.
let openedAt: number | null = 0;

// Lukt laden niet (offline en niet in de cache), dan is de meting weg: telemetrie mag de app
// nooit hinderen. Eenmaal geladen verstuurt de wachtrij zelf wat wacht.
const queue = () => import('./usage-queue.ts').then((m) => (m.startQueue(), m)).catch(() => null);

/** Een invoer is opgeslagen (ook als hij nog in de offline wachtrij staat). */
export function recordEntry(kind: EntryKind): void {
	const ms = openedAt === null ? null : performance.now() - openedAt;
	openedAt = null;
	const at = new Date();
	void queue().then((m) => m?.addEntry(kind, at, ms));
}

const reopen = () => (openedAt = performance.now());

/** Begint opnieuw te tellen als de app terugkomt op de voorgrond. */
export function startUsage(): void {
	if (document.visibilityState !== 'visible') openedAt = null;
	addEventListener('visibilitychange', () => document.visibilityState === 'visible' && reopen());
	// Terug uit de back/forward-cache: dat is ook openen
	addEventListener('pageshow', (event) => event.persisted && reopen());
	addEventListener('invoer', (event) => recordEntry(event.detail));
	// Wacht er nog iets van een vorige keer (de sleutel van usage-queue.ts), dan de wachtrij laden
	try {
		if (localStorage.getItem('gebruik')) void queue();
	} catch {
		// Geen localStorage: dan wacht er ook niets
	}
}
