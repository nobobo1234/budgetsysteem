// Productgroepen voor boodschappen (spec: Analyses → Boodschappen per productgroep). Een vaste lijst
// in plaats van losse producten: Haiku kiest per artikelregel een groep, jij kunt hem aanpassen.
// Gedeeld door de lezer (enum in het schema), de database en de interface.

export const PRODUCT_GROUPS = [
	'groente_fruit',
	'zuivel_eieren',
	'vlees_vis',
	'brood_ontbijt',
	'voorraad',
	'kant_en_klaar',
	'snacks_snoep',
	'frisdrank_sap',
	'alcohol',
	'huishouden',
	'verzorging',
	'overig'
] as const;
export type ProductGroup = (typeof PRODUCT_GROUPS)[number];

export const PRODUCT_GROUP_LABEL: Record<ProductGroup, string> = {
	groente_fruit: 'Groente en fruit',
	zuivel_eieren: 'Zuivel en eieren',
	vlees_vis: 'Vlees en vis',
	brood_ontbijt: 'Brood en ontbijt',
	voorraad: 'Voorraad',
	kant_en_klaar: 'Kant-en-klaar',
	snacks_snoep: 'Snacks en snoep',
	frisdrank_sap: 'Frisdrank en sap',
	alcohol: 'Alcohol',
	huishouden: 'Huishouden',
	verzorging: 'Verzorging',
	overig: 'Overig'
};

// Tint per groep, verspreid over de kleurcirkel zonder oranje en rood (die betekenen tempo en
// aandacht); buren in de lijst verschillen genoeg om in de gestapelde balk uit elkaar te houden.
const HUES: Record<ProductGroup, number | null> = {
	groente_fruit: 140,
	zuivel_eieren: 230,
	vlees_vis: 350,
	brood_ontbijt: 90,
	voorraad: 275,
	kant_en_klaar: 185,
	snacks_snoep: 320,
	frisdrank_sap: 250,
	alcohol: 300,
	huishouden: 200,
	verzorging: 160,
	overig: null
};

export function isProductGroup(value: unknown): value is ProductGroup {
	return typeof value === 'string' && (PRODUCT_GROUPS as readonly string[]).includes(value);
}

/** CSS-kleur voor een groep; overig en "nog geen groep" zijn grijs. */
export function productGroupColor(group: ProductGroup | null): string {
	const hue = group === null ? null : HUES[group];
	return hue === null
		? 'color-mix(in oklch, var(--muted) 55%, var(--surface-2))'
		: `oklch(var(--dot-l) var(--dot-c) ${hue})`;
}
