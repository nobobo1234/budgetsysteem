import { centsToInput, formatCents } from './money.ts';

// Teksten voor bonnen in de interface: Bonnen, Bon en de groep in Te controleren.

export type ReceiptStage =
	'wordt_gelezen' | 'klaar' | 'nakijken' | 'kiezen' | 'onzeker' | 'fout' | 'lijst';
export type ReceiptFieldName = 'winkel' | 'datum' | 'totaal' | 'valuta' | 'betaalwijze';

/** Korte stand, zoals in een lijst. */
export const STAGE_TEXT: Record<ReceiptStage, string> = {
	wordt_gelezen: 'Wordt gelezen',
	klaar: 'Verwerkt',
	nakijken: 'Even nakijken',
	kiezen: 'Kies de transactie',
	onzeker: 'Te controleren',
	fout: 'Niet te lezen',
	lijst: 'Lijst bevestigen'
};

/** Vraagt de stand iets van je (oranje stip in een lijst)? */
export const needsYou = (stage: ReceiptStage) => stage !== 'klaar' && stage !== 'wordt_gelezen';

const FIELD_TEXT: Record<ReceiptFieldName, string> = {
	winkel: 'de winkel',
	datum: 'de datum',
	totaal: 'het totaal',
	valuta: 'de valuta',
	betaalwijze: 'de betaalwijze'
};

function joinWords(words: readonly string[]): string {
	if (words.length <= 1) return words[0] ?? '';
	return `${words.slice(0, -1).join(', ')} en ${words.at(-1)}`;
}

/** "de datum", "de datum en het totaal", "de winkel, de datum en het totaal" */
export function fieldList(fields: readonly ReceiptFieldName[]): string {
	return joinWords(fields.map((f) => FIELD_TEXT[f]));
}

/** Velden van een transactie op een screenshot. */
export type ItemFieldName = 'datum' | 'tegenpartij' | 'bedrag' | 'valuta';

const ITEM_FIELD_TEXT: Record<ItemFieldName, string> = {
	datum: 'de datum',
	tegenpartij: 'de naam',
	bedrag: 'het bedrag',
	valuta: 'de valuta'
};

/** "het bedrag", "de datum en de naam" */
export function itemFieldList(fields: readonly ItemFieldName[]): string {
	return joinWords(fields.map((f) => ITEM_FIELD_TEXT[f]));
}

/** Bedrag van de bon: in euro's als gewoon bedrag, anders met de valutacode ervoor. */
export function receiptAmount(cents: number | null, currency: string | null): string {
	if (cents === null) return '';
	return currency === null || currency === 'EUR'
		? formatCents(cents)
		: `${currency} ${centsToInput(cents)}`;
}

/** Bedrag met teken, zoals in een lijst van een screenshot: `−€ 12,50`, `+USD 20,00`. */
export function signedAmount(cents: number, currency: string | null): string {
	if (currency === null || currency === 'EUR') return formatCents(cents, { sign: true });
	return `${cents < 0 ? '−' : '+'}${currency} ${centsToInput(cents)}`;
}

/** Eén zin over de stand, voor onder de kop van een bon. */
export function stageSentence(stage: ReceiptStage, doubt: readonly ReceiptFieldName[]): string {
	switch (stage) {
		case 'wordt_gelezen':
			return 'Haiku leest de bon; dat duurt meestal een paar seconden.';
		case 'klaar':
			return 'Gelezen en verwerkt.';
		case 'nakijken':
			return doubt.length > 0
				? `Verwerkt, maar Haiku twijfelde over ${fieldList(doubt)}. Klopt het?`
				: 'Verwerkt; kijk hem nog even na.';
		case 'kiezen':
			return 'Gelezen. Er zijn transacties die erbij kunnen horen; kies zelf.';
		case 'onzeker':
			return doubt.length > 0
				? `Haiku twijfelt over ${fieldList(doubt)}. Kijk het na en verwerk hem.`
				: 'Kijk de bon na en verwerk hem.';
		case 'fout':
			return 'Deze bon kon niet gelezen worden. Vul hem zelf in of probeer het opnieuw.';
		case 'lijst':
			return 'Een screenshot met transacties. Vink aan wat erbij hoort en bevestig; er is nog niets geboekt.';
	}
}

/** "1 transactie", "4 transacties" */
export const itemCountText = (n: number) => `${n} ${n === 1 ? 'transactie' : 'transacties'}`;
