// Waar je binnen de app vandaan kwam, voor de terugknop (zie nav.ts). `back` zegt de
// schermovergang dat de terugknop werd gebruikt, zodat de inhoud van links komt.

export const nav = $state<{ previous: string | null; back: boolean }>({
	previous: null,
	back: false
});
