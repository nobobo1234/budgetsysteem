export type ImportFormat = 'camt053' | 'csv' | 'revolut';

/** Eén boeking uit een bankbestand, voordat hij in de database komt. */
export interface ImportRecord {
	/** IBAN van je eigen rekening; leeg als de export er geen noemt (Revolut) */
	accountIban: string;
	/** Zonder IBAN: koppel aan de rekening van deze soort */
	accountKind?: 'revolut';
	date: string;
	/** Negatief is afgeschreven */
	amountCents: number;
	counterparty: string;
	counterIban: string | null;
	description: string;
	/** Unieke referentie van de bank, als die er is */
	bankReference: string | null;
	/** Volgens de bank zelf een eigen overboeking, zoals opwaarderen bij Revolut */
	internal?: boolean;
	/** Bedrag in vreemde valuta; `amountCents` is dan omgerekend naar euro */
	origAmountCents?: number;
	origCurrency?: string;
	/** Het eurobedrag is geschat en moet nagekeken worden */
	needsReview?: boolean;
}

export class ImportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ImportError';
	}
}

/** Bestanden boven 20 MB weigeren we (spec: Import). */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
