import { describe, expect, it } from 'vitest';
import { checkList, checkReceipt } from './checks.ts';
import {
	aggregate,
	conceptLines,
	formatReport,
	LabelFileSchema,
	labelId,
	normalizeStore,
	scoreBon,
	scoreLines,
	scoreList,
	storeMatches,
	uploadMoment,
	zekerPrecision,
	type BonResult,
	type Label,
	type ListLabel
} from './eval.ts';
import { field, listItem, listOutput, receiptOutput } from './fixtures.ts';
import type { ReadUsage } from './reader.ts';

// Verzonnen labels; echte bonnen en labels staan buiten de repo.

const label = (overrides: Partial<Label> = {}): Label =>
	LabelFileSchema.parse({
		bonnen: [
			{
				bestanden: ['bon-01.jpg'],
				winkel: 'Supermarkt Voorbeeld',
				datum: '2026-10-20',
				totaal: '7,37',
				betaalwijze: 'pin',
				...overrides
			}
		]
	}).bonnen[0]!;

const usage: ReadUsage = {
	model: 'claude-haiku-5-5',
	parts: 1,
	inputTokens: 3000,
	outputTokens: 400,
	costNanoUsd: 500_000,
	durationMs: 1200
};

function score(l: Label, output = receiptOutput()): BonResult {
	return scoreBon(l, '2576', { ok: true, checked: checkReceipt(output, uploadMoment(l)), usage });
}

describe('labels.json', () => {
	it('vult valuta aan en leidt id en uploadmoment af', () => {
		const l = label();
		expect(l.valuta).toBe('EUR');
		expect(labelId(l)).toBe('bon-01');
		expect(labelId(label({ id: 'ah-bonus' }))).toBe('ah-bonus');
		expect(uploadMoment(l)).toEqual(new Date(2026, 9, 21, 12));
		expect(uploadMoment(label({ ontvangen: '2026-10-25' }))).toEqual(new Date(2026, 9, 25, 12));
	});

	it('accepteert alleen bestandsnamen, geen paden', () => {
		for (const bad of [
			'../bon.jpg',
			'map/bon.jpg',
			'/etc/passwd.jpg',
			'.verborgen.jpg',
			'bon.heic'
		]) {
			expect(() => label({ bestanden: [bad] }), bad).toThrow();
		}
	});

	it('weigert ongeldige datums, bedragen en onbekende velden', () => {
		expect(() => label({ datum: '20-10-2026' })).toThrow();
		expect(() => label({ totaal: '7.37.1' })).toThrow();
		expect(() => label({ totaal: '0' })).toThrow();
		expect(() => LabelFileSchema.parse({ bonnen: [{ ...label(), extra: true }] })).toThrow();
	});
});

describe('storeMatches', () => {
	it('negeert hoofdletters, accenten, leestekens en rechtsvorm', () => {
		expect(normalizeStore('Café Één B.V.')).toBe('cafeeen');
		expect(storeMatches('Café Één', 'CAFE EEN BV')).toBe(true);
	});

	it('accepteert een filiaalnummer erachter en een lijst namen', () => {
		expect(storeMatches('Supermarkt Voorbeeld', 'SUPERMARKT VOORBEELD 0001')).toBe(true);
		expect(storeMatches(['SV', 'Supermarkt Voorbeeld'], 'Supermarkt Voorbeeld')).toBe(true);
	});

	it('laat korte namen niet in andere namen matchen', () => {
		expect(storeMatches('SV', 'SV Bakkerij')).toBe(false);
		expect(storeMatches('Bakker', '')).toBe(false);
		expect(storeMatches('Bakkerij Test', 'Slagerij Test')).toBe(false);
	});
});

describe('scoreBon', () => {
	it('vergelijkt elk veld met het label', () => {
		const r = score(label());
		expect(r.outcome).toBe('zeker');
		expect(r.fields.totaal).toEqual({
			labeled: true,
			filled: true,
			correct: true,
			status: 'zeker'
		});
		expect(r.fields.winkel?.correct).toBe(true);
		expect(r.fields.datum?.correct).toBe(true);
		expect(r.fields.valuta?.correct).toBe(true);
		expect(r.fields.betaalwijze?.correct).toBe(true);
	});

	it('ziet een fout totaal dat de controles toch doorkomt', () => {
		const r = score(label({ totaal: '7,73' }));
		expect(r.fields.totaal).toMatchObject({ correct: false, status: 'zeker' });
	});

	it('telt een leeg veld als niet gevuld en niet goed', () => {
		const r = score(label(), receiptOutput({ datum: field('', 'onleesbaar') }));
		expect(r.fields.datum).toMatchObject({ filled: false, correct: false, status: 'onzeker' });
	});

	it('slaat betaalwijze over als die niet gelabeld is', () => {
		const r = score(label({ betaalwijze: undefined }));
		expect(r.fields.betaalwijze?.labeled).toBe(false);
	});

	it('neemt een mislukte lezing op zonder velden', () => {
		const r = scoreBon(label(), '1600', { ok: false, reason: 'weigering', usage });
		expect(r).toMatchObject({ outcome: 'weigering', fields: {}, variant: '1600' });
	});
});

describe('aggregate', () => {
	const results = [
		score(label({ id: 'a' })),
		score(label({ id: 'b', totaal: '7,73' })), // zeker maar fout
		score(label({ id: 'c' }), receiptOutput({ totaal: field('7.37', 'twijfel') })),
		scoreBon(label({ id: 'd' }), '2576', { ok: false, reason: 'fout', usage: null })
	];
	const report = aggregate('2576', results);

	it('telt uitkomsten, mislukte lezingen en "zeker maar fout"', () => {
		expect(report.bonnen).toBe(4);
		expect(report.failed).toBe(1);
		expect(report.outcomes).toEqual({ zeker: 2, controleren: 1, onzeker: 0 });
		expect(report.outcomeZekerWrong).toBe(1);
		expect(report.zekerWrongIds).toEqual([{ id: 'b', field: 'totaal' }]);
	});

	it('meet per veld goed, gevuld en de nauwkeurigheid bij zeker', () => {
		expect(report.fields.totaal).toEqual({
			total: 4,
			correct: 2,
			filled: 3,
			zeker: 2,
			zekerWrong: 1,
			controleren: 1,
			onzeker: 1
		});
		expect(zekerPrecision(report.fields.totaal)).toBe(0.5);
		expect(report.fields.betaalwijze.total).toBe(3);
	});

	it('telt tokens, kosten en de mediane duur van de geslaagde aanroepen', () => {
		expect(report.inputTokens).toBe(9000);
		expect(report.costNanoUsd).toBe(1_500_000);
		expect(report.durationMsP50).toBe(1200);
	});

	it('geeft geen nauwkeurigheid als niets zeker was', () => {
		expect(zekerPrecision(aggregate('1600', []).fields.totaal)).toBeNull();
	});

	it('toont het doel en geen bedragen of winkelnamen in het rapport', () => {
		const text = formatReport([report]);
		expect(text).toContain('Variant 2576: 4 bonnen, 1 mislukt');
		expect(text).toContain('doel NIET gehaald');
		expect(text).toContain('b (totaal)');
		expect(text).not.toMatch(/7[.,]73|7[.,]37|Supermarkt/);
		const good = formatReport([aggregate('2576', [results[0]!])]);
		expect(good).toContain('doel gehaald');
	});
});

describe('screenshots met transacties', () => {
	const listLabel = (overrides: Partial<ListLabel> = {}): ListLabel =>
		LabelFileSchema.parse({
			lijsten: [
				{
					id: 'lijst',
					bestanden: ['lijst-01.png'],
					transacties: [
						{ datum: '2026-10-20', tegenpartij: ['Supermarkt Voorbeeld', 'SV'], bedrag: '-23,45' },
						{ datum: '2026-10-19', tegenpartij: 'Werkgever Voorbeeld', bedrag: '2.150,00' },
						{
							datum: '2026-10-18',
							tegenpartij: 'Koffiebar Voorbeeld',
							bedrag: '-6,50',
							valuta: 'USD'
						}
					],
					...overrides
				}
			]
		}).lijsten[0]!;

	const scored = (l: ListLabel, items: ReturnType<typeof listItem>[]) => {
		const output = listOutput(items);
		const now = uploadMoment(l);
		return scoreList(l, '2576', {
			ok: true,
			checked: checkReceipt(output, now),
			list: checkList(output, now),
			usage
		});
	};

	it('labels.json: bonnen en lijsten naast elkaar, één van de twee mag ontbreken', () => {
		const l = listLabel();
		expect(l.transacties[0]!.valuta).toBe('EUR');
		expect(labelId(l)).toBe('lijst');
		// De dag na de laatste transactie
		expect(uploadMoment(l)).toEqual(new Date(2026, 9, 21, 12));
		expect(LabelFileSchema.parse({ lijsten: [l] }).bonnen).toEqual([]);
		expect(() => LabelFileSchema.parse({})).toThrow();
		expect(() => LabelFileSchema.parse({ bonnen: [], lijsten: [] })).toThrow();
		const tx = (bedrag: string) => ({ datum: '2026-10-20', tegenpartij: 'X', bedrag });
		expect(() => listLabel({ transacties: [tx('0,00')] as ListLabel['transacties'] })).toThrow();
		expect(() => listLabel({ transacties: [tx('-1.2.3')] as ListLabel['transacties'] })).toThrow();
		expect(() => listLabel({ transacties: [] })).toThrow();
		expect(() => LabelFileSchema.parse({ lijsten: [{ ...listLabel(), winkel: 'X' }] })).toThrow();
	});

	it('koppelt per transactie, ook in een andere volgorde, en vindt gemist en extra', () => {
		const r = scored(listLabel(), [
			listItem('2026-10-19', 'WERKGEVER VOORBEELD', '2150.00'),
			// Bedrag fout gelezen, maar datum en naam kloppen: gevonden, niet goed
			listItem('2026-10-20', 'Supermarkt Voorbeeld 0001', '-23.54'),
			// Verzonnen
			listItem('2026-10-20', 'Iets anders', '-1.00')
		]);
		expect(r).toMatchObject({ kind: 'lijst', beeld: 'lijst', outcome: 'zeker' });
		expect(r.list!.items.map((i) => [i.found, i.correct])).toEqual([
			[true, false],
			[true, true],
			[false, false]
		]);
		expect(r.list!.items[0]!.fields.bedrag).toMatchObject({ correct: false, status: 'zeker' });
		expect(r.list!.items[0]!.fields.tegenpartij?.correct).toBe(true);
		expect(r.list).toMatchObject({ extra: 1, extraZeker: 1 });
	});

	it('een lijst die als bon gelezen wordt vindt niets; een bon als lijst valt op', () => {
		const asBon = scoreList(listLabel(), '2576', {
			ok: true,
			checked: checkReceipt(receiptOutput(), uploadMoment(listLabel())),
			list: null,
			usage
		});
		expect(asBon).toMatchObject({ beeld: 'bon', outcome: 'onzeker' });
		expect(asBon.list!.items.every((i) => !i.found)).toBe(true);

		const output = listOutput([listItem('2026-10-20', 'Supermarkt Voorbeeld', '-7.37')]);
		const bonAsList = scoreBon(label(), '2576', {
			ok: true,
			checked: checkReceipt(output, uploadMoment(label())),
			list: checkList(output, uploadMoment(label())),
			usage
		});
		expect(bonAsList).toMatchObject({ kind: 'bon', beeld: 'lijst' });
		expect(bonAsList.fields.totaal?.filled).toBe(false);
	});

	it('telt lijsten apart van bonnen, met "zeker maar fout" per transactie', () => {
		const good = scored(listLabel({ id: 'goed' }), [
			listItem('2026-10-20', 'SV', '-23.45'),
			listItem('2026-10-19', 'Werkgever Voorbeeld', '2150.00'),
			listItem('2026-10-18', 'Koffiebar Voorbeeld', '-6.50', 'USD')
		]);
		const wrong = scored(listLabel({ id: 'fout' }), [
			listItem('2026-10-20', 'Supermarkt Voorbeeld', '-23.45', 'USD'),
			listItem('2026-10-18', 'Koffiebar Voorbeeld', '-6.50', 'USD'),
			listItem('2026-10-17', 'Iets anders', '-1.00')
		]);
		const failed = scoreList(listLabel({ id: 'mislukt' }), '2576', {
			ok: false,
			reason: 'weigering',
			usage
		});
		const report = aggregate('2576', [score(label({ id: 'bon' })), good, wrong, failed]);

		expect(report.bonnen).toBe(1);
		expect(report.fields.totaal.total).toBe(1);
		expect(report.inputTokens).toBe(12_000);
		const l = report.lists!;
		expect(l).toMatchObject({
			lijsten: 3,
			failed: 1,
			readAsBon: 0,
			bonAsList: 0,
			transactions: 9,
			found: 5,
			correct: 4,
			outcomes: { zeker: 5, controleren: 0, onzeker: 0 },
			zekerWrong: 1,
			extra: 1,
			extraZeker: 1
		});
		expect(l.fields.valuta).toMatchObject({
			total: 9,
			correct: 4,
			zeker: 5,
			zekerWrong: 1,
			onzeker: 4
		});
		expect(l.zekerWrongIds).toEqual([{ id: 'fout', item: 1, field: 'valuta' }]);
		expect(aggregate('2576', [score(label())]).lists).toBeNull();

		const text = formatReport([report]);
		expect(text).toContain('Lijsten: 3 screenshots, 1 mislukt');
		expect(text).toContain('9 gelabeld, 5 gevonden, 4 helemaal goed');
		expect(text).toContain('fout #1 (valuta)');
		expect(text).not.toMatch(/23[.,]45|2[.]?150|Werkgever|Koffiebar/);
	});
});

describe('regels en productgroep', () => {
	const regels: Label['regels'] = [
		{ bedrag: '2,49', groep: 'brood_ontbijt', omschrijving: 'Brood' },
		{ bedrag: '1,19', groep: 'voorraad' }, // Haiku zegt zuivel_eieren
		{ bedrag: '4,29', groep: 'zuivel_eieren' },
		{ bedrag: '3,00', groep: 'groente_fruit' } // niet gelezen
	];
	const checked = (output = receiptOutput()) => checkReceipt(output, uploadMoment(label()));

	it('labels.json: artikelen met bedrag en een groep uit de vaste lijst', () => {
		expect(label({ regels }).regels).toHaveLength(4);
		const bad = (r: unknown) =>
			LabelFileSchema.safeParse({
				bonnen: [
					{
						bestanden: ['a.jpg'],
						winkel: 'X',
						datum: '2026-10-20',
						totaal: '1,00',
						regels: [r]
					}
				]
			}).success;
		expect(bad({ bedrag: '1,00', groep: 'zuivel' })).toBe(false);
		expect(bad({ bedrag: '0,00', groep: 'overig' })).toBe(false);
		expect(bad({ bedrag: '1,00', groep: 'overig', soort: 'korting' })).toBe(false);
		expect(bad({ bedrag: '1,00', groep: 'overig' })).toBe(true);
	});

	it('alle regels gevuld: samen het gelabelde totaal, ook zonder gelabelde artikelen', () => {
		expect(scoreLines(label(), checked())).toEqual({ complete: true, groups: null });
		expect(scoreLines(label({ totaal: '7,73' }), checked()).complete).toBe(false);
		expect(scoreLines(label(), checked(receiptOutput({ regels: [] }))).complete).toBe(false);
		expect(scoreLines(label(), null).complete).toBe(false);
	});

	it('koppelt gelabelde artikelen op bedrag en volgorde, en telt goed in aantal en in geld', () => {
		expect(scoreLines(label({ regels }), checked()).groups).toEqual({
			labeled: 4,
			matched: 3,
			correct: 2,
			labeledCents: 249 + 119 + 429 + 300,
			correctCents: 249 + 429
		});
	});

	it('twee artikelen met hetzelfde bedrag krijgen elk hun eigen gelezen regel', () => {
		const output = receiptOutput({
			totaal: field('2.00'),
			regels: [
				{ omschrijving: 'A', bedrag: '1.00', soort: 'artikel', productgroep: 'alcohol' },
				{ omschrijving: 'B', bedrag: '1.00', soort: 'artikel', productgroep: 'voorraad' }
			]
		});
		const l = label({
			totaal: '2,00',
			regels: [
				{ bedrag: '1,00', groep: 'alcohol' },
				{ bedrag: '1,00', groep: 'voorraad' }
			]
		});
		expect(scoreLines(l, checked(output)).groups).toMatchObject({ matched: 2, correct: 2 });
	});

	it('telt over de bonnen op, zonder omschrijvingen of bedragen in het rapport', () => {
		const results = [
			score(label({ id: 'a', regels })),
			score(label({ id: 'b' })),
			score(label({ id: 'c', totaal: '7,73' })),
			scoreBon(label({ id: 'd', regels }), '2576', { ok: false, reason: 'fout', usage: null })
		];
		const report = aggregate('2576', results);
		expect(report.lines).toEqual({
			complete: 2,
			bonnen: 4,
			labeledBonnen: 2,
			groups: {
				labeled: 8,
				matched: 3,
				correct: 2,
				labeledCents: 2 * 1097,
				correctCents: 678
			},
			// De mislukte lezing (d) telt niet mee voor het doel: die heeft geen gevulde regels
			completeGroups: {
				labeled: 4,
				matched: 3,
				correct: 2,
				labeledCents: 1097,
				correctCents: 678
			},
			wrongIds: [
				{ id: 'a', wrong: 2 },
				{ id: 'd', wrong: 4 }
			]
		});
		const text = formatReport([report]);
		expect(text).toContain('alle regels gevuld bij 2 van 4 bonnen (50.0%)');
		expect(text).toContain(
			'productgroep: 8 artikelen gelabeld in 2 bonnen, 3 gevonden, 2 goede groep'
		);
		expect(text).toContain('a (2), d (4)');
		expect(text).toContain(
			'productgroep bij gevulde regels: 50.0% goed, doel NIET gehaald (< 90%)'
		);
		expect(text).not.toMatch(/Brood|Melk|2[.,]49|4[.,]29/);
		expect(formatReport([aggregate('2576', [results[1]!])])).toContain('geen artikelen gelabeld');
	});

	it('maakt een begin voor de labels uit wat Haiku las, alleen artikelen', () => {
		expect(conceptLines(checked())).toEqual([
			{ omschrijving: 'Brood', bedrag: '2,49', groep: 'brood_ontbijt' },
			{ omschrijving: 'Melk', bedrag: '1,19', groep: 'zuivel_eieren' },
			{ omschrijving: 'Kaas', bedrag: '4,29', groep: 'zuivel_eieren' }
		]);
		// Het begin past in labels.json
		expect(label({ regels: conceptLines(checked()) }).regels).toHaveLength(3);
	});
});
