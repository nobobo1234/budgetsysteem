// Tags (spec: Dagelijks gebruik → Tags): pure functies, zonder database. Een tag heeft een
// periode en hangt zich vanzelf aan elke transactie met een datum daarin. Wat je zelf aan- of
// uitzette blijft staan; het totaal telt zoals het budget.

import { formatShortDate } from './dates.ts';
import { formatCents } from './money.ts';

/** Vaste reeks tinten (oklch-hue) voor tags; geen oranje of rood, die betekenen tempo en aandacht. */
export const TAG_HUES = [169, 220, 250, 285, 320, 195, 135] as const;

/** Naam van elke tint, voor schermlezers en de keuze in het formulier. */
export const HUE_NAMES: Record<(typeof TAG_HUES)[number], string> = {
	169: 'Zeegroen',
	220: 'Blauw',
	250: 'Indigo',
	285: 'Paars',
	320: 'Roze',
	195: 'Petrol',
	135: 'Groen'
};

/** De eerste tint die nog niet in gebruik is, zodat tags naast elkaar te onderscheiden zijn. */
export function nextHue(used: readonly number[]): number {
	return TAG_HUES.find((h) => !used.includes(h)) ?? TAG_HUES[used.length % TAG_HUES.length]!;
}

export interface TagPeriod {
	id: string;
	startDate: string;
	/** Leeg: de tag loopt door */
	endDate: string | null;
}

/** Valt een datum (`YYYY-MM-DD`) in de periode van de tag? Begin- en einddatum tellen mee. */
export function covers(tag: Omit<TagPeriod, 'id'>, date: string): boolean {
	return date >= tag.startDate && (tag.endDate === null || date <= tag.endDate);
}

/** Een tag op de detailpagina van een transactie. */
export interface TagChip {
	id: string;
	name: string;
	hue: number;
	on: boolean;
	/** Zelf aan- of uitgezet; anders volgt hij de periode */
	manual: boolean;
}

export interface TagLink {
	tagId: string;
	source: 'automatisch' | 'handmatig';
	active: boolean;
}

/**
 * Wat het automatisch toewijzen aan de tags van één transactie verandert: tags waarvan de
 * periode de datum dekt en die er nog niet op staan komen erbij; automatische tags waarvan de
 * periode de datum niet (meer) dekt gaan eraf. Wat je zelf aan- of uitzette blijft staan.
 */
export function autoTagChanges(
	date: string,
	tags: readonly TagPeriod[],
	links: readonly TagLink[]
): { add: string[]; remove: string[] } {
	const linked = new Map(links.map((l) => [l.tagId, l]));
	const byId = new Map(tags.map((t) => [t.id, t]));
	const add = tags.filter((t) => covers(t, date) && !linked.has(t.id)).map((t) => t.id);
	const remove = links
		.filter((l) => {
			if (l.source !== 'automatisch') return false;
			const tag = byId.get(l.tagId);
			return !tag || !covers(tag, date);
		})
		.map((l) => l.tagId);
	return { add, remove };
}

/** Één regel die meetelt voor een tag: een transactie zonder verdeling, of één deel ervan. */
export interface TagLine {
	categoryId: string | null;
	categoryName: string | null;
	categoryGroup: string | null;
	/** `false` voor een categorie buiten budget; leeg zonder categorie */
	countsForBudget: boolean | null;
	/** Negatief is uitgaand, positief is inkomend (een retour) */
	amountCents: number;
	/** Het voorgeschoten deel van een gedeelde uitgave: dat is niet van jou */
	advanced: boolean;
}

export interface TagCategory {
	categoryId: string | null;
	name: string;
	group: string | null;
	cents: number;
}

export interface TagSpend {
	/** Uitgegeven, als positief getal; een retour verlaagt het */
	totalCents: number;
	/** Per categorie, het meeste eerst; zonder categorie als laatste */
	byCategory: TagCategory[];
}

/**
 * Wat een tag kostte, zoals het budget telt: van een gedeelde of voorgeschoten uitgave alleen
 * jouw deel, niets buiten budget (inkomen, interne overboekingen, terugbetalingen, sparen), en
 * een retour verlaagt de uitgave in zijn categorie. Zonder categorie telt alleen wat er netto
 * uitging, zodat inkomsten zonder categorie het totaal niet verlagen.
 */
export function tagSpend(lines: readonly TagLine[]): TagSpend {
	const sums = new Map<string | null, TagCategory>();
	for (const l of lines) {
		if (l.advanced || l.countsForBudget === false) continue;
		const key = l.categoryId;
		const entry = sums.get(key) ?? {
			categoryId: key,
			name: l.categoryName ?? 'Zonder categorie',
			group: l.categoryGroup,
			cents: 0
		};
		entry.cents -= l.amountCents;
		sums.set(key, entry);
	}
	const none = sums.get(null);
	if (none) none.cents = Math.max(0, none.cents);
	const byCategory = [...sums.values()]
		.filter((c) => c.cents !== 0)
		.sort(
			(a, b) =>
				Number(a.categoryId === null) - Number(b.categoryId === null) ||
				b.cents - a.cents ||
				a.name.localeCompare(b.name, 'nl')
		);
	return { totalCents: byCategory.reduce((s, c) => s + c.cents, 0), byCategory };
}

/** Aantal dagen van de periode, begin en eind meegeteld; een lopende tag telt tot en met vandaag. */
export function periodDays(tag: Omit<TagPeriod, 'id'>, today: string): number {
	const end = tag.endDate ?? (today > tag.startDate ? today : tag.startDate);
	const utc = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
	return Math.round((utc(end) - utc(tag.startDate)) / 86_400_000) + 1;
}

export type TagState = 'komt' | 'loopt' | 'voorbij';

export function tagState(tag: Omit<TagPeriod, 'id'>, today: string): TagState {
	if (today < tag.startDate) return 'komt';
	if (tag.endDate !== null && today > tag.endDate) return 'voorbij';
	return 'loopt';
}

/**
 * De periode in woorden: "12 okt – 19 okt", "12 okt" of "sinds 12 okt", met het jaar erachter
 * als dat niet dit jaar is.
 */
export function formatPeriod(tag: Omit<TagPeriod, 'id'>, today: string): string {
	const year = (iso: string) =>
		iso.slice(0, 4) === today.slice(0, 4) ? '' : ` ${iso.slice(0, 4)}`;
	const from = formatShortDate(tag.startDate);
	if (tag.endDate === null) return `sinds ${from}${year(tag.startDate)}`;
	if (tag.endDate === tag.startDate) return `${from}${year(tag.startDate)}`;
	const sameYear = tag.startDate.slice(0, 4) === tag.endDate.slice(0, 4);
	return `${from}${sameYear ? '' : year(tag.startDate)} – ${formatShortDate(tag.endDate)}${year(tag.endDate)}`;
}

export interface TagSegment {
	key: string;
	label: string;
	cents: number;
	/** CSS-kleur van de categoriegroep; leeg zonder categorie */
	group: string | null;
}

/**
 * Delen voor de gestapelde balk: de grootste categorieën, de rest samen als "Overig". Een
 * categorie die per saldo terugkreeg (alleen een retour) staat niet in de balk.
 */
export function tagSegments(byCategory: readonly TagCategory[], max = 5): TagSegment[] {
	const positive = byCategory.filter((c) => c.cents > 0);
	const shown = positive.length > max ? positive.slice(0, max - 1) : positive;
	const rest = positive.slice(shown.length);
	const segments = shown.map((c) => ({
		key: c.categoryId ?? 'zonder',
		label: c.name,
		cents: c.cents,
		group: c.categoryId === null ? null : (c.group ?? c.name)
	}));
	if (rest.length > 0)
		segments.push({
			key: 'overig',
			label: `Overig (${rest.length})`,
			cents: rest.reduce((s, c) => s + c.cents, 0),
			group: null
		});
	return segments;
}

/**
 * De zin onder het totaal, in Fraunces italic: hoe lang de tag duurt en wat dat per dag was.
 * Bedragen in hele euro's.
 */
export function tagSentence(tag: Omit<TagPeriod, 'id'>, totalCents: number, today: string): string {
	const state = tagState(tag, today);
	if (state === 'komt') {
		const days = periodDays({ startDate: today, endDate: tag.startDate }, today) - 1;
		return days === 1 ? 'Begint morgen.' : `Begint over ${days} dagen.`;
	}
	const days = periodDays(tag, today);
	const span = days === 1 ? '1 dag' : `${days} dagen`;
	const prefix =
		state === 'loopt' ? `Loopt nu ${span}` : span.charAt(0).toUpperCase() + span.slice(1);
	if (totalCents <= 0) return `${prefix}, nog niets uitgegeven.`;
	if (days === 1) return `${prefix}.`;
	const perDay = formatCents(Math.round(totalCents / days), { whole: true });
	return `${prefix}, gemiddeld ${perDay} per dag.`;
}
