import type { ModelConfidence, ReceiptOutput } from './schema.ts';

// Verzonnen uitvoer van Haiku voor tests; geen echte bonnen of winkels.

type Field<T> = { waarde: T; zekerheid: ModelConfidence; notitie: string };

const sure = <T>(waarde: T): Field<T> => ({ waarde, zekerheid: 'zeker', notitie: '' });

export function receiptOutput(overrides: Partial<ReceiptOutput> = {}): ReceiptOutput {
	return {
		beeld: 'bon',
		winkel: sure('Supermarkt Voorbeeld 0001'),
		datum: sure('2026-10-20'),
		totaal: sure('7.37'),
		valuta: sure('EUR'),
		betaalwijze: sure('pin'),
		regels: [
			{ omschrijving: 'Brood', bedrag: '2.49', soort: 'artikel' },
			{ omschrijving: 'Melk', bedrag: '1.19', soort: 'artikel' },
			{ omschrijving: 'Kaas', bedrag: '4.29', soort: 'artikel' },
			{ omschrijving: 'Bonus kaas', bedrag: '-0.75', soort: 'bonus' },
			{ omschrijving: 'Statiegeld', bedrag: '0.15', soort: 'statiegeld' }
		],
		transacties: [],
		...overrides
	};
}

type ListItem = ReceiptOutput['transacties'][number];

/** Eén transactie in een screenshot, zeker gelezen. */
export function listItem(
	datum: string,
	tegenpartij: string,
	bedrag: string,
	valuta = 'EUR'
): ListItem {
	return {
		datum: sure(datum),
		tegenpartij: sure(tegenpartij),
		bedrag: sure(bedrag),
		valuta: sure(valuta)
	};
}

/** Een screenshot van een bankapp: de bonvelden leeg, de transacties in de lijst. */
export function listOutput(items: ListItem[]): ReceiptOutput {
	const empty = { waarde: '', zekerheid: 'onleesbaar' as const, notitie: '' };
	return {
		beeld: 'lijst',
		winkel: empty,
		datum: empty,
		totaal: empty,
		valuta: empty,
		betaalwijze: { waarde: '', zekerheid: 'onleesbaar', notitie: '' },
		regels: [],
		transacties: items
	};
}

export function field<T>(waarde: T, zekerheid: ModelConfidence = 'zeker', notitie = ''): Field<T> {
	return { waarde, zekerheid, notitie };
}

/** Upload op 21 oktober 2026, 12:00 lokale tijd: één dag na de bon. */
export const NOW = new Date(2026, 9, 21, 12);
