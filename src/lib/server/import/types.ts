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
	/** Terugboeking volgens de bank (CAMT.053 `RvslInd`), zoals een gestorneerde incasso */
	reversal?: boolean;
	/** End-to-end-kenmerk van de betaling; een storno draagt dat van de oorspronkelijke boeking */
	endToEndId?: string | null;
}

/**
 * Saldo van een eigen rekening volgens het bankbestand, vlak vóór de eerste boeking erin.
 * De saldocheck gebruikt het als startsaldo (anker); zie `src/lib/balance.ts`.
 */
export interface OpeningBalance {
	/** Zoals bij `ImportRecord`: leeg met `accountKind` als de export geen IBAN noemt */
	accountIban: string;
	accountKind?: 'revolut';
	/** Datum van de eerste boeking in het bestand; het saldo geldt aan het begin van die dag */
	firstDate: string;
	amountCents: number;
}

/** Wat een parser uit een bankbestand haalt. Een saldo alleen als het bestand het noemt én het klopt. */
export interface ParsedBankFile {
	records: ImportRecord[];
	balances: OpeningBalance[];
}

/** Startsaldo = saldo na de laatste boeking min alle boekingen; per rekening, met de vroegste datum. */
export function openingFromClosing(
	records: ImportRecord[],
	closing: number,
	key: Pick<OpeningBalance, 'accountIban' | 'accountKind'>
): OpeningBalance | null {
	const own = records.filter(
		(r) => r.accountIban === key.accountIban && r.accountKind === key.accountKind
	);
	if (own.length === 0) return null;
	const firstDate = own.reduce((min, r) => (r.date < min ? r.date : min), own[0]!.date);
	const total = own.reduce((sum, r) => sum + r.amountCents, 0);
	return { ...key, firstDate, amountCents: closing - total };
}

export class ImportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ImportError';
	}
}

/** Bestanden boven 20 MB weigeren we (spec: Import). */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
