// Terugboekingen en retouren (spec: Terugboekingen en retouren). Pure functies in hele centen,
// zodat de snelinvoer in de browser en de server hetzelfde rekenen.

/** Hoe een retour van een voorgeschoten uitgave over de delen gaat. */
export type CorrectionMode = 'verhouding' | 'mijn_deel';

/**
 * Wat er nog terug kan op een boeking: het oorspronkelijke bedrag min de terugboekingen die er
 * al aan gekoppeld zijn. Nooit onder nul.
 */
export function correctionRoom(originalCents: number, existingCents: readonly number[]): number {
	const used = existingCents.reduce((sum, c) => sum + Math.abs(c), 0);
	return Math.max(0, Math.abs(originalCents) - used);
}

/**
 * Of een boeking een terugboeking op het origineel kan zijn: het tegengestelde teken, niet nul,
 * en samen met de eerdere terugboekingen nooit meer dan het oorspronkelijke bedrag.
 */
export function checkCorrection(
	originalCents: number,
	correctionCents: number,
	existingCents: readonly number[] = []
): { ok: true } | { ok: false; reason: string } {
	if (!Number.isSafeInteger(originalCents) || !Number.isSafeInteger(correctionCents))
		return { ok: false, reason: 'Ongeldig bedrag' };
	if (originalCents === 0 || correctionCents === 0)
		return { ok: false, reason: 'Een terugboeking op nul kan niet' };
	if (Math.sign(originalCents) === Math.sign(correctionCents))
		return { ok: false, reason: 'Een terugboeking gaat de andere kant op dan het origineel' };
	if (Math.abs(correctionCents) > correctionRoom(originalCents, existingCents))
		return { ok: false, reason: 'Samen meer terug dan het oorspronkelijke bedrag' };
	return { ok: true };
}

export interface ShareState {
	/** Wat jouw deel nu nog is, positief */
	mineCents: number;
	/** Per ander wat diens aandeel nu nog is, positief, in vaste volgorde */
	othersCents: readonly number[];
}

export interface Distribution {
	/** Wat er van jouw deel afgaat */
	mine: number;
	/** Wat er per ander van het aandeel afgaat, in dezelfde volgorde */
	others: number[];
}

/** `floor(a * b / c)` zonder afrondfouten: bedragen tot een miljoen euro passen niet in een double. */
function mulDiv(a: number, b: number, c: number): number {
	return Number((BigInt(a) * BigInt(b)) / BigInt(c));
}

/** Verdeelt resterende centen één voor één over de anderen in volgorde, tot hun aandeel vol is. */
function spreadRest(rest: number, others: number[], caps: readonly number[]): number {
	let left = rest;
	while (left > 0) {
		let moved = false;
		for (let i = 0; i < others.length && left > 0; i++) {
			if (others[i]! < caps[i]!) {
				others[i]!++;
				left--;
				moved = true;
			}
		}
		if (!moved) break;
	}
	return left;
}

/**
 * Hoe een terugboeking over jouw deel en de aandelen van anderen gaat (spec: Retour van een
 * voorgeschoten uitgave).
 *
 * - `verhouding`: elk deel naar verhouding lager. De aandelen van de anderen naar beneden
 *   afgerond, de restcent naar jouw deel. Past die niet meer in jouw deel, dan gaat hij één voor
 *   één naar de anderen.
 * - `mijn_deel`: eerst van jouw deel, dat niet onder nul gaat; wat overblijft naar verhouding over
 *   de anderen, met de restcenten één voor één in volgorde.
 *
 * Geeft null als het bedrag niet in de delen past.
 */
export function distributeCorrection(
	amountCents: number,
	state: ShareState,
	mode: CorrectionMode = 'verhouding'
): Distribution | null {
	const { mineCents, othersCents } = state;
	if (!Number.isSafeInteger(amountCents) || amountCents < 0)
		throw new RangeError('Ongeldig bedrag');
	if (![mineCents, ...othersCents].every((c) => Number.isSafeInteger(c) && c >= 0))
		throw new RangeError('Ongeldig aandeel');
	const othersTotal = othersCents.reduce((s, c) => s + c, 0);
	if (amountCents > mineCents + othersTotal) return null;

	if (mode === 'mijn_deel') {
		const mine = Math.min(amountCents, mineCents);
		const rest = amountCents - mine;
		if (rest === 0) return { mine, others: othersCents.map(() => 0) };
		const others = othersCents.map((c) => mulDiv(rest, c, othersTotal));
		const left = spreadRest(rest - others.reduce((s, c) => s + c, 0), others, othersCents);
		return left === 0 ? { mine, others } : null;
	}

	const total = mineCents + othersTotal;
	if (total === 0) return amountCents === 0 ? { mine: 0, others: othersCents.map(() => 0) } : null;
	const others = othersCents.map((c) => mulDiv(amountCents, c, total));
	let mine = amountCents - others.reduce((s, c) => s + c, 0);
	if (mine > mineCents) {
		const left = spreadRest(mine - mineCents, others, othersCents);
		if (left > 0) return null;
		mine = mineCents;
	}
	return { mine, others };
}

/**
 * Wat een deel van een retour met de post van een ander doet: het dekt wat er nog openstaat, en
 * heeft iemand al meer betaald dan het nieuwe aandeel, dan wordt het verschil "te betalen".
 */
export function postEffect(
	partCents: number,
	outstandingCents: number
): { coverCents: number; payBackCents: number } {
	const coverCents = Math.min(partCents, Math.max(0, outstandingCents));
	return { coverCents, payBackCents: partCents - coverCents };
}

/** Bij een verdeling over categorieën gaat de terugboeking standaard af van het grootste deel. */
export function largestSplit<T extends { amountCents: number }>(splits: readonly T[]): T | null {
	let best: T | null = null;
	for (const s of splits)
		if (!best || Math.abs(s.amountCents) > Math.abs(best.amountCents)) best = s;
	return best;
}

/** Hoe ver terug de koppellijst zoekt naar de uitgave bij een retour. */
export const REFUND_WINDOW_DAYS = 60;
