/** Eén boeking uit een bankbestand, voordat hij in de database komt. */
export interface ImportRecord {
	/** IBAN van je eigen rekening */
	accountIban: string;
	date: string;
	/** Negatief is afgeschreven */
	amountCents: number;
	counterparty: string;
	counterIban: string | null;
	description: string;
	/** Unieke referentie van de bank, als die er is */
	bankReference: string | null;
}

export class ImportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ImportError';
	}
}

/** Bestanden boven 20 MB weigeren we (spec: Import). */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
