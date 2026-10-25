// Gedeelde elementen bij een schermwissel (spec: Beweging): een tegel op Meer of een
// signaalkaartje op het startscherm schuift mee naar de kop van zijn pagina, en terug.
// Op de bronpagina staat `data-morph-to="<pad>"` met `data-morph-part`, op de doelpagina
// `data-morph-head="<deel>"`. De namen gelden alleen tijdens de overgang.

export type MorphPart = 'titel' | 'bedrag';

/** Pagina's met een tegel op Meer; hun paginatitel heeft `data-morph-head="titel"`. */
export const MEER_PAGES = [
	'/te-krijgen',
	'/terugbetalingen',
	'/vaste-lasten',
	'/saldocheck',
	'/categorieen',
	'/regels',
	'/personen',
	'/instellingen/meldingen',
	'/instellingen/rekeningen',
	'/instellingen/beveiliging',
	'/instellingen/status'
] as const;

const SOURCES: Record<string, Record<string, MorphPart[]>> = {
	'/': { '/te-krijgen': ['bedrag'], '/saldocheck': ['titel'] },
	'/instellingen': Object.fromEntries(MEER_PAGES.map((p) => [p, ['titel']]))
};

export interface MorphPlan {
	/** De pagina met de tegel of het kaartje */
	source: string;
	/** De pagina waarvan de kop meeschuift */
	target: string;
	parts: MorphPart[];
}

export function morphPlan(from: string, to: string): MorphPlan | null {
	const forward = SOURCES[from]?.[to];
	if (forward) return { source: from, target: to, parts: forward };
	const back = SOURCES[to]?.[from];
	if (back) return { source: to, target: from, parts: back };
	return null;
}

/** De selector voor de elementen van één deel op de pagina waar je nu bent. */
export function morphSelector(plan: MorphPlan, here: string, part: MorphPart): string {
	return here === plan.source
		? `[data-morph-to="${plan.target}"][data-morph-part="${part}"]`
		: `[data-morph-head="${part}"]`;
}
