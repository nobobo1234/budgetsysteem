// De overige onderwerp-iconen (zie icons.ts), voor Meer en de pagina's daarachter. Apart, zodat
// het startscherm en de tabbalk ze niet meeladen. Geeft icons.ts door, zodat een pagina één
// import heeft.
import type { IconDef } from './icons.ts';

export * from './icons.ts';

export const zoeken: IconDef = {
	hue: 220,
	path: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z M15.5 15.5 20 20'
};

export const terugbetalingen: IconDef = { hue: 200, path: 'M4 9h14l-3.5-3.5 M20 15H6l3.5 3.5' };

// Twee lijnen die samenkomen: een bankboeking en je eigen invoer worden één
export const samenvoegen: IconDef = { hue: 175, path: 'M6 3v4c0 4 6 5 6 9v5 M18 3v4c0 4-6 5-6 9' };

export const categorieen: IconDef = { hue: 300, path: 'M3.5 12V4h8l9 9-8 8z M8 8.5h.01' };

export const regels: IconDef = { hue: 330, path: 'M4 6h16 M4 12h9 M4 18h6 M16 14l3.5 3.5L16 21' };

export const personen: IconDef = {
	hue: 20,
	path: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M2.5 20a6.5 6.5 0 0 1 13 0 M16 4.3a3.5 3.5 0 0 1 0 6.4 M18.5 14.2A6.5 6.5 0 0 1 21.5 20'
};

export const meldingen: IconDef = {
	hue: 80,
	path: 'M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z M10 20.5a2 2 0 0 0 4 0'
};

export const rekeningen: IconDef = { hue: 220, path: 'M3 6h18v12H3z M3 10.5h18 M7 15h4' };

export const beveiliging: IconDef = {
	hue: 150,
	path: 'M12 3l8 3v6c0 4.4-3.4 7.9-8 9-4.6-1.1-8-4.6-8-9V6z M9 12l2.2 2.2L15.5 10'
};

export const status: IconDef = { hue: 270, path: 'M3 12h4l2.5-6 5 12 2.5-6h4' };

// Een kalender met een vink: dagen waarop je iets invoerde
export const gebruik: IconDef = {
	hue: 100,
	path: 'M4 5.5h16V20H4z M4 10h16 M8.5 3v4 M15.5 3v4 M9 15l2 2 4-4'
};

export const apparaten: IconDef = {
	hue: 115,
	path: 'M7 3h10v18H7z M10.5 18h3 M12 14V7 M9.5 9.5 12 7l2.5 2.5'
};

export const bonnen: IconDef = {
	hue: 185,
	path: 'M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21z M9 8h6 M9 12h6 M9 16h3'
};
