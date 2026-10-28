import { describe, expect, it } from 'vitest';
import {
	checkSentences,
	fixedSentences,
	isNotable,
	MAX_FACTS,
	pickFacts,
	runStart,
	sinceText,
	type Fact,
	type Series
} from './summary.ts';

// Maandsamenvatting: de keuze van de feiten, de controle op wat het model schreef en de vaste
// tekst (spec: Maandsamenvatting, Tests). Zonder model: de controle draait op verzonnen uitvoer.

const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
const series = (name: string, values: (number | null)[], kind: Series['kind'] = 'categorie') => ({
	kind,
	name,
	values
});

describe('wat opvalt', () => {
	it('vraagt minstens € 25 én 30% verschil met het gemiddelde van drie maanden', () => {
		expect(isNotable(12_000, 9_000)).toBe(true); // € 30, 33%
		expect(isNotable(11_400, 9_000)).toBe(false); // € 24
		expect(isNotable(40_000, 36_000)).toBe(false); // € 40, maar 11%
		expect(isNotable(6_000, 9_000)).toBe(true); // daling van € 30, 33%
		expect(isNotable(2_500, 0)).toBe(true); // nieuw
	});

	it('zonder historie zijn er geen feiten', () => {
		const s = series('Uit eten', [null, null, null, null, null, null, 18_000]);
		expect(pickFacts([s], MONTHS)).toEqual([]);
	});

	it('niets opvallends geeft geen feiten', () => {
		const s = series('Boodschappen', [30_000, 31_000, 29_500, 30_500, 30_000, 31_000, 32_000]);
		expect(pickFacts([s], MONTHS)).toEqual([]);
	});

	it('een stijging met het gemiddelde van drie en zes maanden', () => {
		const s = series('Uit eten', [9_000, 9_000, 9_000, 9_100, 9_000, 9_200, 18_400]);
		const [f] = pickFacts([s], MONTHS);
		expect(f).toEqual({
			id: 'f1',
			soort: 'categorie',
			naam: 'Uit eten',
			nu: 18_400,
			gem3: 9_100,
			gem6: 9_050,
			verschil: 9_300,
			richting: 'hoger',
			sinds: null,
			nieuw: false
		});
	});

	it('een maand zonder gegevens telt niet mee in het gemiddelde', () => {
		const s = series('Vervoer', [null, null, null, null, null, 4_000, 9_000]);
		expect(pickFacts([s], MONTHS)[0]).toMatchObject({ gem3: 4_000, gem6: 4_000 });
	});

	it('een nieuwe categorie of tegenpartij is nieuw', () => {
		const s = series('Sportschool', [0, 0, 0, 0, 0, 0, 3_500], 'tegenpartij');
		expect(pickFacts([s], MONTHS)[0]).toMatchObject({ nieuw: true, gem3: 0, verschil: 3_500 });
	});

	it('een terugboeking die de maand per saldo negatief maakt, is een daling', () => {
		const s = series(
			'Webwinkel',
			[4_000, 5_000, 4_500, 5_000, 4_000, 5_000, -6_000],
			'tegenpartij'
		);
		expect(pickFacts([s], MONTHS)[0]).toMatchObject({
			nu: -6_000,
			richting: 'lager',
			verschil: 10_667,
			nieuw: false
		});
	});

	it('hooguit vijf feiten, het grootste verschil in euro eerst', () => {
		const list = [10, 70, 30, 50, 20, 60, 40].map((euros) =>
			series(`Categorie ${euros}`, [0, 0, 0, 0, 0, 0, euros * 100])
		);
		const facts = pickFacts(list, MONTHS);
		expect(facts).toHaveLength(MAX_FACTS);
		expect(facts.map((f) => f.naam)).toEqual([
			'Categorie 70',
			'Categorie 60',
			'Categorie 50',
			'Categorie 40',
			'Categorie 30'
		]);
		expect(facts.map((f) => f.id)).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
	});

	it('een samenvattingsmaand zonder gegevens (bijvoorbeeld zonder bonregels) doet niet mee', () => {
		const s = series(
			'Zuivel en eieren',
			[3_000, 3_000, 3_000, 3_000, 3_000, 3_000, null],
			'productgroep'
		);
		expect(pickFacts([s], MONTHS)).toEqual([]);
	});
});

describe('sinds wanneer', () => {
	const k = (...euros: (number | null)[]) => euros.map((e) => (e === null ? null : e * 100));

	it('loopt een stijging pas vanaf twee maanden achter elkaar', () => {
		expect(runStart(k(90, 90, 90, 90, 90, 130, 184), MONTHS, 'hoger')).toBe('2026-07');
		expect(runStart(k(90, 90, 90, 90, 90, 90, 184), MONTHS, 'hoger')).toBeNull();
		expect(runStart(k(90, 120, 150, 190, 240, 300, 400), MONTHS, 'hoger')).toBe('2026-03');
	});

	it('een kleine eerste stap is geen begin van een stijging', () => {
		expect(runStart(k(90, 90, 90, 90, 90, 92, 184), MONTHS, 'hoger')).toBeNull();
		expect(runStart(k(90, 90, 90, 90, 91, 130, 184), MONTHS, 'hoger')).toBe('2026-07');
	});

	it('een daling, en een maand zonder gegevens onderbreekt de reeks', () => {
		expect(runStart(k(300, 300, 300, 300, 200, 120, 60), MONTHS, 'lager')).toBe('2026-06');
		expect(runStart(k(null, null, null, null, 50, 100, 200), MONTHS, 'hoger')).toBe('2026-07');
	});

	it('staat als maandnaam, met het jaar alleen als dat anders is', () => {
		expect(sinceText('2026-03', '2026-09')).toBe('maart');
		expect(sinceText('2025-11', '2026-01')).toBe('november 2025');
	});
});

const FACTS: Fact[] = [
	{
		id: 'f1',
		soort: 'categorie',
		naam: 'Uit eten en bezorgen',
		nu: 18_400,
		gem3: 9_100,
		gem6: 8_800,
		verschil: 9_300,
		richting: 'hoger',
		sinds: '2026-03',
		nieuw: false
	},
	{
		id: 'f2',
		soort: 'tegenpartij',
		naam: 'Thuisbezorgd',
		nu: 6_200,
		gem3: 2_000,
		gem6: 1_500,
		verschil: 4_200,
		richting: 'hoger',
		sinds: null,
		nieuw: false
	}
];
const MONTH = '2026-09';
// Intl zet een harde spatie tussen € en het bedrag; voor de vergelijking maakt dat niet uit
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value).replace(/\s/g, ' ')) as T;
const NAMES = ['Boodschappen', 'Albert Heijn', 'Sanne'];
const check = (tekst: string, feiten = ['f1']) =>
	checkSentences([{ tekst, feiten }], FACTS, MONTH, NAMES);

describe('controle op de zinnen', () => {
	it('vult de placeholders in en houdt bedragen apart', () => {
		const r = check('{f1.naam} verdubbelde sinds {f1.sinds} naar {f1.nu}, tegenover {f1.gem3}.');
		expect(plain(r)).toEqual({
			ok: true,
			sentences: [
				{
					tekst: 'Uit eten en bezorgen verdubbelde sinds maart naar € 184, tegenover € 91.',
					delen: [
						{ text: 'Uit eten en bezorgen', num: false },
						{ text: ' verdubbelde sinds ', num: false },
						{ text: 'maart', num: false },
						{ text: ' naar ', num: false },
						{ text: '€ 184', num: true },
						{ text: ', tegenover ', num: false },
						{ text: '€ 91', num: true },
						{ text: '.', num: false }
					],
					feiten: ['f1']
				}
			]
		});
	});

	it('een feit in een placeholder hoort bij de zin, ook als het model het vergat', () => {
		const r = check('Je gaf meer uit aan {f1.naam} en bij {f2.naam}.');
		expect(r.ok && r.sentences[0]!.feiten).toEqual(['f1', 'f2']);
	});

	it('weigert een vrij cijfer', () => {
		expect(check('{f1.naam} steeg met 50 procent.')).toEqual({ ok: false, failure: 'cijfer' });
		expect(check('{f1.naam} kostte € 184.')).toEqual({ ok: false, failure: 'cijfer' });
	});

	it('weigert een naam die letterlijk in de zin staat', () => {
		expect(check('je gaf meer uit aan uit eten en bezorgen, {f1.nu}.')).toEqual({
			ok: false,
			failure: 'naam'
		});
		// Een naam die de app kent, maar niet als feit meeging
		expect(check('{f1.naam} steeg, net als boodschappen.')).toEqual({ ok: false, failure: 'naam' });
	});

	it('weigert een verzonnen naam', () => {
		expect(check('{f1.naam} steeg vooral door Netflix.')).toEqual({ ok: false, failure: 'naam' });
	});

	it('weigert een domein, link of e-mailadres', () => {
		expect(check('{f1.naam} steeg, kijk op voorbeeld.nl.')).toEqual({
			ok: false,
			failure: 'domein'
		});
		expect(check('{f1.naam} steeg, zie www voorbeeld.')).toEqual({ ok: false, failure: 'domein' });
		expect(check('{f1.naam} steeg en/of daalde.')).toEqual({ ok: false, failure: 'domein' });
		expect(check('mail iemand@voorbeeld over {f1.naam}.')).toEqual({
			ok: false,
			failure: 'domein'
		});
	});

	it('weigert een onbekend id, ook als placeholder', () => {
		expect(check('{f1.naam} steeg.', ['f9'])).toEqual({ ok: false, failure: 'onbekend_feit' });
		expect(check('{f7.naam} steeg.')).toEqual({ ok: false, failure: 'onbekend_feit' });
	});

	it('weigert een onbekend veld of een sinds die er niet is', () => {
		expect(check('{f1.procent} meer.')).toEqual({ ok: false, failure: 'placeholder' });
		expect(check('{f2.naam} steeg sinds {f2.sinds}.', ['f2'])).toEqual({
			ok: false,
			failure: 'placeholder'
		});
		expect(check('{f1.naam steeg.')).toEqual({ ok: false, failure: 'placeholder' });
	});

	it('weigert een maandnaam: die komt alleen uit een placeholder', () => {
		expect(check('{f1.naam} steeg sinds maart.')).toEqual({ ok: false, failure: 'maand' });
	});

	it('weigert meer dan vier zinnen, geen zinnen en te lange zinnen', () => {
		const one = { tekst: '{f1.naam} steeg.', feiten: ['f1'] };
		expect(checkSentences([one, one, one, one, one], FACTS, MONTH)).toEqual({
			ok: false,
			failure: 'aantal'
		});
		expect(checkSentences([], FACTS, MONTH)).toEqual({ ok: false, failure: 'aantal' });
		expect(check(`{f1.naam} steeg ${'heel '.repeat(40)}erg.`)).toEqual({
			ok: false,
			failure: 'te_lang'
		});
	});

	it('weigert HTML-tekens en regeleinden', () => {
		expect(check('<b>{f1.naam}</b> steeg.')).toEqual({ ok: false, failure: 'teken' });
		expect(check('{f1.naam}\nsteeg.')).toEqual({ ok: false, failure: 'teken' });
	});
});

describe('vaste tekst', () => {
	it('één zin per feit, met dezelfde getallen', () => {
		const [a, b] = plain(fixedSentences(FACTS, MONTH));
		expect(a).toMatchObject({
			tekst:
				'Uit eten en bezorgen kostte € 184, € 93 meer dan gemiddeld (€ 91); de stijging loopt sinds maart.',
			feiten: ['f1']
		});
		expect(b!.tekst).toBe('Thuisbezorgd kostte € 62, € 42 meer dan gemiddeld (€ 20).');
	});

	it('nieuw, een daling en per saldo geld terug', () => {
		const [nieuw, daling] = plain(
			fixedSentences(
				[
					{ ...FACTS[0]!, naam: 'huisgenoot A', nieuw: true, nu: 3_000, sinds: null },
					{
						...FACTS[0]!,
						id: 'f2',
						naam: 'verrekening huisgenoten',
						nu: -4_000,
						gem3: -1_000,
						verschil: 3_000,
						richting: 'lager',
						sinds: null
					}
				],
				MONTH
			)
		);
		expect(nieuw!.tekst).toBe('Huisgenoot A is nieuw en kostte € 30.');
		expect(daling!.tekst).toBe(
			'Verrekening huisgenoten kwam uit op −€ 40, € 30 minder dan gemiddeld (−€ 10).'
		);
	});

	it('haalt zelf de controle', () => {
		const sentences = fixedSentences(FACTS, MONTH);
		expect(sentences.every((s) => s.tekst.length <= 200)).toBe(true);
	});
});
