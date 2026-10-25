import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	decideMatch,
	differenceCents,
	inWindow,
	type BankEntry,
	type OwnEntry
} from './koppellijst.ts';

const bank = (over: Partial<BankEntry> = {}): BankEntry => ({
	amountCents: -2000,
	date: '2026-10-12',
	name: 'ALBERT HEIJN 1403 UTRECHT',
	...over
});

let n = 0;
const own = (over: Partial<OwnEntry> = {}): OwnEntry => ({
	id: `eigen-${++n}`,
	amountCents: -2000,
	date: '2026-10-12',
	name: 'Albert Heijn',
	...over
});

describe('welke invoer kan bij een bankboeking horen', () => {
	it('hetzelfde teken, binnen de fooimarge en binnen vijf dagen', () => {
		expect(inWindow(bank(), own())).toBe(true);
		expect(inWindow(bank(), own({ amountCents: 2000 }))).toBe(false);
		expect(inWindow(bank(), own({ amountCents: -2101 }))).toBe(false);
		expect(inWindow(bank(), own({ date: '2026-10-07' }))).toBe(true);
		expect(inWindow(bank(), own({ date: '2026-10-06' }))).toBe(false);
		expect(inWindow(bank(), own({ date: '2026-10-17' }))).toBe(true);
	});

	it('een post zonder eurobedrag past nergens bij', () => {
		expect(inWindow(bank(), own({ amountCents: 0 }))).toBe(false);
		expect(inWindow(bank({ amountCents: 0 }), own({ amountCents: 0 }))).toBe(false);
	});
});

describe('voorselectie', () => {
	it('één duidelijke kandidaat wordt samengevoegd', () => {
		const target = own();
		const d = decideMatch(bank(), [target, own({ amountCents: -1500, name: 'Jumbo' })]);
		expect(d.kind).toBe('samenvoegen');
		if (d.kind === 'samenvoegen') expect(d.target.id).toBe(target.id);
		// Het tweede bedrag valt buiten de marge en staat niet in de lijst
		expect(d.candidates).toHaveLength(1);
	});

	it('zonder automatisch samenvoegen blijft het een voorstel', () => {
		expect(decideMatch(bank(), [own()], { auto: false }).kind).toBe('controleren');
	});

	it('niets in de buurt: een nieuwe transactie', () => {
		const d = decideMatch(bank(), [own({ date: '2026-09-01' }), own({ amountCents: -5000 })]);
		expect(d).toEqual({ kind: 'nieuw', candidates: [] });
	});

	it('alleen onwaarschijnlijke kandidaten houden een vergeten uitgave niet tegen', () => {
		// Bedrag aan de rand van de marge, vier dagen ernaast, een andere naam
		const d = decideMatch(bank(), [own({ amountCents: -1900, date: '2026-10-16', name: 'Bol' })]);
		expect(d.kind).toBe('nieuw');
		expect(d.candidates[0]?.label).toBe('onwaarschijnlijk');
	});

	it('een andere naam op dezelfde dag met hetzelfde bedrag is mogelijk, niet zeker', () => {
		const d = decideMatch(bank(), [own({ name: 'Kapper' })]);
		expect(d.kind).toBe('controleren');
		expect(d.candidates[0]?.label).toBe('waarschijnlijk');
	});
});

describe('fooi', () => {
	it('een paar cent verschil met dezelfde naam en datum mag nog samenvoegen', () => {
		const d = decideMatch(bank({ amountCents: -2010, name: 'Albert Heijn' }), [own()]);
		expect(d.kind).toBe('samenvoegen');
	});

	it('een fooi binnen de marge komt in de koppellijst', () => {
		// €45 ingevoerd, €46 afgeschreven: binnen €1, maar niet duidelijk genoeg
		const d = decideMatch(bank({ amountCents: -4600, name: 'Café de Zaak' }), [
			own({ amountCents: -4500, name: 'cafe de zaak' })
		]);
		expect(d.kind).toBe('controleren');
		expect(d.candidates).toHaveLength(1);
		expect(d.candidates[0]?.label).toBe('waarschijnlijk');
	});

	it('bij grote bedragen telt 2% als marge', () => {
		const target = own({ amountCents: -20000, name: 'Restaurant' });
		expect(inWindow(bank({ amountCents: -20400 }), target)).toBe(true);
		expect(inWindow(bank({ amountCents: -20401 }), target)).toBe(false);
	});

	it('het verschil is positief als de bank meer boekte', () => {
		expect(differenceCents(-4600, -4500)).toBe(100);
		expect(differenceCents(-4400, -4500)).toBe(-100);
		expect(differenceCents(1500, 1500)).toBe(0);
	});
});

describe('meerdere kandidaten', () => {
	it('twee gelijke invoeren: niet raden, maar de koppellijst', () => {
		const d = decideMatch(bank(), [own(), own({ date: '2026-10-13' })]);
		expect(d.kind).toBe('controleren');
		expect(d.candidates).toHaveLength(2);
		// De dichtstbijzijnde datum bovenaan
		expect(d.candidates[0]!.score).toBeGreaterThan(d.candidates[1]!.score);
	});

	it('met ruime voorsprong toch samenvoegen', () => {
		const target = own();
		const d = decideMatch(bank(), [
			own({ amountCents: -1950, date: '2026-10-16', name: 'Bol' }),
			target
		]);
		expect(d.kind).toBe('samenvoegen');
		if (d.kind === 'samenvoegen') expect(d.target.id).toBe(target.id);
	});

	it('hoogstens vijf kandidaten', () => {
		const many = Array.from({ length: 8 }, (_, i) => own({ date: `2026-10-1${i}` }));
		const d = decideMatch(bank(), many);
		expect(d.candidates).toHaveLength(5);
	});

	it('kiest nooit iets buiten het venster, en samenvoegen alleen met voorsprong', () => {
		const entry = fc.record({
			amountCents: fc.integer({ min: -50_000, max: 50_000 }),
			day: fc.integer({ min: 1, max: 28 }),
			name: fc.constantFrom('Albert Heijn', 'Jumbo', 'ah', 'Kapper', '')
		});
		fc.assert(
			fc.property(entry, fc.array(entry, { maxLength: 8 }), (b, list) => {
				const date = (d: number) => `2026-10-${String(d).padStart(2, '0')}`;
				const query = { amountCents: b.amountCents, date: date(b.day), name: b.name };
				const targets = list.map((e, i) => ({
					id: `t${i}`,
					amountCents: e.amountCents,
					date: date(e.day),
					name: e.name
				}));
				const d = decideMatch(query, targets);
				expect(d.candidates.length).toBeLessThanOrEqual(5);
				for (const c of d.candidates) {
					expect(inWindow(query, c.target)).toBe(true);
				}
				if (d.kind === 'samenvoegen') {
					const [first, second] = d.candidates;
					expect(first!.target.id).toBe(d.target.id);
					expect(first!.score).toBeGreaterThan(0.9);
					if (second) expect(first!.score - second.score).toBeGreaterThanOrEqual(0.3);
				}
			})
		);
	});
});
