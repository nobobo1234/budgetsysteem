import type { MatchLabel, MatchQuery } from '../../match.ts';
import type { FieldStatus } from './checks.ts';
import type { StoredFields } from './stored.ts';

// Wat er met een gelezen bon gebeurt (spec: Bonnetjes en koppelen, Verwerking stap 5 en
// Koppellijst). Pure logica, zodat de regels zonder database te testen zijn.
//
// | Uitkomst    | Koppellijst                         | Gevolg                                        |
// | zeker       | duidelijke voorloper (voorselectie) | gekoppeld aan die transactie, klaar           |
// | zeker       | geen waarschijnlijke of mogelijke   | nieuwe transactie (bron bon), klaar           |
// | zeker       | wel kandidaten, geen voorloper      | review-inbox: kies zelf (nooit gokken)        |
// | controleren | als zeker                           | verwerkt, maar blijft gemarkeerd in de inbox  |
// | onzeker     | —                                   | review-inbox, er wordt niets geboekt          |
//
// Een nieuwe transactie uit een bon met "controleren" staat op te controleren; een bestaande
// transactie die gekoppeld wordt, blijft zoals hij was.

export type ReceiptPlan =
	| { action: 'koppelen'; transactionId: string; handled: boolean }
	| { action: 'nieuw'; handled: boolean; status: 'bevestigd' | 'te_controleren' }
	| { action: 'inbox'; reason: 'onzeker' | 'kiezen' | 'lijst' };

export interface RankedCandidates {
	candidates: readonly { label: MatchLabel }[];
	preselect: string | null;
}

/** De vraag voor de koppellijst, of `null` als een veld ontbreekt dat de lijst nodig heeft. */
export function matchQueryFor(fields: StoredFields): MatchQuery | null {
	if (fields.totalCents === null || fields.totalCents <= 0 || fields.date === null) return null;
	return { amountCents: fields.totalCents, date: fields.date, name: fields.store ?? '' };
}

/** Of een bon genoeg velden heeft om er een transactie van te maken. */
export function isComplete(fields: StoredFields): boolean {
	return (
		fields.store !== null &&
		fields.store.trim() !== '' &&
		fields.date !== null &&
		fields.totalCents !== null &&
		fields.totalCents > 0 &&
		fields.currency !== null
	);
}

/**
 * Bepaalt wat de worker automatisch doet. Alleen zeker en controleren worden verwerkt, en alleen
 * als de koppellijst geen twijfel laat: een duidelijke voorloper, of helemaal niets dat erop
 * lijkt. Bij twijfel komt de bon in de review-inbox om zelf te kiezen.
 */
export function planReceipt(
	outcome: FieldStatus,
	fields: StoredFields,
	ranked: RankedCandidates
): ReceiptPlan {
	if (outcome === 'onzeker' || !isComplete(fields)) return { action: 'inbox', reason: 'onzeker' };
	const handled = outcome === 'zeker';
	if (ranked.preselect !== null) {
		return { action: 'koppelen', transactionId: ranked.preselect, handled };
	}
	const plausible = ranked.candidates.some((c) => c.label !== 'onwaarschijnlijk');
	if (plausible) return { action: 'inbox', reason: 'kiezen' };
	return { action: 'nieuw', handled, status: handled ? 'bevestigd' : 'te_controleren' };
}

/** De waarde van een bon na verwerken: de status in de inbox en wat er op het scherm staat. */
export type ReceiptStage =
	| 'wordt_gelezen'
	/** Gelezen en verwerkt, niets meer te doen */
	| 'klaar'
	/** Verwerkt, maar je moet hem nog nakijken (controleren) */
	| 'nakijken'
	/** Gelezen, maar je kiest zelf de koppeling (zeker of controleren zonder duidelijke voorloper) */
	| 'kiezen'
	/** Haiku twijfelt: velden nakijken, dan verwerken */
	| 'onzeker'
	/** Niet te lezen: zelf invullen of opnieuw proberen */
	| 'fout'
	/** Een screenshot met transacties: aanvinken en in één keer bevestigen */
	| 'lijst';

export function receiptStage(r: {
	status: 'wordt_gelezen' | FieldStatus | 'fout';
	kind?: 'bon' | 'lijst';
	transactionId: string | null;
	handledAt: string | null;
}): ReceiptStage {
	if (r.status === 'wordt_gelezen') return 'wordt_gelezen';
	if (r.handledAt !== null) return 'klaar';
	if (r.status === 'fout') return 'fout';
	if (r.kind === 'lijst') return 'lijst';
	if (r.status === 'onzeker') return r.transactionId === null ? 'onzeker' : 'nakijken';
	return r.transactionId === null ? 'kiezen' : 'nakijken';
}

// Een screenshot met transacties (spec: Verwerking stap 6) boekt nooit vanzelf: hij komt als
// lijst om in één keer te bevestigen. Per transactie de koppellijst; wat al in je cijfers staat
// (een geïmporteerde boeking, of eigen invoer) wordt gekoppeld in plaats van dubbel geboekt.
//
// | Transactie                          | Voorstel                      | Aangevinkt         |
// | datum, naam, bedrag of valuta mist  | onvolledig, niet te boeken    | nee                |
// | duidelijke voorloper                | koppelen aan die transactie   | ja                 |
// | kandidaten zonder voorloper         | zelf kiezen                   | nee                |
// | niets dat erop lijkt                | nieuwe transactie (bron bon)  | ja, behalve onzeker |
//
// Twee transacties op hetzelfde screenshot worden nooit aan dezelfde transactie gekoppeld: de
// tweede moet je dan zelf kiezen.

export interface ListItemInput {
	date: string | null;
	counterparty: string | null;
	amountCents: number | null;
	currency: string | null;
	outcome: FieldStatus;
	ranked: RankedCandidates;
}

export type ItemPlan =
	| { action: 'koppelen'; transactionId: string; checked: true }
	| { action: 'nieuw'; checked: boolean }
	| { action: 'kiezen'; checked: false }
	| { action: 'onvolledig'; checked: false };

/** Of een transactie van een screenshot genoeg velden heeft om te boeken. */
export function isItemComplete(item: Omit<ListItemInput, 'outcome' | 'ranked'>): boolean {
	return (
		item.date !== null &&
		item.counterparty !== null &&
		item.counterparty.trim() !== '' &&
		item.amountCents !== null &&
		item.amountCents !== 0 &&
		item.currency !== null
	);
}

export function planListItems(items: readonly ListItemInput[]): ItemPlan[] {
	const taken = new Set<string>();
	return items.map((item): ItemPlan => {
		if (!isItemComplete(item)) return { action: 'onvolledig', checked: false };
		const { preselect, candidates } = item.ranked;
		if (preselect !== null && !taken.has(preselect)) {
			taken.add(preselect);
			return { action: 'koppelen', transactionId: preselect, checked: true };
		}
		if (preselect !== null || candidates.some((c) => c.label !== 'onwaarschijnlijk')) {
			return { action: 'kiezen', checked: false };
		}
		return { action: 'nieuw', checked: item.outcome !== 'onzeker' };
	});
}
