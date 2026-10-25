// Gedeelde elementen bij een schermwissel (spec: Beweging): een tegel op Meer of een
// signaalkaartje op het startscherm schuift mee naar de kop van zijn pagina, en terug. Net zo
// de naam van een vaste last, uit Te bevestigen of de lijst, naar de kop van zijn detailpagina.
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

/** Detailpagina's met een naam die meeschuift, en de pagina's met een rij die erheen leidt. */
const DETAILS: [pattern: RegExp, sources: string[]][] = [
	[/^\/vaste-lasten\/[0-9a-f-]{36}$/, ['/', '/vaste-lasten']]
];

function sourceParts(source: string, target: string): MorphPart[] | undefined {
	const fixed = SOURCES[source]?.[target];
	if (fixed) return fixed;
	for (const [pattern, sources] of DETAILS)
		if (pattern.test(target) && sources.includes(source)) return ['titel'];
	return undefined;
}

export function morphPlan(from: string, to: string): MorphPlan | null {
	const forward = sourceParts(from, to);
	if (forward) return { source: from, target: to, parts: forward };
	const back = sourceParts(to, from);
	if (back) return { source: to, target: from, parts: back };
	return null;
}

/** De selector voor de elementen van één deel op de pagina waar je nu bent. */
export function morphSelector(plan: MorphPlan, here: string, part: MorphPart): string {
	return here === plan.source
		? `[data-morph-to="${plan.target}"][data-morph-part="${part}"]`
		: `[data-morph-head="${part}"]`;
}
