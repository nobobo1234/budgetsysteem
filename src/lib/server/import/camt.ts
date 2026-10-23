import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { isIsoDate } from '../../dates.ts';
import { parseDecimal } from '../../money.ts';
import { normalizeIban } from '../../text.ts';
import { ImportError, MAX_IMPORT_BYTES, type ImportRecord } from './types.ts';

// CAMT.053 (ISO 20022 bankafschrift), versies 001.02 tot en met 001.08.
// Geen DTD's en geen entiteiten: elk bestand met <!DOCTYPE of <!ENTITY wordt geweigerd
// voordat er iets geparsed wordt (bescherming tegen XXE en entity expansion).

type Node = Record<string, unknown>;

const ARRAYS = new Set(['Stmt', 'Ntry', 'TxDtls', 'Ustrd', 'Bal']);

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '@',
	removeNSPrefix: true,
	parseTagValue: false,
	parseAttributeValue: false,
	trimValues: true,
	processEntities: false,
	htmlEntities: false,
	ignoreDeclaration: true,
	ignorePiTags: true,
	maxNestedTags: 64,
	isArray: (name) => ARRAYS.has(name)
});

const XML_ENTITIES: Record<string, string> = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&apos;': "'"
};

/** Alleen de vijf vaste XML-entiteiten en tekenreferenties; de rest blijft letterlijk staan. */
function decode(s: string): string {
	return s.replace(/&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g, (m) => {
		if (m[1] !== '#') return XML_ENTITIES[m] ?? m;
		const code = m[2] === 'x' ? Number.parseInt(m.slice(3, -1), 16) : Number(m.slice(2, -1));
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
	});
}

function node(v: unknown): Node | undefined {
	return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Node) : undefined;
}

function path(root: unknown, ...keys: string[]): unknown {
	let cur: unknown = root;
	for (const k of keys) {
		const n = node(cur);
		if (!n) return undefined;
		cur = n[k];
	}
	return cur;
}

function str(v: unknown): string {
	if (typeof v === 'string') return decode(v);
	const n = node(v);
	if (n && typeof n['#text'] === 'string') return decode(n['#text']);
	return '';
}

function list(v: unknown): unknown[] {
	if (v === undefined || v === null) return [];
	return Array.isArray(v) ? v : [v];
}

function date(entry: unknown): string | null {
	const d = str(path(entry, 'BookgDt', 'Dt')) || str(path(entry, 'BookgDt', 'DtTm')).slice(0, 10);
	const v = d || str(path(entry, 'ValDt', 'Dt')) || str(path(entry, 'ValDt', 'DtTm')).slice(0, 10);
	return isIsoDate(v) ? v : null;
}

function partyName(party: unknown): string {
	// 001.02: Cdtr/Nm; 001.08: Cdtr/Pty/Nm
	return str(path(party, 'Nm')) || str(path(party, 'Pty', 'Nm'));
}

function amount(amt: unknown): { cents: number; currency: string } | null {
	const n = node(amt);
	const text = str(amt);
	const cents = parseDecimal(text);
	if (cents === null || cents < 0) return null;
	const currency = n && typeof n['@Ccy'] === 'string' ? n['@Ccy'] : '';
	return { cents, currency };
}

export function parseCamt053(xml: string): ImportRecord[] {
	if (Buffer.byteLength(xml, 'utf8') > MAX_IMPORT_BYTES) {
		throw new ImportError('Het bestand is groter dan 20 MB.');
	}
	const upper = xml.toUpperCase();
	if (upper.includes('<!DOCTYPE') || upper.includes('<!ENTITY')) {
		throw new ImportError('Bestanden met een DTD of entiteiten worden geweigerd.');
	}
	const valid = XMLValidator.validate(xml);
	if (valid !== true) throw new ImportError('Dit is geen geldige XML.');

	const doc = parser.parse(xml) as unknown;
	const statements = list(path(doc, 'Document', 'BkToCstmrStmt', 'Stmt'));
	if (statements.length === 0) throw new ImportError('Geen CAMT.053-afschrift gevonden.');

	const records: ImportRecord[] = [];
	for (const stmt of statements) {
		const accountIban = normalizeIban(str(path(stmt, 'Acct', 'Id', 'IBAN')));
		if (!accountIban) throw new ImportError('Afschrift zonder IBAN van de rekening.');

		for (const entry of list(path(stmt, 'Ntry'))) {
			// Alleen geboekte posten; 001.08 zet de status in Sts/Cd
			const status = str(path(entry, 'Sts')) || str(path(entry, 'Sts', 'Cd'));
			if (status && status !== 'BOOK') continue;

			const day = date(entry);
			if (!day) throw new ImportError('Boeking zonder geldige datum.');
			const sign = str(path(entry, 'CdtDbtInd'));
			if (sign !== 'CRDT' && sign !== 'DBIT') throw new ImportError('Boeking zonder bij/af-teken.');
			const entryAmount = amount(path(entry, 'Amt'));
			if (!entryAmount) throw new ImportError('Boeking met een ongeldig bedrag.');
			if (entryAmount.currency && entryAmount.currency !== 'EUR') {
				throw new ImportError('Alleen afschriften in euro worden ondersteund.');
			}

			const details = list(path(entry, 'NtryDtls', 'TxDtls'));
			const entryRef = str(path(entry, 'AcctSvcrRef')) || str(path(entry, 'NtryRef'));
			const entryInfo = str(path(entry, 'AddtlNtryInf'));

			// Een verzamelboeking met eigen bedragen per detail wordt opgesplitst
			const splitDetails =
				details.length > 1 &&
				details.every((d) => amount(path(d, 'Amt')) ?? amount(path(d, 'AmtDtls', 'TxAmt', 'Amt')));
			const parts = splitDetails ? details : [details[0]];

			parts.forEach((tx, index) => {
				const partAmount = splitDetails
					? (amount(path(tx, 'Amt')) ?? amount(path(tx, 'AmtDtls', 'TxAmt', 'Amt')))!
					: entryAmount;
				const debit = (str(path(tx, 'CdtDbtInd')) || sign) === 'DBIT';
				const party = debit ? path(tx, 'RltdPties', 'Cdtr') : path(tx, 'RltdPties', 'Dbtr');
				const partyAccount = debit
					? path(tx, 'RltdPties', 'CdtrAcct', 'Id', 'IBAN')
					: path(tx, 'RltdPties', 'DbtrAcct', 'Id', 'IBAN');
				const ustrd = list(path(tx, 'RmtInf', 'Ustrd'))
					.map(str)
					.filter(Boolean)
					.join(' ');
				const description = ustrd || str(path(tx, 'AddtlTxInf')) || entryInfo;
				const ref = str(path(tx, 'Refs', 'AcctSvcrRef')) || entryRef;
				const counterIban = normalizeIban(str(partyAccount));

				records.push({
					accountIban,
					date: day,
					amountCents: debit ? -partAmount.cents : partAmount.cents,
					counterparty: partyName(party).slice(0, 140),
					counterIban: counterIban || null,
					description: description.slice(0, 500),
					bankReference: ref ? `${accountIban}:${ref}${splitDetails ? `#${index + 1}` : ''}` : null
				});
			});
		}
	}
	return records;
}
