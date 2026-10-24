import { isValidDate } from '../../dates.ts';
import { parseDecimal } from '../../money.ts';
import { normalizeIban } from '../../text.ts';
import { counterpartyOrMerchant } from './card.ts';
import { ImportError, MAX_IMPORT_BYTES, type ImportRecord } from './types.ts';

// Terugvaloptie: de CSV-download van Mijn SNS. Kolommen volgens "Uitleg transactieoverzicht in
// Mijn SNS" (2025). Oudere exports hebben drie extra adreskolommen; die herkennen we aan het aantal.

/** RFC 4180-achtige parser: aanhalingstekens, verdubbelde aanhalingstekens, CRLF. Lineair. */
export function parseCsv(text: string, delimiter: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += ch;
		} else if (ch === '"' && field.length === 0) {
			quoted = true;
		} else if (ch === delimiter) {
			row.push(field);
			field = '';
		} else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && text[i + 1] === '\n') i++;
			row.push(field);
			field = '';
			if (row.some((f) => f.length > 0)) rows.push(row);
			row = [];
		} else field += ch;
	}
	row.push(field);
	if (row.some((f) => f.length > 0)) rows.push(row);
	return rows;
}

function detectDelimiter(firstLine: string): string {
	let commas = 0;
	let semicolons = 0;
	let quoted = false;
	for (const ch of firstLine) {
		if (ch === '"') quoted = !quoted;
		else if (!quoted && ch === ',') commas++;
		else if (!quoted && ch === ';') semicolons++;
	}
	return semicolons > commas ? ';' : ',';
}

/** `25-3-2025` of `25-03-2025` naar ISO. */
function snsDate(s: string): string | null {
	const parts = s.trim().split('-');
	if (parts.length !== 3) return null;
	const [d, m, y] = parts.map(Number) as [number, number, number];
	if (!isValidDate(y, m, d)) return null;
	return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

interface Layout {
	date: number;
	account: number;
	counterIban: number;
	name: number;
	amount: number;
	sequence: number;
	description: number;
}

// Nieuwe layout (17 kolommen): Datum, Je rekening, Van/naar, Naam, Valuta saldo,
// Saldo voor boeking, Valuta boeking, Bedrag bij/af, Verwerkingsdatum, Valutadatum, Code, Type,
// Volgnummer, Betalingskenmerk, Omschrijving, Afschriftnummer, Categorie.
const LAYOUT_17: Layout = {
	date: 0,
	account: 1,
	counterIban: 2,
	name: 3,
	amount: 7,
	sequence: 12,
	description: 14
};
// Oude layout (19 kolommen): met adres, postcode en plaats na de naam.
const LAYOUT_19: Layout = {
	date: 0,
	account: 1,
	counterIban: 2,
	name: 3,
	amount: 10,
	sequence: 15,
	description: 17
};

const HEADER_NAMES: Record<keyof Layout, string[]> = {
	date: ['datum', 'boekdatum'],
	account: ['je rekening', 'rekening'],
	counterIban: ['van / naar', 'van/naar', 'tegenrekening'],
	name: ['naam', 'naam tegenrekening'],
	amount: ['bedrag bij/af', 'bedrag'],
	sequence: ['volgnummer'],
	description: ['omschrijving']
};

function layoutFromHeader(header: string[]): Layout | null {
	const lower = header.map((h) => h.trim().toLowerCase());
	const out: Partial<Layout> = {};
	for (const [key, names] of Object.entries(HEADER_NAMES) as [keyof Layout, string[]][]) {
		const idx = lower.findIndex((h) => names.includes(h));
		if (idx === -1) return null;
		out[key] = idx;
	}
	return out as Layout;
}

export function parseSnsCsv(text: string): ImportRecord[] {
	if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) {
		throw new ImportError('Het bestand is groter dan 20 MB.');
	}
	const clean = text.startsWith('\uFEFF') ? text.slice(1) : text;
	const firstLine = clean.slice(0, clean.search(/\r?\n|$/));
	const rows = parseCsv(clean, detectDelimiter(firstLine));
	if (rows.length === 0) throw new ImportError('Het bestand is leeg.');

	let layout: Layout | null = null;
	let body = rows;
	if (!snsDate(rows[0]![0] ?? '')) {
		layout = layoutFromHeader(rows[0]!);
		if (!layout) throw new ImportError('Onbekende CSV-kolommen; gebruik bij voorkeur CAMT.053.');
		body = rows.slice(1);
	}

	const records: ImportRecord[] = [];
	for (const row of body) {
		const l = layout ?? (row.length >= 19 ? LAYOUT_19 : row.length >= 17 ? LAYOUT_17 : null);
		if (!l) throw new ImportError('Onbekende CSV-indeling; gebruik bij voorkeur CAMT.053.');
		const date = snsDate(row[l.date] ?? '');
		const amount = parseDecimal((row[l.amount] ?? '').replace(',', '.'));
		const accountIban = normalizeIban(row[l.account] ?? '');
		if (!date || amount === null || !accountIban) {
			throw new ImportError('Een regel in de CSV heeft geen geldige datum, rekening of bedrag.');
		}
		const sequence = (row[l.sequence] ?? '').trim();
		const counterIban = normalizeIban(row[l.counterIban] ?? '');
		const description = (row[l.description] ?? '').trim().slice(0, 500);
		records.push({
			accountIban,
			date,
			amountCents: amount,
			// Zelfde terugval als bij CAMT: een pinbetaling zonder naam krijgt de winkel als tegenpartij
			counterparty: counterpartyOrMerchant((row[l.name] ?? '').trim(), description).slice(0, 140),
			counterIban: counterIban || null,
			description,
			bankReference: sequence ? `${accountIban}:${sequence}` : null
		});
	}
	return records;
}
