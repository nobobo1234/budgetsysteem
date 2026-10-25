import { daysBetween } from './owed.ts';
import { amountScore, rankMatches, type MatchTarget, type Scored } from './match.ts';

// Koppellijst bij een bankimport (spec: Import en Bonnetjes en koppelen → Koppellijst). Een
// boeking van de bank wordt tegen je eigen invoer (handmatig, bon of een bevestigde verwachte
// post) gehouden, zodat niets dubbel telt. Alleen de keuze staat hier; zoeken en samenvoegen
// gebeuren in `server/import/koppellijst.ts`.

/** Zoveel dagen mag je invoer van de bankdatum afliggen; daarna telt de datum niet meer mee. */
export const MERGE_WINDOW_DAYS = 5;
/**
 * Pas vanaf "mogelijk" komt een boeking in de review-inbox. Een kandidaat die alleen
 * onwaarschijnlijk is, staat wel in de lijst, maar houdt een vergeten uitgave niet tegen.
 */
export const REVIEW_MIN = 0.4;

/** Een boeking van de bank, met teken (negatief is afgeschreven). */
export interface BankEntry {
	amountCents: number;
	date: string;
	name: string;
	iban?: string | null;
}

/** Eigen invoer met teken, zoals hij in de database staat. */
export type OwnEntry = MatchTarget;

export type MatchDecision<T extends OwnEntry> =
	/** Duidelijke voorsprong: meteen samenvoegen */
	| { kind: 'samenvoegen'; target: T; candidates: Scored<T>[] }
	/** Op te controleren met de koppellijst; `preselect` alleen bij een duidelijke voorsprong */
	| { kind: 'controleren'; candidates: Scored<T>[]; preselect: string | null }
	/** Niets dat erop lijkt: een nieuwe transactie */
	| { kind: 'nieuw'; candidates: Scored<T>[] };

/**
 * Kan deze invoer bij deze bankboeking horen? Hetzelfde teken, het bedrag binnen de marge van
 * een fooi (2% of €1) en de datum binnen vijf dagen.
 */
export function inWindow(bank: BankEntry, own: OwnEntry): boolean {
	if (bank.amountCents === 0 || own.amountCents === 0) return false;
	if (Math.sign(bank.amountCents) !== Math.sign(own.amountCents)) return false;
	if (Math.abs(daysBetween(bank.date, own.date)) > MERGE_WINDOW_DAYS) return false;
	return amountScore(bank.amountCents, own.amountCents) > 0;
}

/**
 * Kiest wat er met een bankboeking gebeurt. Samenvoegen alleen als de bovenste kandidaat
 * duidelijk voorloopt (score boven 0,9 en 0,3 voor op de tweede); anders de koppellijst met
 * hoogstens vijf kandidaten, als de beste minstens "mogelijk" is.
 */
export function decideMatch<T extends OwnEntry>(
	bank: BankEntry,
	own: readonly T[],
	{ auto = true }: { auto?: boolean } = {}
): MatchDecision<T> {
	const { candidates, preselect } = rankMatches(
		{ amountCents: Math.abs(bank.amountCents), date: bank.date, name: bank.name, iban: bank.iban },
		own.filter((o) => inWindow(bank, o))
	);
	const best = candidates[0];
	if (!best || best.score < REVIEW_MIN) return { kind: 'nieuw', candidates };
	if (auto && preselect) {
		const target = candidates.find((c) => c.target.id === preselect)!.target;
		return { kind: 'samenvoegen', target, candidates };
	}
	return { kind: 'controleren', candidates, preselect };
}

/**
 * Wat de bank anders boekte dan je invoerde, in centen: positief is meer afgeschreven (of meer
 * ontvangen) dan je dacht, zoals een fooi.
 */
export function differenceCents(bankCents: number, ownCents: number): number {
	return Math.abs(bankCents) - Math.abs(ownCents);
}
