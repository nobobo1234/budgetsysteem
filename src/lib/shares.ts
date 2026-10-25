// Gedeelde vaste lasten (spec: Gedeelde vaste lasten): aandelen, verdeling in hele centen,
// status per maand en voorstellen uit de historie. Pure functies, zonder database.

import { addDays, shiftMonth } from './dates.ts';
import { daysBetween } from './owed.ts';
import { dateInMonth, detectRecurring, monthsBetween, type HistoryItem } from './recurring.ts';

export type ShareKind = 'vast' | 'percentage';

export interface ShareTerms {
	kind: ShareKind;
	/** Vast aandeel in centen */
	amountCents: number | null;
	/** Percentage in hele basispunten: 2500 = 25% */
	basisPoints: number | null;
	startMonth: string;
	endMonth: string | null;
}

/** Hele basispunten: 100% */
export const FULL = 10_000;

/** Niet volledig binnen zoveel dagen na de verwachte ontvangstdag: te laat. */
export const LATE_AFTER_DAYS = 7;

export function isActive(share: Pick<ShareTerms, 'startMonth' | 'endMonth'>, month: string) {
	return share.startMonth <= month && (share.endMonth === null || share.endMonth >= month);
}

/**
 * Het aandeel in centen bij een bedrag van de last. Een percentage wordt naar beneden
 * afgerond op hele centen; de restcent is van jou.
 */
export function shareCents(
	share: Pick<ShareTerms, 'kind' | 'amountCents' | 'basisPoints'>,
	totalCents: number
) {
	if (share.kind === 'vast') return share.amountCents ?? 0;
	return Math.floor((Math.max(0, totalCents) * (share.basisPoints ?? 0)) / FULL);
}

/**
 * Verdeling van een afschrijving: de aandelen van de anderen en jouw deel, wat overblijft.
 * Samen altijd precies het totaal.
 */
export function splitShared(
	totalCents: number,
	shares: readonly Pick<ShareTerms, 'kind' | 'amountCents' | 'basisPoints'>[]
): { mine: number; others: number[] } {
	if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new RangeError('Ongeldig totaal');
	const others = shares.map((s) => shareCents(s, totalCents));
	return { mine: totalCents - others.reduce((s, n) => s + n, 0), others };
}

/**
 * Aandelen samen mogen niet meer zijn dan het bedrag van de last, in geen enkele maand. Het
 * hoogste totaal ligt altijd in een maand waarin een aandeel begint. Geeft de reden, of null.
 */
export function checkShares(totalCents: number, shares: readonly ShareTerms[]): string | null {
	for (const s of shares) {
		if (s.endMonth !== null && s.endMonth < s.startMonth)
			return 'De eindmaand ligt voor de startmaand';
	}
	for (const month of new Set(shares.map((s) => s.startMonth))) {
		const active = shares.filter((s) => isActive(s, month));
		const percent = active.reduce(
			(n, s) => n + (s.kind === 'percentage' ? (s.basisPoints ?? 0) : 0),
			0
		);
		if (percent > FULL) return 'Samen meer dan 100%';
		if (splitShared(totalCents, active).mine < 0)
			return 'De aandelen zijn samen meer dan het bedrag van de vaste last';
	}
	return null;
}

/** De verwachte ontvangstdag in `month`, of de laatste dag als de maand korter is. */
export function receiveDate(month: string, day: number): string {
	return dateInMonth(month, day);
}

export type MonthState = 'binnen' | 'deels' | 'open' | 'te_laat' | 'kwijtgescholden';

/** Tekst bij een vakje: de status staat er altijd in woorden, niet alleen als kleur. */
export const MONTH_STATE_LABEL: Record<MonthState | 'geen', string> = {
	binnen: 'Binnen',
	deels: 'Deels',
	open: 'Open',
	te_laat: 'Te laat',
	kwijtgescholden: 'Kwijtgescholden',
	geen: 'Geen'
};

/**
 * Status van een maandaandeel. Te laat: niet volledig binnen 7 dagen na de verwachte
 * ontvangstdag, ook als er al een deel binnen is.
 */
export function monthState(opts: {
	amountCents: number;
	paidCents: number;
	forgiven: boolean;
	dueDate: string;
	today: string;
}): MonthState {
	if (opts.forgiven) return 'kwijtgescholden';
	if (opts.paidCents >= opts.amountCents) return 'binnen';
	if (opts.today > addDays(opts.dueDate, LATE_AFTER_DAYS)) return 'te_laat';
	return opts.paidCents > 0 ? 'deels' : 'open';
}

/** De laatste `count` maanden tot en met `month`, oudste eerst. */
export function lastMonths(month: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => shiftMonth(month, i - count + 1));
}

/**
 * Voorstel voor een vast aandeel als de last duurder of goedkoper wordt: naar verhouding,
 * naar beneden afgerond op hele centen.
 */
export function proposedShareCents(oldShareCents: number, oldTotal: number, newTotal: number) {
	if (oldTotal <= 0) return oldShareCents;
	return Math.floor((oldShareCents * newTotal) / oldTotal);
}

// --- Voorstellen uit de historie ------------------------------------------------------------

export interface ShareSource {
	id: string;
	counterparty: string;
	/** Positieve centen per keer */
	medianCents: number;
	expectedDay: number;
}

export interface ShareProposal {
	counterIban: string;
	counterparty: string;
	recurringId: string;
	/** Het laatste bedrag dat binnenkwam: een vast aandeel */
	amountCents: number;
	receiveDay: number;
	/** Maand van de eerste overboeking die meetelt */
	startMonth: string;
}

/** Afstand tussen twee dagen van de maand, rond de maandwisseling (30 en 2 liggen dicht bij elkaar). */
function dayDistance(a: number, b: number): number {
	const d = Math.abs(a - b);
	return Math.min(d, 31 - d);
}

/**
 * Een inkomende overboeking die volgens de regels van Vaste lasten maandelijks terugkomt van
 * dezelfde IBAN, met een bedrag tussen 10% en 90% van een actieve maandelijkse vaste last.
 * Past hij bij meer lasten, dan de last die rond dezelfde dag afschrijft; daarna de grootste.
 */
export function detectShareProposals(
	incoming: readonly HistoryItem[],
	sources: readonly ShareSource[],
	asOf: string
): ShareProposal[] {
	// De herkenning kijkt naar uitgaande bedragen: draai het teken om
	const flipped = incoming
		.filter((t) => t.amountCents > 0 && t.counterIban)
		.map((t) => ({ ...t, amountCents: -t.amountCents }));
	const out: ShareProposal[] = [];
	for (const c of detectRecurring(flipped, asOf)) {
		if (c.interval !== 'maand' || !c.counterIban) continue;
		const fits = sources
			.filter((s) => c.medianCents * 10 >= s.medianCents && c.medianCents * 10 <= s.medianCents * 9)
			.sort(
				(a, b) =>
					dayDistance(a.expectedDay, c.expectedDay) - dayDistance(b.expectedDay, c.expectedDay) ||
					b.medianCents - a.medianCents
			);
		const best = fits[0];
		if (!best) continue;
		const lastMonth = c.lastDate.slice(0, 7);
		out.push({
			counterIban: c.counterIban,
			counterparty: c.counterparty,
			recurringId: best.id,
			amountCents: c.lastCents,
			receiveDay: c.expectedDay,
			startMonth: shiftMonth(lastMonth, -(c.count - 1))
		});
	}
	return out;
}

/** Hoe lang een maandaandeel al te laat is, in dagen na de verwachte ontvangstdag. */
export function daysLate(dueDate: string, today: string): number {
	return Math.max(0, daysBetween(dueDate, today));
}

/** Maanden van `from` tot en met `to`, oudste eerst. */
export function monthsFrom(from: string, to: string): string[] {
	const n = monthsBetween(from, to);
	return n < 0 ? [] : Array.from({ length: n + 1 }, (_, i) => shiftMonth(from, i));
}

/**
 * Melding na een nieuw IBAN: "3 betalingen van Sanne gekoppeld · 1 paste niet, koppel die zelf".
 * Niets gevonden: geen melding over betalingen.
 */
export function ibanLinkText(name: string, linked: number, unmatched: number): string | null {
	const payments = (n: number) => `${n} ${n === 1 ? 'betaling' : 'betalingen'} van ${name}`;
	const rest = (n: number) =>
		n === 1 ? 'paste niet, koppel die zelf' : 'pasten niet, koppel ze zelf';
	if (linked > 0 && unmatched > 0)
		return `${payments(linked)} gekoppeld · ${unmatched} ${rest(unmatched)}`;
	if (linked > 0) return `${payments(linked)} gekoppeld`;
	if (unmatched > 0) return `${payments(unmatched)} ${rest(unmatched)}`;
	return null;
}
