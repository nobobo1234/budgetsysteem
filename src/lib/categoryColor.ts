// Kleur per categoriegroep, zodat je in lijsten in één oogopslag ziet waar iets onder valt.
// Alleen de tint ligt hier vast; licht en verzadiging komen uit app.css (licht en donker thema).

const HUES: Record<string, number> = {
	'Vaste lasten': 250,
	Dagelijks: 150,
	Onderweg: 205,
	'Vrije tijd': 320,
	Overig: 60,
	'Buiten budget': 95
};

/** Tint (0–360) voor een groep; onbekende groepen krijgen een vaste tint op basis van de naam. */
export function groupHue(group: string): number {
	const known = HUES[group];
	if (known !== undefined) return known;
	let h = 0;
	for (const ch of group) h = (h * 31 + ch.charCodeAt(0)) % 360;
	return h;
}

/** CSS-kleur voor een groep, of `null` voor "zonder categorie". */
export function groupColor(group: string | null | undefined): string | null {
	if (!group) return null;
	return `oklch(var(--dot-l) var(--dot-c) ${groupHue(group)})`;
}
