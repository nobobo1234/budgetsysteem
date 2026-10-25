import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { splitEqually } from '../owed.ts';
import { MAX_INPUT, parseQuickEntry, splitPeople } from './parser.ts';

// Vrijdag 23 oktober 2026
const TODAY = '2026-10-23';
const opts = { accountAliases: ['sns', 'rev'] };
const parse = (input: string) => parseQuickEntry(input, TODAY, opts);

describe('voorbeelden uit de spec', () => {
	it('12,50 ah', () => {
		const r = parse('12,50 ah');
		expect(r.amountCents).toBe(1250);
		expect(r.direction).toBe('uit');
		expect(r.currency).toBe('EUR');
		expect(r.text).toBe('ah');
		expect(r.date).toBe(TODAY);
	});

	it('$20 netflix rev', () => {
		const r = parse('$20 netflix rev');
		expect(r.amountCents).toBe(2000);
		expect(r.currency).toBe('USD');
		expect(r.account).toBe('rev');
		expect(r.text).toBe('netflix');
	});

	it('45 etentje voor 3', () => {
		const r = parse('45 etentje voor 3');
		expect(r.amountCents).toBe(4500);
		expect(r.splitCount).toBe(3);
		expect(r.text).toBe('etentje');
	});

	it('+15 tikkie sanne', () => {
		const r = parse('+15 tikkie sanne');
		expect(r.amountCents).toBe(1500);
		expect(r.direction).toBe('in');
		expect(r.text).toBe('tikkie sanne');
	});
});

describe('bedrag', () => {
	it.each([
		['12,50', 1250, 'uit', 'EUR'],
		['€12.50', 1250, 'uit', 'EUR'],
		['12,50€', 1250, 'uit', 'EUR'],
		['+15', 1500, 'in', 'EUR'],
		['$20', 2000, 'uit', 'USD'],
		['+$20', 2000, 'in', 'USD'],
		['-7', 700, 'uit', 'EUR']
	])('%s', (input, cents, direction, currency) => {
		const r = parse(input);
		expect(r.amountCents).toBe(cents);
		expect(r.direction).toBe(direction);
		expect(r.currency).toBe(currency);
		expect(r.spans).toEqual([{ start: 0, end: input.length, kind: 'bedrag', text: input }]);
	});

	it('neemt alleen het eerste bedrag; de rest is tekst', () => {
		const r = parse('ah 12,50 3');
		expect(r.amountCents).toBe(1250);
		expect(r.text).toBe('ah 3');
	});

	it('nul is geen bedrag', () => {
		expect(parse('0 ah').amountCents).toBeNull();
	});

	it('zonder bedrag blijft het bedrag leeg', () => {
		expect(parse('albert heijn').amountCents).toBeNull();
	});
});

describe('datum', () => {
	it.each([
		['vandaag', '2026-10-23'],
		['gisteren', '2026-10-22'],
		['eergisteren', '2026-10-21'],
		['vr', '2026-10-23'],
		['do', '2026-10-22'],
		['ma', '2026-10-19'],
		['za', '2026-10-17'],
		['zondag', '2026-10-18'],
		['12/10', '2026-10-12'],
		['12-10', '2026-10-12'],
		['1/1', '2026-01-01'],
		['12/10/2025', '2025-10-12'],
		['12-10-25', '2025-10-12'],
		['30/12', '2025-12-30']
	])('%s wordt %s', (word, iso) => {
		const r = parse(`10 ${word}`);
		expect(r.date).toBe(iso);
		expect(r.dateExplicit).toBe(true);
	});

	it('zonder datum is het vandaag', () => {
		const r = parse('10 ah');
		expect(r.date).toBe(TODAY);
		expect(r.dateExplicit).toBe(false);
	});

	it.each(['31/2', '0/10', '12/13', '32-1'])('weigert de onmogelijke datum %s', (word) => {
		const r = parse(`10 ${word}`);
		expect(r.dateExplicit).toBe(false);
		expect(r.text).toBe(word);
	});

	it('kijkt bij 29 februari niet naar een jaar zonder schrikkeldag', () => {
		expect(parseQuickEntry('10 29/2', '2028-03-01').date).toBe('2028-02-29');
		expect(parseQuickEntry('10 29/2', '2027-03-01').dateExplicit).toBe(false);
	});
});

describe('categorie en rekening', () => {
	it('#categorie', () => {
		const r = parse('8 #boodschappen jumbo');
		expect(r.category).toBe('boodschappen');
		expect(r.text).toBe('jumbo');
	});

	it('#uit-eten met streepjes', () => {
		expect(parse('8 #uit-eten').category).toBe('uit eten');
	});

	it('@rekening en een losse alias', () => {
		expect(parse('8 ah @rev').account).toBe('rev');
		expect(parse('8 ah sns').account).toBe('sns');
	});

	it('een los hekje is gewone tekst', () => {
		expect(parse('8 #').text).toBe('#');
	});
});

describe('delen', () => {
	it('voor 3', () => {
		const r = parse('45 etentje voor 3');
		expect(r.splitCount).toBe(3);
		expect(r.spans.find((s) => s.kind === 'delen')?.text).toBe('voor 3');
	});

	it('voor zonder getal is tekst', () => {
		const r = parse('20 cadeau voor mam');
		expect(r.splitCount).toBeNull();
		expect(r.text).toBe('cadeau voor mam');
	});

	it.each(['voor 1', 'voor 51', 'voor 100'])('%s is geen deling', (part) => {
		expect(parse(`20 ${part}`).splitCount).toBeNull();
	});

	it('met sanne', () => {
		const r = parse('30 lunch met sanne');
		expect(r.splitWith).toEqual(['sanne']);
		expect(r.text).toBe('lunch');
	});

	it('met sanne en tom', () => {
		expect(parse('30 lunch met sanne en tom').splitWith).toEqual(['sanne', 'tom']);
	});

	it('met sanne, tom en eva', () => {
		expect(parse('30 lunch met sanne, tom en eva gisteren').splitWith).toEqual([
			'sanne',
			'tom',
			'eva'
		]);
	});

	it('stopt bij een rekening of datum', () => {
		const r = parse('30 lunch met sanne gisteren rev');
		expect(r.splitWith).toEqual(['sanne']);
		expect(r.date).toBe('2026-10-22');
		expect(r.account).toBe('rev');
	});

	it('splitPeople en gelijk verdelen', () => {
		expect(splitPeople({ splitCount: 3, splitWith: [] })).toBe(3);
		expect(splitPeople({ splitCount: null, splitWith: ['a', 'b'] })).toBe(3);
		expect(splitPeople({ splitCount: null, splitWith: [] })).toBe(1);
		expect(splitEqually(4500, 3)).toEqual({ mine: 1500, others: [1500, 1500] });
		expect(splitEqually(1000, 3)).toEqual({ mine: 333, others: [334, 333] });
		expect(splitEqually(1000, 1)).toEqual({ mine: 1000, others: [] });
	});

	it('voor 4 met sanne: het aantal gaat voor, de rest is nog onbekend', () => {
		const r = parse('40 pizza voor 4 met sanne');
		expect(r.splitCount).toBe(4);
		expect(r.splitWith).toEqual(['sanne']);
		expect(splitPeople(r)).toBe(4);
	});

	it('voor 2 met sanne en tim: de namen tellen als het aantal te laag is', () => {
		const r = parse('30 lunch voor 2 met sanne en tim');
		expect(splitPeople(r)).toBe(3);
	});
});

describe('personen', () => {
	const people = ['Sanne', 'Tim de Vries', 'Tim Jansen', 'Eva Bakker'];
	const withPeople = (input: string) => parseQuickEntry(input, TODAY, { ...opts, people });

	it('+15 tikkie sanne herkent Sanne', () => {
		const r = withPeople('+15 tikkie sanne');
		expect(r.person).toBe('Sanne');
		expect(r.text).toBe('tikkie');
		expect(r.direction).toBe('in');
		expect(r.spans.find((s) => s.kind === 'persoon')?.text).toBe('sanne');
	});

	it('een voornaam van één persoon, hoofdletters maken niet uit', () => {
		expect(withPeople('+20 EVA').person).toBe('Eva Bakker');
	});

	it('een voornaam van twee personen herkent hij niet', () => {
		const r = withPeople('+20 tikkie tim');
		expect(r.person).toBeNull();
		expect(r.text).toBe('tikkie tim');
	});

	it('zonder bekende personen blijft het tekst', () => {
		expect(parse('+15 tikkie sanne').person).toBeNull();
	});

	it('alleen de eerste persoon; met-namen zijn delen, geen persoon', () => {
		const r = withPeople('30 lunch met sanne');
		expect(r.splitWith).toEqual(['sanne']);
		expect(r.person).toBeNull();
		expect(withPeople('+30 sanne eva').person).toBe('Sanne');
	});

	it('__proto__ als naam levert niets op', () => {
		expect(withPeople('+5 __proto__ constructor').person).toBeNull();
	});
});

describe('gewone tekst maken', () => {
	it('een token met het kruisje weer tekst maken', () => {
		const r = parseQuickEntry('12,50 gisteren', TODAY, { plain: new Set([6]) });
		expect(r.dateExplicit).toBe(false);
		expect(r.text).toBe('gisteren');
		expect(r.amountCents).toBe(1250);
	});
});

describe('robuust', () => {
	it('kapt invoer af op 200 tekens', () => {
		const r = parse(`10 ${'a'.repeat(500)}`);
		expect(r.text.length).toBeLessThanOrEqual(MAX_INPUT);
	});

	it('spans liggen binnen de invoer en overlappen niet', () => {
		const input = '12,50 ah gisteren #boodschappen @rev met sanne en tom';
		const r = parse(input);
		let last = 0;
		for (const s of [...r.spans].sort((a, b) => a.start - b.start)) {
			expect(s.start).toBeGreaterThanOrEqual(last);
			expect(input.slice(s.start, s.end)).toBe(s.text);
			last = s.end;
		}
	});

	// Fuzz: nooit crashen en altijd binnen 5 ms (spec: Veilig parsen)
	it('crasht nooit en blijft onder 5 ms, ook bij vervelende invoer', () => {
		const tricky = fc.constantFrom(
			'voor',
			'met',
			'en',
			',',
			'#',
			'@',
			'$',
			'€',
			'+',
			'-',
			'/',
			'12',
			'12,50',
			'1.234,56',
			'gisteren',
			'vr',
			'31/2',
			'rev',
			'sns',
			'sanne',
			'Tim',
			'tikkie',
			' ',
			'\t',
			'\u200B',
			'é',
			'𝟙'
		);
		const input = fc.oneof(
			fc.string({ maxLength: 400 }),
			fc.array(tricky, { maxLength: 120 }).map((parts) => parts.join(' ')),
			fc.array(tricky, { maxLength: 200 }).map((parts) => parts.join(''))
		);
		const fuzzOpts = { ...opts, people: ['Sanne', 'Tim de Vries', 'Tim Jansen', '__proto__'] };
		fc.assert(
			fc.property(input, (s) => {
				// De parser is puur: echt trage invoer is elke keer traag. Een losse uitschieter door
				// een GC- of JIT-pauze van de testrunner wordt opnieuw gemeten, hooguit twee keer.
				const timed = () => {
					const start = performance.now();
					const r = parseQuickEntry(s, TODAY, fuzzOpts);
					return { r, ms: performance.now() - start };
				};
				let { r, ms } = timed();
				for (let retry = 0; retry < 2 && ms >= 5; retry++) ({ r, ms } = timed());
				expect(ms).toBeLessThan(5);
				expect(
					r.amountCents === null || (Number.isSafeInteger(r.amountCents) && r.amountCents > 0)
				).toBe(true);
				expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
				expect(r.person === null || typeof r.person === 'string').toBe(true);
				expect(splitPeople(r)).toBeGreaterThanOrEqual(1);
			}),
			{ numRuns: 2000 }
		);
	});
});
