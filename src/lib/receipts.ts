import { centsToInput, formatCents } from './money.ts';

// Teksten voor bonnen in de interface: Bonnen, Bon en de groep in Te controleren.

export type ReceiptStage = 'wordt_gelezen' | 'klaar' | 'nakijken' | 'kiezen' | 'onzeker' | 'fout';
export type ReceiptFieldName = 'winkel' | 'datum' | 'totaal' | 'valuta' | 'betaalwijze';

/** Korte stand, zoals in een lijst. */
export const STAGE_TEXT: Record<ReceiptStage, string> = {
	wordt_gelezen: 'Wordt gelezen',
	klaar: 'Verwerkt',
	nakijken: 'Even nakijken',
	kiezen: 'Kies de transactie',
	onzeker: 'Te controleren',
	fout: 'Niet te lezen'
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

/** "de datum", "de datum en het totaal", "de winkel, de datum en het totaal" */
export function fieldList(fields: readonly ReceiptFieldName[]): string {
	const words = fields.map((f) => FIELD_TEXT[f]);
	if (words.length <= 1) return words[0] ?? '';
	return `${words.slice(0, -1).join(', ')} en ${words.at(-1)}`;
}

/** Bedrag van de bon: in euro's als gewoon bedrag, anders met de valutacode ervoor. */
export function receiptAmount(cents: number | null, currency: string | null): string {
	if (cents === null) return '';
	return currency === null || currency === 'EUR'
		? formatCents(cents)
		: `${currency} ${centsToInput(cents)}`;
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
	}
}
