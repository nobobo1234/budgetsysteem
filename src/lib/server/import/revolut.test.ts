import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBankFile } from './index.ts';
import { isRevolutCsv, parseRevolutCsv } from './revolut.ts';
import { ImportError } from './types.ts';

const fixture = readFileSync(
	new URL('../../../../tests/fixtures/revolut.csv', import.meta.url),
	'utf8'
);

const HEADER =
	'Type,Product,Startdatum,Datum voltooid,Beschrijving,Bedrag,Kosten,Valuta,Status,Saldo\n';
const csv = (...rows: string[]) => HEADER + rows.join('\n') + '\n';

describe('Revolut-CSV', () => {
	const records = parseRevolutCsv(fixture);
	const by = (description: string) => records.filter((r) => r.description === description);

	it('herkent de export aan de kolomkoppen', () => {
		expect(isRevolutCsv(fixture)).toBe(true);
		expect(
			isRevolutCsv(
				readFileSync(new URL('../../../../tests/fixtures/sns.csv', import.meta.url), 'utf8')
			)
		).toBe(false);
		expect(parseBankFile(new TextEncoder().encode(fixture)).format).toBe('revolut');
	});

	it('slaat teruggedraaide en lopende boekingen en wissels over', () => {
		expect(records.map((r) => r.description)).toEqual([
			'Opwaardering via Apple Pay',
			'ICA Maxi',
			'Pressbyrån, Centralen',
			'ICA Maxi',
			'Naar Anna',
			'Koersverschil bij wisselen SEK naar EUR',
			'Amazon',
			'Premium-abonnement',
			'Spotify',
			'Spotify',
			'Kaneelbulle',
			'Koffie'
		]);
	});

	it('markeert opwaarderen als eigen overboeking', () => {
		expect(records[0]).toEqual({
			accountIban: '',
			accountKind: 'revolut',
			date: '2026-01-30',
			amountCents: 50000,
			counterparty: 'Opwaardering via Apple Pay',
			counterIban: null,
			description: 'Opwaardering via Apple Pay',
			bankReference: expect.stringMatching(/^revolut:[0-9a-f]{32}:1$/),
			internal: true
		});
	});

	it('rekent kronen om tegen de eigen wisselkoers, met de startdatum als datum', () => {
		// 2300 kr voor € 200: 460 kr kost € 40
		expect(by('ICA Maxi')[0]).toMatchObject({
			date: '2026-02-03',
			amountCents: -4000,
			origAmountCents: -46000,
			origCurrency: 'SEK',
			internal: false
		});
		expect(by('Pressbyrån, Centralen')[0]).toMatchObject({
			amountCents: -200,
			origAmountCents: -2300
		});
	});

	it('neemt wisselkosten mee in de gemiddelde koers', () => {
		// Na de tweede wissel: 2957 kr voor € 258, dus de terugbetaling van 46 kr is € 4,01
		expect(by('ICA Maxi')[1]).toMatchObject({ amountCents: 401, origAmountCents: 4600 });
	});

	it('telt kosten bij het bedrag op', () => {
		expect(by('Naar Anna')[0]).toMatchObject({ amountCents: -2661, origAmountCents: -30500 });
		expect(by('Amazon')[0]).toMatchObject({ amountCents: -2050 });
		expect(by('Amazon')[0]).not.toHaveProperty('origCurrency');
		expect(by('Premium-abonnement')[0]).toMatchObject({ amountCents: -799 });
	});

	it('boekt bij terugwisselen alleen het koersverschil', () => {
		// De resterende 2698 kr kostten € 235,40 en leverden € 230 op
		expect(by('Koersverschil bij wisselen SEK naar EUR')[0]).toMatchObject({
			date: '2026-07-01',
			amountCents: -540,
			counterparty: 'Koersverschil',
			bankReference: expect.stringMatching(/^revolut:[0-9a-f]{32}:1:koersverschil$/)
		});
	});

	it('het totaal in euro klopt met wat er netto naar Revolut ging', () => {
		// € 500 erin, € 372,53 over, geen kronen meer: de rest is uitgegeven
		const total = records.reduce((sum, r) => sum + r.amountCents, 0);
		expect(total).toBe(37253);
	});

	it('geeft identieke boekingen een eigen referentie', () => {
		const refs = by('Spotify').map((r) => r.bankReference);
		expect(refs[0]).toMatch(/:1$/);
		expect(refs[1]).toMatch(/:2$/);
		expect(new Set(records.map((r) => r.bankReference)).size).toBe(records.length);
	});

	it('vindt de volgorde van boekingen in dezelfde seconde via het saldo', () => {
		expect(by('Koffie')).toHaveLength(1);
		expect(by('Kaneelbulle')).toHaveLength(1);
	});

	it('schat het beginsaldo met de eerste wissel en laat dat nakijken', () => {
		const later = parseRevolutCsv(
			csv(
				'Kaartbetaling,Betaalrekening,2026-02-01 10:00:00,2026-02-01 10:00:00,ICA,-1000.00,0.00,SEK,VOLTOOID,0.00',
				'Wisselen,Betaalrekening,2026-02-02 10:00:00,2026-02-02 10:00:00,Naar SEK,-100.00,0.00,EUR,VOLTOOID,50.00',
				'Wisselen,Betaalrekening,2026-02-02 10:00:00,2026-02-02 10:00:00,Van EUR,1000.00,0.00,SEK,VOLTOOID,1000.00',
				'Kaartbetaling,Betaalrekening,2026-02-03 10:00:00,2026-02-03 10:00:00,Coop,-50.00,0.00,SEK,VOLTOOID,950.00'
			)
		);
		expect(later[0]).toMatchObject({ amountCents: -10000, needsReview: true });
		expect(later[1]).toMatchObject({ amountCents: -500 });
		expect(later[1]).not.toHaveProperty('needsReview');
	});

	it('weigert vreemde valuta zonder enige wisselkoers', () => {
		expect(() =>
			parseRevolutCsv(
				csv(
					'Kaartbetaling,Betaalrekening,2026-02-01 10:00:00,2026-02-01 10:00:00,Shop,-5.00,0.00,USD,VOLTOOID,-5.00'
				)
			)
		).toThrow(/wisselkoers voor USD/);
	});

	it('weigert een saldo dat niet klopt', () => {
		expect(() => parseRevolutCsv(fixture.replace(',1840.00', ',1841.00'))).toThrow(/SEK-saldo/);
	});

	it('wisselt meerdere valuta in dezelfde seconde als geheel terug naar euro', () => {
		const t = '2026-07-01 10:00:00,2026-07-01 10:00:00';
		const records = parseRevolutCsv(
			csv(
				'Geld toevoegen,Betaalrekening,2026-02-01 09:00:00,2026-02-01 09:00:00,Opwaarderen,200.00,0.00,EUR,VOLTOOID,200.00',
				'Wisselen,Betaalrekening,2026-02-01 10:00:00,2026-02-01 10:00:00,Naar SEK,-100.00,0.00,EUR,VOLTOOID,100.00',
				'Wisselen,Betaalrekening,2026-02-01 10:00:00,2026-02-01 10:00:00,Van EUR,1000.00,0.00,SEK,VOLTOOID,1000.00',
				'Wisselen,Betaalrekening,2026-02-02 10:00:00,2026-02-02 10:00:00,Naar NOK,-100.00,0.00,EUR,VOLTOOID,0.00',
				'Wisselen,Betaalrekening,2026-02-02 10:00:00,2026-02-02 10:00:00,Van EUR,1000.00,0.00,NOK,VOLTOOID,1000.00',
				'Kaartbetaling,Betaalrekening,2026-02-03 10:00:00,2026-02-03 10:00:00,ICA,-500.00,0.00,SEK,VOLTOOID,500.00',
				`Wisselen,Betaalrekening,${t},Van SEK,45.00,0.00,EUR,VOLTOOID,45.00`,
				`Wisselen,Betaalrekening,${t},Van NOK,95.00,0.00,EUR,VOLTOOID,140.00`,
				`Wisselen,Betaalrekening,${t},Naar EUR,-1000.00,0.00,NOK,VOLTOOID,0.00`,
				`Wisselen,Betaalrekening,${t},Naar EUR,-500.00,0.00,SEK,VOLTOOID,0.00`
			)
		);
		// Kostprijs € 50 (SEK) + € 100 (NOK), opbrengst € 140
		expect(records.map((r) => [r.description, r.amountCents])).toEqual([
			['Opwaarderen', 20000],
			['ICA', -5000],
			['Koersverschil bij wisselen NOK en SEK naar EUR', -1000]
		]);
	});

	it('weigert wissels naar verschillende valuta in dezelfde seconde', () => {
		const t = '2026-02-01 10:00:00,2026-02-01 10:00:00';
		expect(() =>
			parseRevolutCsv(
				csv(
					`Wisselen,Betaalrekening,${t},Naar SEK,-10.00,0.00,EUR,VOLTOOID,-10.00`,
					`Wisselen,Betaalrekening,${t},Naar NOK,-10.00,0.00,EUR,VOLTOOID,-20.00`,
					`Wisselen,Betaalrekening,${t},Van EUR,100.00,0.00,SEK,VOLTOOID,100.00`,
					`Wisselen,Betaalrekening,${t},Van EUR,100.00,0.00,NOK,VOLTOOID,100.00`
				)
			)
		).toThrow(/verschillende valuta/);
	});

	it('weigert een wissel zonder tegenboeking', () => {
		expect(() =>
			parseRevolutCsv(
				csv(
					'Wisselen,Betaalrekening,2026-02-01 10:00:00,2026-02-01 10:00:00,Naar SEK,-10.00,0.00,EUR,VOLTOOID,-10.00'
				)
			)
		).toThrow(/tegenboeking/);
	});

	it('weigert onbekende types, statussen, producten en ongeldige velden', () => {
		const row = (
			over: Partial<Record<'type' | 'product' | 'date' | 'amount' | 'cur' | 'state', string>>
		) =>
			csv(
				[
					over.type ?? 'Kaartbetaling',
					over.product ?? 'Betaalrekening',
					over.date ?? '2026-02-01 10:00:00',
					over.date ?? '2026-02-01 10:00:00',
					'Shop',
					over.amount ?? '-5.00',
					'0.00',
					over.cur ?? 'EUR',
					over.state ?? 'VOLTOOID',
					'-5.00'
				].join(',')
			);
		expect(() => parseRevolutCsv(row({}))).not.toThrow();
		expect(() => parseRevolutCsv(row({ type: 'Crypto' }))).toThrow(/type "Crypto"/);
		expect(() => parseRevolutCsv(row({ state: 'GEWEIGERD' }))).toThrow(/status/);
		expect(() => parseRevolutCsv(row({ product: 'Spaarrekening' }))).toThrow(/betaalrekening/);
		expect(() => parseRevolutCsv(row({ date: '2026-02-30 10:00:00' }))).toThrow(/datum/);
		expect(() => parseRevolutCsv(row({ amount: '-5,00' }))).toThrow(ImportError);
		expect(() => parseRevolutCsv(row({ cur: 'eur' }))).toThrow(/valuta/);
		expect(() => parseRevolutCsv(HEADER)).toThrow(/geen voltooide/);
	});
});
