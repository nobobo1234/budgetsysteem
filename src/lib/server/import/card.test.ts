import { describe, expect, it } from 'vitest';
import { counterpartyOrMerchant, mccCategory, parseCardPayment } from './card.ts';

// Verzonnen omschrijvingen in de vorm van SNS-pinbetalingen; geen echte winkels of terminals.
const BAKKERIJ =
	'BAKKERIJ - 123456 Teststr>Utrecht 01.02.2026 8U05 KV011 PTR00001 MCC:5499 Apple Pay betaling NLNEDERLAND';
const KOFFIEBAR =
	'Koffiebar Voorbeeld B.V.>Utrecht01.02.2026 14U39 KV011 12345678 MCC:5814 Apple Pay betaling NLNEDERLAND';
const SUPERMARKT =
	'SUPERMARKT TEST 11     >TESTDORP 03.02.2026 9U57 KV011 ET000001 MCC:5499 Apple Pay betaling NLNEDERLAND';
const WINKEL =
	'WINKEL VOORBEELD FIL0001 >AMERSFOORT03.02.2026 16U36 KV011 0000AA MCC:5411 Apple Pay betaling NLNEDERLAND';

describe('parseCardPayment', () => {
	it('herkent een winkel met straat en een spatie voor de datum', () => {
		expect(parseCardPayment(BAKKERIJ)).toEqual({
			merchant: 'BAKKERIJ - 123456 Teststr',
			place: 'Utrecht',
			mcc: '5499'
		});
	});

	it('herkent een plaats die direct aan de datum vastzit', () => {
		expect(parseCardPayment(KOFFIEBAR)).toEqual({
			merchant: 'Koffiebar Voorbeeld B.V.',
			place: 'Utrecht',
			mcc: '5814'
		});
		expect(parseCardPayment(WINKEL)).toEqual({
			merchant: 'WINKEL VOORBEELD FIL0001',
			place: 'AMERSFOORT',
			mcc: '5411'
		});
	});

	it('trimt opgevulde spaties en vouwt spaties samen', () => {
		expect(parseCardPayment(SUPERMARKT)).toEqual({
			merchant: 'SUPERMARKT TEST 11',
			place: 'TESTDORP',
			mcc: '5499'
		});
		expect(
			parseCardPayment(
				'  WINKEL    MET   GATEN  >  STAD  01.02.2026  8U05  KV011  T1  MCC:5411  Betaling'
			)
		).toEqual({ merchant: 'WINKEL MET GATEN', place: 'STAD', mcc: '5411' });
	});

	it('kent een andere betaalwijze dan Apple Pay', () => {
		const pas = BAKKERIJ.replace('Apple Pay betaling', 'Betaalpas betaling');
		expect(parseCardPayment(pas)?.merchant).toBe('BAKKERIJ - 123456 Teststr');
		expect(parseCardPayment(BAKKERIJ.replace(' Apple Pay betaling NLNEDERLAND', ''))?.mcc).toBe(
			'5499'
		);
	});

	it('houdt voorloopnullen in de MCC', () => {
		expect(parseCardPayment(BAKKERIJ.replace('MCC:5499', 'MCC:0742'))?.mcc).toBe('0742');
	});

	it.each([
		['leeg', ''],
		['een gewone overboeking', 'Salaris september'],
		['geen winkel voor >', '>Utrecht 01.02.2026 8U05 KV011 PTR00001 MCC:5499'],
		['alleen cijfers als winkel', '123456 >Utrecht 01.02.2026 8U05 KV011 PTR00001 MCC:5499'],
		['geen >', 'BAKKERIJ Utrecht 01.02.2026 8U05 KV011 PTR00001 MCC:5499'],
		['geen datum', 'BAKKERIJ >Utrecht 8U05 KV011 PTR00001 MCC:5499'],
		['ongeldige maand', 'BAKKERIJ >Utrecht 01.13.2026 8U05 KV011 PTR00001 MCC:5499'],
		['geen tijd', 'BAKKERIJ >Utrecht 01.02.2026 KV011 PTR00001 MCC:5499'],
		['ongeldige tijd', 'BAKKERIJ >Utrecht 01.02.2026 25U05 KV011 PTR00001 MCC:5499'],
		['geen spatie na de datum', 'BAKKERIJ >Utrecht 01.02.20268U05 KV011 PTR00001 MCC:5499'],
		['geen MCC', 'BAKKERIJ >Utrecht 01.02.2026 8U05 KV011 PTR00001 Apple Pay betaling'],
		['MCC met drie cijfers', 'BAKKERIJ >Utrecht 01.02.2026 8U05 KV011 PTR00001 MCC:549'],
		['MCC te ver weg', 'BAKKERIJ >Utrecht 01.02.2026 8U05 A B C D E MCC:5499'],
		['twee keer >', 'BAKKERIJ >Utrecht >Zeist 01.02.2026 8U05 KV011 PTR00001 MCC:5499'],
		['te lange winkelnaam', `${'A'.repeat(65)}>Utrecht 01.02.2026 8U05 KV011 T1 MCC:5499`]
	])('geeft null bij %s', (_, description) => {
		expect(parseCardPayment(description)).toBeNull();
	});

	it('begrenst de invoer en blijft snel bij vijandige tekst', () => {
		expect(parseCardPayment(`${BAKKERIJ} ${'x'.repeat(500)}`)).toBeNull();
		const hostile = [
			'>'.repeat(500),
			'A>'.padEnd(500, '1'),
			`A>${'01.02.2026 '.repeat(45)}`,
			`A>${' '.repeat(498)}`,
			`A>X 01.02.2026 ${'1U00 '.repeat(96)}`
		];
		const start = performance.now();
		for (let i = 0; i < 200; i++) for (const h of hostile) parseCardPayment(h);
		expect(performance.now() - start).toBeLessThan(200);
	});
});

describe('counterpartyOrMerchant', () => {
	it('laat een bestaande tegenpartij staan', () => {
		expect(counterpartyOrMerchant('Werkgever B.V.', BAKKERIJ)).toBe('Werkgever B.V.');
	});

	it('vult een lege tegenpartij met de winkel', () => {
		expect(counterpartyOrMerchant('', SUPERMARKT)).toBe('SUPERMARKT TEST 11');
		expect(counterpartyOrMerchant('  ', KOFFIEBAR)).toBe('Koffiebar Voorbeeld B.V.');
	});

	it('blijft leeg als de omschrijving niet herkend wordt', () => {
		expect(counterpartyOrMerchant('', 'Salaris september')).toBe('');
	});
});

describe('mccCategory', () => {
	it('kent de vaste tabel', () => {
		expect(mccCategory('5411')).toBe('Boodschappen');
		expect(mccCategory('5499')).toBe('Boodschappen');
		expect(mccCategory('5814')).toBe('Uit eten en bezorgen');
		expect(mccCategory('5813')).toBe('Uitgaan');
		expect(mccCategory('4111')).toBe('Vervoer');
		expect(mccCategory('5912')).toBe('Drogist en verzorging');
		expect(mccCategory('4511')).toBe('Reizen');
	});

	it('geeft null voor onbekende codes en prototype-sleutels', () => {
		expect(mccCategory('9999')).toBeNull();
		expect(mccCategory('__proto__')).toBeNull();
		expect(mccCategory('constructor')).toBeNull();
	});
});
