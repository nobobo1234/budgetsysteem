// Lijn-iconen (24×24, stroke), gedeeld door de tabbalk, de tegels op Meer, de signaalkaartjes
// op het startscherm en de lege staten. Elk onderwerp heeft een eigen tint (oklch-hue). Een tab
// heeft daarnaast een gevulde vorm (`fill`) voor als hij actief is.

export interface IconDef {
	hue: number;
	path: string;
	/** Gevulde vorm voor de actieve tab; zonder is het pad zelf al dicht en wordt het gevuld */
	fill?: string;
}

export const overzicht: IconDef = {
	hue: 169,
	path: 'M4 10.5L12 4l8 6.5V20h-5v-6H9v6H4z'
};

export const transacties: IconDef = {
	hue: 220,
	path: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
	fill: 'M8 5h12v2H8z M8 11h12v2H8z M8 17h12v2H8z M4 4.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z M4 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z M4 16.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z'
};

export const budget: IconDef = {
	hue: 150,
	path: 'M12 3a9 9 0 1 0 9 9h-9z M15 3.5A9 9 0 0 1 20.5 9H15z'
};

// Een lijn die stijgt en daalt boven een as: trends en overzichten
export const analyses: IconDef = {
	hue: 110,
	path: 'M4 4v16h16 M8 15l3.5-4.5 3 2.5L19 7',
	fill: 'M3 3.5h2.2v15.3H21V21H3z M7.5 16.5v-2.2l4-5 3 2.5 4.8-6V16.5z'
};

export const meer: IconDef = {
	hue: 85,
	path: 'M5 12h.01M12 12h.01M19 12h.01',
	fill: 'M5 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4z M12 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4z M19 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4z'
};

export const teKrijgen: IconDef = {
	hue: 169,
	path: 'M20 12a8 8 0 1 1-8-8 M20 4l-6.5 6.5 M13 6v5h5'
};

export const vasteLasten: IconDef = {
	hue: 58,
	path: 'M5 5.5h14V20H5z M5 10h14 M9 3.5v4 M15 3.5v4 M8.5 14h2 M13.5 14h2'
};

export const saldocheck: IconDef = {
	hue: 250,
	path: 'M12 4v16 M7 20h10 M5 7.5h14 M5 7.5 2.5 13a2.5 2.5 0 0 0 5 0z M19 7.5 16.5 13a2.5 2.5 0 0 0 5 0z'
};

export const controleren: IconDef = {
	hue: 30,
	path: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z M15.5 15.5 20 20 M10.5 8v3.5 M10.5 14h.01'
};

export const importeren: IconDef = {
	hue: 250,
	path: 'M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M4 15v5h16v-5'
};

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

export const apparaten: IconDef = {
	hue: 115,
	path: 'M7 3h10v18H7z M10.5 18h3 M12 14V7 M9.5 9.5 12 7l2.5 2.5'
};

export const bonnen: IconDef = {
	hue: 185,
	path: 'M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21z M9 8h6 M9 12h6 M9 16h3'
};

export const boodschappen: IconDef = {
	hue: 140,
	path: 'M3 9h18l-1.8 10.5H4.8z M8 9l3-5 M16 9l-3-5 M9.5 13v3.5 M14.5 13v3.5'
};

// Een vlag: een tag markeert een periode, zoals een reis
export const tags: IconDef = { hue: 235, path: 'M5.5 21V3.5 M5.5 4.5h12l-2.5 4.25 2.5 4.25h-12' };
