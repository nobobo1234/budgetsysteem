// Navigatie tussen pagina's zonder eigen tab (spec: Navigatie). De terugknop gaat naar waar je
// vandaan kwam als dat een van de ouders van de pagina is, anders naar een vaste ouder.

const LABELS: Record<string, string> = {
	'/': 'Overzicht',
	'/transacties': 'Transacties',
	'/budget': 'Budget',
	'/import': 'Import',
	'/instellingen': 'Meer',
	'/te-krijgen': 'Te krijgen',
	'/vaste-lasten': 'Vaste lasten'
};

export interface BackTarget {
	href: string;
	label: string;
}

/**
 * Waar de terugknop heen gaat. Alleen naar een bekende ouder, zodat twee subpagina's die naar
 * elkaar linken nooit een lus vormen; de zoekopdracht van een lijst blijft behouden.
 */
export function backTarget(
	previous: string | null,
	parents: readonly string[],
	labels: Record<string, string> = {}
): BackTarget {
	const fallback = parents[0] ?? '/';
	const path = previous ? previous.split('?')[0]! : null;
	const href = path && parents.includes(path) ? previous! : fallback;
	const key = href.split('?')[0]!;
	return { href, label: labels[key] ?? LABELS[key] ?? 'Terug' };
}

/** Pagina's met een vaste tab: een subpagina laat de tab van haar ouder actief. */
const TAB_OF: [prefix: string, tab: string][] = [
	['/vaste-lasten', '/budget'],
	['/categorieen', '/budget'],
	['/regels', '/budget'],
	['/te-krijgen', '/instellingen'],
	['/personen', '/instellingen'],
	['/terugbetalingen', '/instellingen'],
	['/saldocheck', '/instellingen']
];

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export function activeTab(path: string): string {
	if (path === '/') return '/';
	for (const [prefix, tab] of TAB_OF) if (under(path, prefix)) return tab;
	for (const tab of ['/transacties', '/budget', '/import', '/instellingen'])
		if (under(path, tab)) return tab;
	return '';
}
