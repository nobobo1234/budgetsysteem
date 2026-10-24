import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCamt053 } from './camt.ts';
import { parseCsv, parseSnsCsv } from './csv.ts';
import { parseBankFile } from './index.ts';
import { ImportError } from './types.ts';

const fixture = (name: string) =>
	readFileSync(new URL(`../../../../tests/fixtures/${name}`, import.meta.url), 'utf8');

describe('CAMT.053 (001.02)', () => {
	const records = parseCamt053(fixture('camt053-v02.xml'));

	it('leest alleen geboekte posten', () => {
		expect(records).toHaveLength(5);
		expect(records.some((r) => r.bankReference?.includes('REF-PENDING'))).toBe(false);
	});

	it('leest bedrag, teken, datum en tegenpartij', () => {
		expect(records[0]).toEqual({
			accountIban: 'NL12SNSB0123456789',
			date: '2026-09-02',
			amountCents: -2345,
			counterparty: 'ALBERT HEIJN 1403 UTRECHT',
			counterIban: null,
			description: 'Betaalautomaat 02-09-2026',
			bankReference: 'NL12SNSB0123456789:REF-0001'
		});
		expect(records[1]).toMatchObject({
			amountCents: 125000,
			counterparty: 'Werkgever B.V.',
			counterIban: 'NL91ABNA0417164300'
		});
	});

	it('decodeert de vaste XML-entiteiten en voegt Ustrd-regels samen', () => {
		expect(records[3]?.description).toBe('Abonnement & meer sept');
		expect(records[3]?.bankReference).toBeNull();
	});
});

describe('CAMT.053 (001.08)', () => {
	const records = parseCamt053(fixture('camt053-v08.xml'));

	it('splitst een verzamelboeking en leest Sts/Cd, DtTm en Pty/Nm', () => {
		expect(records).toHaveLength(2);
		expect(records.map((r) => r.amountCents)).toEqual([-750, -500]);
		expect(records[0]?.counterparty).toBe('Café De Hoek');
		expect(records[0]?.date).toBe('2026-10-03');
		expect(records.map((r) => r.bankReference)).toEqual([
			'NL12SNSB0123456789:REF-1001#1',
			'NL12SNSB0123456789:REF-1001#2'
		]);
	});
});

describe('CAMT.053 pinbetalingen zonder RltdPties', () => {
	const records = parseCamt053(fixture('camt053-pin.xml'));

	it('neemt de winkel uit de omschrijving als tegenpartij', () => {
		expect(records.map((r) => r.counterparty)).toEqual([
			'BAKKERIJ - 123456 Teststr',
			'Koffiebar Voorbeeld B.V.',
			'SUPERMARKT TEST 11',
			'SUPERMARKT TEST 11',
			'WINKEL VOORBEELD FIL0001',
			'',
			'Verhuurder Test'
		]);
	});

	it('laat de omschrijving ongewijzigd, ook de opgevulde spaties', () => {
		expect(records[2]?.description).toBe(
			'SUPERMARKT TEST 11     >TESTDORP 03.02.2026 9U57 KV011 ET000001 MCC:5499 Apple Pay betaling NLNEDERLAND'
		);
		expect(records[0]?.description.startsWith('BAKKERIJ - 123456 Teststr>Utrecht')).toBe(true);
	});
});

describe('CAMT.053 beveiliging (XXE)', () => {
	const xxe = `<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<Document><BkToCstmrStmt><Stmt><Acct><Id><IBAN>&xxe;</IBAN></Id></Acct></Stmt></BkToCstmrStmt></Document>`;

	it('weigert een DTD met externe entiteit', () => {
		expect(() => parseCamt053(xxe)).toThrow(ImportError);
	});

	it('weigert entity expansion (billion laughs)', () => {
		const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><Document>&lol2;</Document>`;
		expect(() => parseCamt053(bomb)).toThrow(/DTD/);
	});

	it('weigert ook een doctype in kleine letters', () => {
		expect(() => parseCamt053('<!doctype x><Document/>')).toThrow(ImportError);
	});

	it('laat onbekende entiteiten letterlijk staan', () => {
		const xml = fixture('camt053-v02.xml').replace('Werkgever B.V.', 'Werkgever &foo; B.V.');
		expect(parseCamt053(xml)[1]?.counterparty).toBe('Werkgever &foo; B.V.');
	});

	it('weigert bestanden boven 20 MB', () => {
		const big = `<Document>${' '.repeat(20 * 1024 * 1024)}</Document>`;
		expect(() => parseCamt053(big)).toThrow(/20 MB/);
	});

	it('weigert ongeldige XML en andere valuta', () => {
		expect(() => parseCamt053('<Document><BkToCstmrStmt>')).toThrow(ImportError);
		expect(() =>
			parseCamt053(fixture('camt053-v02.xml').replaceAll('Ccy="EUR"', 'Ccy="USD"'))
		).toThrow(/euro/);
	});

	it('weigert een negatief of onleesbaar bedrag', () => {
		expect(() => parseCamt053(fixture('camt053-v02.xml').replace('23.45', '23,45'))).toThrow(
			/bedrag/
		);
	});
});

describe('SNS-CSV', () => {
	it('parset aanhalingstekens en verdubbelde aanhalingstekens', () => {
		expect(parseCsv('a,"b,c","d ""e"""\r\n1,2,3', ',')).toEqual([
			['a', 'b,c', 'd "e"'],
			['1', '2', '3']
		]);
	});

	it('leest de 17-kolommen-layout zonder kop', () => {
		const records = parseSnsCsv(fixture('sns.csv'));
		expect(records).toHaveLength(2);
		expect(records[0]).toEqual({
			accountIban: 'NL12SNSB0123456789',
			date: '2026-09-02',
			amountCents: -2345,
			counterparty: 'ALBERT HEIJN 1403 UTRECHT',
			counterIban: null,
			description: 'Betaalautomaat 02-09-2026',
			bankReference: 'NL12SNSB0123456789:90000001'
		});
		expect(records[1]).toMatchObject({
			date: '2026-09-25',
			amountCents: 125000,
			counterparty: 'Werkgever, B.V.',
			description: 'Salaris "september"'
		});
	});

	it('leest een bestand met kop en puntkomma', () => {
		const csv =
			'Datum;Je rekening;Van / naar;Naam;Bedrag bij/af;Volgnummer;Omschrijving\n' +
			'1-10-2026;NL12SNSB0123456789;;Bakker;-3.10;77;brood\n';
		expect(parseSnsCsv(csv)[0]).toMatchObject({
			amountCents: -310,
			date: '2026-10-01',
			counterparty: 'Bakker'
		});
	});

	it('vult een lege naam bij een pinbetaling met de winkel', () => {
		const csv =
			'Datum;Je rekening;Van / naar;Naam;Bedrag bij/af;Volgnummer;Omschrijving\n' +
			'2-2-2026;NL12SNSB0123456789;;;-4.35;78;"BAKKERIJ - 123456 Teststr>Utrecht 01.02.2026 8U05 KV011 PTR00001 MCC:5499 Apple Pay betaling NLNEDERLAND"\n';
		expect(parseSnsCsv(csv)[0]).toMatchObject({
			counterparty: 'BAKKERIJ - 123456 Teststr',
			description:
				'BAKKERIJ - 123456 Teststr>Utrecht 01.02.2026 8U05 KV011 PTR00001 MCC:5499 Apple Pay betaling NLNEDERLAND'
		});
	});

	it('weigert onbekende indelingen en ongeldige regels', () => {
		expect(() => parseSnsCsv('a,b,c\n1,2,3')).toThrow(ImportError);
		expect(() => parseSnsCsv(fixture('sns.csv').replace('-23.45', 'veel'))).toThrow(ImportError);
	});
});

describe('parseBankFile', () => {
	it('herkent het formaat aan de inhoud', () => {
		expect(parseBankFile(new TextEncoder().encode(fixture('camt053-v02.xml'))).format).toBe(
			'camt053'
		);
		expect(parseBankFile(new TextEncoder().encode(fixture('sns.csv'))).format).toBe('csv');
	});

	it('valt bij ongeldige UTF-8 terug op Windows-1252', () => {
		const bytes = new TextEncoder().encode(
			fixture('sns.csv').replace('ALBERT HEIJN', 'CAF? HEIJN')
		);
		bytes[bytes.indexOf('?'.charCodeAt(0))] = 0xc9; // É in Windows-1252
		expect(parseBankFile(bytes).records[0]?.counterparty).toBe('CAFÉ HEIJN 1403 UTRECHT');
	});

	it('weigert een leeg bestand', () => {
		expect(() => parseBankFile(new Uint8Array())).toThrow(ImportError);
	});
});
