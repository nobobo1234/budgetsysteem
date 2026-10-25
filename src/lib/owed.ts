// Voorschieten en terugkrijgen in hele centen (spec: Nog te krijgen). Pure functies, zodat de
// snelinvoer in de browser en de server precies hetzelfde rekenen.

export interface Share {
	/** Jouw deel; telt in de categorie van de uitgave */
	mine: number;
	/** Per ander, in de volgorde waarin je ze noemde */
	others: number[];
}

/**
 * Gelijk verdelen. Het aantal is altijd inclusief jou. Jouw deel is het totaal gedeeld door het
 * aantal, naar beneden afgerond; de rest gaat gelijk over de anderen, met de restcenten één voor
 * één naar de anderen in genoemde volgorde. €10 voor 3: jij 333, de anderen 334 en 333.
 */
export function splitEqually(totalCents: number, people: number): Share {
	if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new RangeError('Ongeldig totaal');
	if (!Number.isInteger(people) || people < 1) throw new RangeError('Ongeldig aantal personen');
	const mine = Math.floor(totalCents / people);
	const n = people - 1;
	if (n === 0) return { mine: totalCents, others: [] };
	const rest = totalCents - mine;
	const base = Math.floor(rest / n);
	const extra = rest - base * n;
	return { mine, others: Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0)) };
}

/**
 * Bedrag per persoon: jouw deel is wat overblijft. Samen meer dan het totaal wordt geweigerd;
 * jouw deel mag nul zijn, niet negatief. Elk ander bedrag is minstens één cent.
 */
export function splitByAmounts(
	totalCents: number,
	amounts: readonly number[]
): { ok: true; share: Share } | { ok: false; reason: string } {
	if (!Number.isSafeInteger(totalCents) || totalCents < 0)
		return { ok: false, reason: 'Ongeldig totaal' };
	if (amounts.length === 0) return { ok: false, reason: 'Kies minstens één persoon' };
	let sum = 0;
	for (const a of amounts) {
		if (!Number.isSafeInteger(a) || a <= 0)
			return { ok: false, reason: 'Elk bedrag moet groter dan nul zijn' };
		sum += a;
	}
	if (sum > totalCents) return { ok: false, reason: 'Samen meer dan het totaal' };
	return { ok: true, share: { mine: totalCents - sum, others: [...amounts] } };
}

export interface OpenItem {
	id: string;
	/** Wat er nog openstaat, in centen */
	outstandingCents: number;
}

export interface Allocation {
	allocations: { id: string; cents: number }[];
	/** Wat overblijft: tegoed voor de volgende post */
	creditCents: number;
}

/**
 * Verdeelt een betaling over openstaande posten in de gegeven volgorde (de aanroeper sorteert:
 * een gekozen post eerst, daarna oudste eerst). Wat overblijft is tegoed.
 */
export function allocatePayment(amountCents: number, items: readonly OpenItem[]): Allocation {
	if (!Number.isSafeInteger(amountCents) || amountCents < 0)
		throw new RangeError('Ongeldig bedrag');
	let left = amountCents;
	const allocations: Allocation['allocations'] = [];
	for (const item of items) {
		if (left === 0) break;
		if (item.outstandingCents <= 0) continue;
		const cents = Math.min(left, item.outstandingCents);
		allocations.push({ id: item.id, cents });
		left -= cents;
	}
	return { allocations, creditCents: left };
}

export type OwedStatus = 'open' | 'deels' | 'betaald' | 'kwijtgescholden';

/** Status van een post uit wat erop betaald is. Kwijtschelden blijft staan tot je het terugdraait. */
export function owedStatus(amountCents: number, paidCents: number, forgiven = false): OwedStatus {
	if (forgiven) return 'kwijtgescholden';
	if (paidCents >= amountCents) return 'betaald';
	if (paidCents > 0) return 'deels';
	return 'open';
}

/** Na zoveel dagen open komt een post in de herinnering (review-inbox en later een pushmelding). */
export const REMIND_AFTER_DAYS = 14;

/** Hele dagen tussen twee datums (`YYYY-MM-DD`), los van zomertijd. */
export function daysBetween(from: string, to: string): number {
	const utc = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
	return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** "vandaag", "1 dag", "3 weken": hoe lang een post al openstaat. */
export function formatOpenFor(days: number): string {
	if (days <= 0) return 'vandaag';
	if (days === 1) return '1 dag';
	if (days < 14) return `${days} dagen`;
	if (days < 60) return `${Math.floor(days / 7)} weken`;
	const months = Math.floor(days / 30);
	return months === 1 ? '1 maand' : `${months} maanden`;
}

/** Hoe ver een post richting de herinnering is: 0 vandaag, 1 vanaf 14 dagen open. */
export function remindProgress(daysOpen: number): number {
	return Math.max(0, Math.min(1, daysOpen / REMIND_AFTER_DAYS));
}

/**
 * Tekst om iemand te herinneren via het deelmenu (Web Share). Alleen de naam, wat het was en
 * het bedrag; de app stuurt zelf niets.
 */
export function reminderText(
	name: string,
	posts: readonly { description: string; outstandingCents: number; tikkieUrl: string | null }[],
	format: (cents: number) => string
): string {
	const total = posts.reduce((s, p) => s + p.outstandingCents, 0);
	const what = posts
		.map((p) => p.description.trim())
		.filter(Boolean)
		.slice(0, 3);
	const forWhat =
		what.length === 0
			? ''
			: ` voor ${what.length === 1 ? what[0] : `${what.slice(0, -1).join(', ')} en ${what.at(-1)}`}`;
	const tikkie = posts.find((p) => p.tikkieUrl)?.tikkieUrl;
	return `Hoi ${name}, je moet me nog ${format(total)}${forWhat}.${tikkie ? ` Tikkie: ${tikkie}` : ''}`;
}
