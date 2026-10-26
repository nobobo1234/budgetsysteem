import { describe, expect, it } from 'vitest';
import { checkList, checkReceipt, parseModelAmount, signedLineCents, worst } from './checks.ts';
import { field, listItem, listOutput, NOW, receiptOutput } from './fixtures.ts';

describe('parseModelAmount', () => {
	it('leest de strikte machinevorm als hele centen', () => {
		expect(parseModelAmount('23.45')).toBe(2345);
		expect(parseModelAmount('7')).toBe(700);
		expect(parseModelAmount('0.5')).toBe(50);
		expect(parseModelAmount('-0.75')).toBe(-75);
		expect(parseModelAmount('−1.20')).toBe(-120);
		expect(parseModelAmount(' 4.10 ')).toBe(410);
	});

	it('weigert alles wat geraden zou moeten worden', () => {
		for (const bad of ['23,45', '1,234.50', '€ 3.00', '3.005', '1e3', '', 'abc', '.50', '12.']) {
			expect(parseModelAmount(bad), bad).toBeNull();
		}
	});

	it('weigert bedragen boven de grens van de app', () => {
		expect(parseModelAmount('1000000.01')).toBeNull();
	});
});

describe('signedLineCents', () => {
	it('maakt korting, bonus en ingeleverd statiegeld altijd negatief', () => {
		expect(signedLineCents(75, 'bonus')).toBe(-75);
		expect(signedLineCents(-75, 'korting')).toBe(-75);
		expect(signedLineCents(25, 'statiegeld_retour')).toBe(-25);
		expect(signedLineCents(15, 'statiegeld')).toBe(15);
		expect(signedLineCents(200, 'fooi')).toBe(200);
	});
});

describe('checkReceipt', () => {
	it('is zeker als het model zeker is en alle controles slagen', () => {
		const c = checkReceipt(receiptOutput(), NOW);
		expect(c.outcome).toBe('zeker');
		expect(c.store).toMatchObject({ value: 'Supermarkt Voorbeeld 0001', status: 'zeker' });
		expect(c.date).toMatchObject({ value: '2026-10-20', status: 'zeker', failures: [] });
		expect(c.totalCents).toMatchObject({ value: 737, status: 'zeker', failures: [] });
		expect(c.currency).toMatchObject({ value: 'EUR', status: 'zeker' });
		expect(c.paymentMethod).toMatchObject({ value: 'pin', status: 'zeker' });
		expect(c.linesSumCents).toBe(737);
	});

	it('telt een bonus die het model positief opgeeft toch af', () => {
		const output = receiptOutput();
		output.regels[3]!.bedrag = '0.75';
		const c = checkReceipt(output, NOW);
		expect(c.linesSumCents).toBe(737);
		expect(c.totalCents.status).toBe('zeker');
	});

	it('maakt een veld controleren als het model twijfelt maar de controles slagen', () => {
		const c = checkReceipt(receiptOutput({ datum: field('2026-10-20', 'twijfel') }), NOW);
		expect(c.date.status).toBe('controleren');
		expect(c.outcome).toBe('controleren');
	});

	it('laat een leeg veld leeg en maakt het onzeker', () => {
		const c = checkReceipt(
			receiptOutput({ totaal: field('', 'onleesbaar', 'Gekreukt bij het totaal') }),
			NOW
		);
		expect(c.totalCents).toMatchObject({
			value: null,
			status: 'onzeker',
			failures: ['leeg'],
			note: 'Gekreukt bij het totaal'
		});
		expect(c.outcome).toBe('onzeker');
	});

	it('vertrouwt geen waarde die het model zelf onleesbaar noemt', () => {
		const c = checkReceipt(receiptOutput({ winkel: field('Supermarkt', 'onleesbaar') }), NOW);
		expect(c.store.status).toBe('onzeker');
		expect(c.store.failures).toContain('onleesbaar');
	});

	describe('totaal', () => {
		it('moet een geldig bedrag zijn', () => {
			const c = checkReceipt(receiptOutput({ totaal: field('7,37'), regels: [] }), NOW);
			expect(c.totalCents).toMatchObject({
				value: null,
				status: 'onzeker',
				failures: ['ongeldig']
			});
		});

		it('moet positief zijn', () => {
			const zero = checkReceipt(receiptOutput({ totaal: field('0.00'), regels: [] }), NOW);
			expect(zero.totalCents).toMatchObject({ status: 'onzeker', failures: ['niet_positief'] });
			const negative = checkReceipt(receiptOutput({ totaal: field('-5.00'), regels: [] }), NOW);
			expect(negative.totalCents.failures).toEqual(['niet_positief']);
		});

		it('mag €0,05 van de opgetelde regels afwijken', () => {
			expect(checkReceipt(receiptOutput({ totaal: field('7.42') }), NOW).totalCents.status).toBe(
				'zeker'
			);
			expect(checkReceipt(receiptOutput({ totaal: field('7.32') }), NOW).totalCents.status).toBe(
				'zeker'
			);
		});

		it('is onzeker als de regels er meer dan €0,05 naast zitten, ook als het model zeker is', () => {
			const c = checkReceipt(receiptOutput({ totaal: field('7.43') }), NOW);
			expect(c.totalCents).toMatchObject({
				value: 743,
				status: 'onzeker',
				failures: ['regels_kloppen_niet']
			});
			expect(c.outcome).toBe('onzeker');
		});

		it('controleert de som niet als er geen regels zijn', () => {
			const c = checkReceipt(receiptOutput({ totaal: field('99.99'), regels: [] }), NOW);
			expect(c.linesSumCents).toBeNull();
			expect(c.totalCents.status).toBe('zeker');
		});

		it('telt niet op als een regel onleesbaar is', () => {
			const output = receiptOutput({ totaal: field('99.99') });
			output.regels[1]!.bedrag = '1,19';
			const c = checkReceipt(output, NOW);
			expect(c.linesSumCents).toBeNull();
			expect(c.lines).toHaveLength(4);
			expect(c.totalCents.status).toBe('zeker');
		});

		it('rekent fooi mee', () => {
			const c = checkReceipt(
				receiptOutput({
					totaal: field('24.00'),
					regels: [
						{ omschrijving: 'Lunch', bedrag: '21.50', soort: 'artikel' },
						{ omschrijving: 'Fooi', bedrag: '2.50', soort: 'fooi' }
					]
				}),
				NOW
			);
			expect(c.totalCents.status).toBe('zeker');
		});
	});

	describe('datum', () => {
		it('weigert een datum die niet bestaat of niet in de vorm JJJJ-MM-DD staat', () => {
			for (const bad of ['2026-02-30', '20-10-2026', '2026-10-20T10:00', 'gisteren']) {
				const c = checkReceipt(receiptOutput({ datum: field(bad) }), NOW);
				expect(c.date, bad).toMatchObject({
					value: null,
					status: 'onzeker',
					failures: ['ongeldig']
				});
			}
		});

		it('weigert een datum in de toekomst', () => {
			const c = checkReceipt(receiptOutput({ datum: field('2026-10-22') }), NOW);
			expect(c.date).toMatchObject({ status: 'onzeker', failures: ['in_de_toekomst'] });
		});

		it('accepteert vandaag en precies 60 dagen terug, maar niet ouder', () => {
			expect(checkReceipt(receiptOutput({ datum: field('2026-10-21') }), NOW).date.status).toBe(
				'zeker'
			);
			expect(checkReceipt(receiptOutput({ datum: field('2026-08-22') }), NOW).date.status).toBe(
				'zeker'
			);
			const old = checkReceipt(receiptOutput({ datum: field('2026-08-21') }), NOW);
			expect(old.date).toMatchObject({ status: 'onzeker', failures: ['te_oud'] });
		});
	});

	describe('valuta', () => {
		it('maakt hoofdletters van een code en weigert wat geen ISO-code is', () => {
			expect(checkReceipt(receiptOutput({ valuta: field('usd') }), NOW).currency.value).toBe('USD');
			const bad = checkReceipt(receiptOutput({ valuta: field('€') }), NOW);
			expect(bad.currency).toMatchObject({ value: null, failures: ['ongeldig'] });
			expect(bad.outcome).toBe('onzeker');
		});
	});

	it('laat een onbekende betaalwijze de uitkomst niet bepalen', () => {
		const c = checkReceipt(receiptOutput({ betaalwijze: field('', 'onleesbaar') }), NOW);
		expect(c.paymentMethod).toMatchObject({ value: null, status: 'onzeker' });
		expect(c.outcome).toBe('zeker');
	});
});

describe('worst', () => {
	it('kiest de slechtste uitkomst', () => {
		expect(worst([])).toBe('zeker');
		expect(worst(['zeker', 'controleren'])).toBe('controleren');
		expect(worst(['onzeker', 'controleren', 'zeker'])).toBe('onzeker');
	});
});

describe('checkList', () => {
	// Een screenshot van een bankapp, gemaakt op 21 oktober 2026 (NOW)
	it('houdt het teken en de valuta per transactie, in hele centen', () => {
		const c = checkList(
			listOutput([
				listItem('2026-10-20', 'Supermarkt Voorbeeld', '-23.45'),
				listItem('2026-10-19', 'Werkgever Voorbeeld', '2150.00'),
				listItem('2026-10-18', 'Koffiebar Voorbeeld', '-6.5', 'usd')
			]),
			NOW
		);
		expect(c.outcome).toBe('zeker');
		expect(
			c.items.map((i) => [
				i.date.value,
				i.counterparty.value,
				i.amountCents.value,
				i.currency.value
			])
		).toEqual([
			['2026-10-20', 'Supermarkt Voorbeeld', -2345, 'EUR'],
			['2026-10-19', 'Werkgever Voorbeeld', 215000, 'EUR'],
			['2026-10-18', 'Koffiebar Voorbeeld', -650, 'USD']
		]);
	});

	it('datum niet in de toekomst en niet ouder dan 60 dagen', () => {
		const c = checkList(
			listOutput([
				listItem('2026-10-22', 'Morgen', '-1.00'),
				listItem('2026-08-21', 'Precies 61 dagen', '-1.00'),
				listItem('2026-08-22', 'Precies 60 dagen', '-1.00'),
				listItem('21-10-2026', 'Verkeerde vorm', '-1.00')
			]),
			NOW
		);
		expect(c.items.map((i) => [i.date.status, i.date.failures])).toEqual([
			['onzeker', ['in_de_toekomst']],
			['onzeker', ['te_oud']],
			['zeker', []],
			['onzeker', ['ongeldig']]
		]);
		expect(c.items[3]!.date.value).toBeNull();
		expect(c.outcome).toBe('onzeker');
	});

	it('bedrag aanwezig, leesbaar en niet nul', () => {
		const item = (bedrag: string) => listItem('2026-10-20', 'Voorbeeld', bedrag);
		const c = checkList(
			listOutput([item(''), item('12,50'), item('0.00'), item('-1e3'), item('-0.01')]),
			NOW
		);
		expect(c.items.map((i) => [i.amountCents.value, i.amountCents.failures])).toEqual([
			[null, ['leeg']],
			[null, ['ongeldig']],
			[0, ['nul']],
			[null, ['ongeldig']],
			[-1, []]
		]);
		expect(c.items.map((i) => i.outcome)).toEqual([
			'onzeker',
			'onzeker',
			'onzeker',
			'onzeker',
			'zeker'
		]);
	});

	it('valuta is een ISO-code; een lege naam is onzeker', () => {
		const output = listOutput([
			listItem('2026-10-20', 'Voorbeeld', '-1.00', '€'),
			listItem('2026-10-20', '  ', '-1.00', 'EURO'),
			listItem('2026-10-20', 'Voorbeeld', '-1.00', 'gbp')
		]);
		const c = checkList(output, NOW);
		expect(c.items.map((i) => [i.currency.value, i.currency.failures])).toEqual([
			[null, ['ongeldig']],
			[null, ['ongeldig']],
			['GBP', []]
		]);
		expect(c.items[1]!.counterparty).toMatchObject({
			value: null,
			status: 'onzeker',
			failures: ['leeg']
		});
	});

	it('twijfel van het model wordt controleren; onleesbaar met een waarde is onzeker', () => {
		const output = listOutput([listItem('2026-10-20', 'Voorbeeld', '-1.00')]);
		output.transacties[0]!.tegenpartij = field('Voorbeeld', 'twijfel', 'Half verborgen');
		const doubt = checkList(output, NOW);
		expect(doubt.items[0]!.counterparty).toMatchObject({
			status: 'controleren',
			note: 'Half verborgen'
		});
		expect(doubt.outcome).toBe('controleren');

		output.transacties[0]!.bedrag = field('-1.00', 'onleesbaar');
		expect(checkList(output, NOW).items[0]!.amountCents.failures).toEqual(['onleesbaar']);
	});

	it('een lijst zonder transacties is onzeker', () => {
		expect(checkList(listOutput([]), NOW)).toEqual({ items: [], outcome: 'onzeker' });
	});
});
