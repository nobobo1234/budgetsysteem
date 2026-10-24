import { parseCamt053 } from './camt.ts';
import { parseSnsCsv } from './csv.ts';
import { isRevolutCsv, parseRevolutCsv } from './revolut.ts';
import { ImportError, MAX_IMPORT_BYTES, type ImportFormat, type ImportRecord } from './types.ts';

/** Herkent CAMT.053 (XML), de SNS-CSV of de Revolut-CSV aan de inhoud, niet aan de bestandsnaam. */
export function parseBankFile(bytes: Uint8Array): {
	format: ImportFormat;
	records: ImportRecord[];
} {
	if (bytes.byteLength > MAX_IMPORT_BYTES)
		throw new ImportError('Het bestand is groter dan 20 MB.');
	if (bytes.byteLength === 0) throw new ImportError('Het bestand is leeg.');
	let text = new TextDecoder('utf-8').decode(bytes);
	if (text.trimStart().startsWith('<')) return { format: 'camt053', records: parseCamt053(text) };
	// Oudere CSV-exports zijn soms Windows-1252 in plaats van UTF-8
	if (text.includes('�')) text = new TextDecoder('windows-1252').decode(bytes);
	if (isRevolutCsv(text)) return { format: 'revolut', records: parseRevolutCsv(text) };
	return { format: 'csv', records: parseSnsCsv(text) };
}

export { ImportError };
