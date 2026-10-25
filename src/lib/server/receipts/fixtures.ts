import type { ModelConfidence, ReceiptOutput } from './schema.ts';

// Verzonnen uitvoer van Haiku voor tests; geen echte bonnen of winkels.

type Field<T> = { waarde: T; zekerheid: ModelConfidence; notitie: string };

const sure = <T>(waarde: T): Field<T> => ({ waarde, zekerheid: 'zeker', notitie: '' });

export function receiptOutput(overrides: Partial<ReceiptOutput> = {}): ReceiptOutput {
	return {
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
		...overrides
	};
}

export function field<T>(waarde: T, zekerheid: ModelConfidence = 'zeker', notitie = ''): Field<T> {
	return { waarde, zekerheid, notitie };
}

/** Upload op 21 oktober 2026, 12:00 lokale tijd: één dag na de bon. */
export const NOW = new Date(2026, 9, 21, 12);
