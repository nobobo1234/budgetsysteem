import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCamt053, readCamt053 } from './camt.ts';
import { parseCsv, parseSnsCsv, readSnsCsv } from './csv.ts';
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

describe('CAMT.053 terugboekingen', () => {
	const records = parseCamt053(fixture('camt053-storno.xml'));

	it('leest RvslInd en het end-to-end-kenmerk', () => {
		expect(records.map((r) => r.reversal ?? false)).toEqual([false, true, false, true]);
		expect(records[0]?.endToEndId).toBe('E2E-INC-0001');
		expect(records[1]?.endToEndId).toBe('E2E-INC-0001');
	});

	it('NOTPROVIDED is geen kenmerk', () => {
		expect(records[2]?.endToEndId).toBeUndefined();
		expect(records[3]?.endToEndId).toBeUndefined();
	});

	it('een storno noemt de partijen als bij het origineel: de tegenpartij is de incassant', () => {
		expect(records[1]).toMatchObject({
			amountCents: 4995,
			counterparty: 'Energie Test B.V.',
			counterIban: 'NL20INGB0001234567'
		});
		// Zonder Dbtr bij de storno: dan de andere kant
		expect(records[3]).toMatchObject({
			amountCents: 2000,
			counterparty: 'Sportclub Test',
			counterIban: 'NL69INGB0123456789'
		});
	});

	it('gewone boekingen hebben geen storno-vlag', () => {
		for (const r of parseCamt053(fixture('camt053-v02.xml'))) expect(r.reversal).toBeUndefined();
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

describe('startsaldo uit het afschrift', () => {
	const camt = fixture('camt053-v02.xml');

	it('CAMT: eindsaldo min de boekingen, gecontroleerd met het beginsaldo', () => {
		expect(readCamt053(camt).balances).toEqual([
			{ accountIban: 'NL12SNSB0123456789', firstDate: '2026-09-02', amountCents: 100000 }
		]);
	});

	it('CAMT: een saldo onder nul (DBIT)', () => {
		const xml = camt
			.replace('<Amt Ccy="EUR">2156.57</Amt>', '<Amt Ccy="EUR">43.43</Amt>')
			.replace(/(<Cd>CLBD<\/Cd>[\s\S]*?<CdtDbtInd>)CRDT/, '$1DBIT')
			.replace('<Amt Ccy="EUR">1000.00</Amt>', '<Amt Ccy="EUR">1200.00</Amt>')
			.replace(/(<Cd>OPBD<\/Cd>[\s\S]*?<CdtDbtInd>)CRDT/, '$1DBIT');
		expect(readCamt053(xml).balances[0]?.amountCents).toBe(-120000);
	});

	it('CAMT: geen saldo als begin en eind niet bij de boekingen passen', () => {
		expect(readCamt053(camt.replace('2156.57', '2156.58')).balances).toEqual([]);
	});

	it('CAMT: alleen een beginsaldo is ook goed', () => {
		const xml = camt.replace('<Cd>CLBD</Cd>', '<Cd>ITBD</Cd>');
		expect(readCamt053(xml).balances[0]?.amountCents).toBe(100000);
	});

	it('CAMT: zonder saldo in het bestand geen startsaldo', () => {
		expect(readCamt053(fixture('camt053-v08.xml')).balances).toEqual([]);
	});

	it('SNS-CSV: het saldo vóór de eerste boeking', () => {
		expect(readSnsCsv(fixture('sns.csv')).balances).toEqual([
			{ accountIban: 'NL12SNSB0123456789', firstDate: '2026-09-02', amountCents: 100000 }
		]);
	});

	it('SNS-CSV: volgt de keten, ook als boekingen van één dag andersom staan', () => {
		const row = (saldo: string, bedrag: string, volgnr: string) =>
			`02-09-2026,NL12SNSB0123456789,,Winkel,EUR,${saldo},EUR,${bedrag},02-09-2026,02-09-2026,8810,BEA,${volgnr},,x,1,`;
		const csv = [row('90.00', '-5.00', '3'), row('100.00', '-10.00', '1')].join('\n');
		expect(readSnsCsv(csv).balances[0]?.amountCents).toBe(10000);
	});

	it('SNS-CSV: geen saldo als de keten niet sluit, de boekingen wel', () => {
		const broken = fixture('sns.csv').replace('976.55', '976.56');
		expect(readSnsCsv(broken).balances).toEqual([]);
		expect(readSnsCsv(broken).records).toHaveLength(2);
	});

	it('SNS-CSV: zonder saldokolom geen startsaldo', () => {
		const csv =
			'Datum;Je rekening;Van / naar;Naam;Bedrag bij/af;Volgnummer;Omschrijving\n' +
			'1-10-2026;NL12SNSB0123456789;;Bakker;-3.10;77;brood\n';
		expect(readSnsCsv(csv).balances).toEqual([]);
	});

	it('komt mee uit parseBankFile', () => {
		expect(parseBankFile(new TextEncoder().encode(camt)).balances).toHaveLength(1);
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
