import { describe, expect, it } from 'vitest';
import {
	checkedInMonth,
	checkResults,
	differencePeriod,
	expectedBalance,
	type BalanceAnchor,
	type BalanceEntry
} from './balance.ts';

const SNS = 'sns';
const REV = 'rev';

const anchor: BalanceAnchor = { accountId: SNS, date: '2026-09-30', amountCents: 100_000 };

function entry(over: Partial<BalanceEntry> = {}): BalanceEntry {
	return { accountId: SNS, date: '2026-10-05', amountCents: -1_250, status: 'bevestigd', ...over };
}

describe('expectedBalance', () => {
	it('is het anker zonder boekingen', () => {
		expect(expectedBalance(anchor, [], '2026-10-24')).toBe(100_000);
	});

	it('telt uitgaand en inkomend na het anker op', () => {
		const entries = [
			entry({ amountCents: -1_250 }),
			entry({ date: '2026-10-25', amountCents: 250_000 }),
			entry({ date: '2026-10-26', amountCents: -99 })
		];
		expect(expectedBalance(anchor, entries, '2026-10-26')).toBe(100_000 - 1_250 + 250_000 - 99);
	});

	it('telt boekingen op of vóór de ankerdatum niet: die zitten al in het anker', () => {
		const entries = [entry({ date: '2026-09-30' }), entry({ date: '2026-09-01' })];
		expect(expectedBalance(anchor, entries, '2026-10-24')).toBe(100_000);
	});

	it('telt tot en met de gevraagde datum, niet later', () => {
		const entries = [entry({ date: '2026-10-24' }), entry({ date: '2026-10-25' })];
		expect(expectedBalance(anchor, entries, '2026-10-24')).toBe(100_000 - 1_250);
	});

	it('rekent terug voor een datum vóór het anker', () => {
		const entries = [
			entry({ date: '2026-09-20', amountCents: -2_000 }),
			entry({ date: '2026-09-30', amountCents: 5_000 }),
			entry({ date: '2026-09-10', amountCents: -700 })
		];
		// Saldo eind 15 september: het anker zonder wat er daarna nog gebeurde
		expect(expectedBalance(anchor, entries, '2026-09-15')).toBe(100_000 + 2_000 - 5_000);
	});

	it('houdt rekeningen gescheiden', () => {
		const entries = [entry({ accountId: REV, amountCents: -50_000 }), entry()];
		expect(expectedBalance(anchor, entries, '2026-10-24')).toBe(100_000 - 1_250);
		const rev = { accountId: REV, date: '2026-09-30', amountCents: 0 };
		expect(expectedBalance(rev, entries, '2026-10-24')).toBe(-50_000);
	});

	it('telt verwachte posten niet mee, te controleren wel', () => {
		const entries = [
			entry({ status: 'verwacht', amountCents: -95_000 }),
			entry({ status: 'te_controleren', amountCents: -1_800 })
		];
		expect(expectedBalance(anchor, entries, '2026-10-24')).toBe(100_000 - 1_800);
	});

	it('telt vreemde valuta via het eurobedrag', () => {
		// Een betaling van 460 kronen die 40,12 euro kostte: alleen het eurobedrag telt
		const sek = {
			...entry({ amountCents: -4_012 }),
			origAmountCents: -46_000,
			origCurrency: 'SEK'
		};
		expect(expectedBalance(anchor, [sek], '2026-10-24')).toBe(100_000 - 4_012);
	});

	it('telt een terugboeking op de dag dat het geld binnenkwam', () => {
		// Jas in september gekocht (vóór het anker), retour in oktober
		const entries = [
			entry({ date: '2026-09-20', amountCents: -8_000 }),
			entry({ date: '2026-10-10', amountCents: 8_000 })
		];
		expect(expectedBalance(anchor, entries, '2026-10-09')).toBe(100_000);
		expect(expectedBalance(anchor, entries, '2026-10-10')).toBe(108_000);
	});
});

describe('differencePeriod', () => {
	it('loopt van de dag na de vorige check tot de check', () => {
		expect(differencePeriod('2026-09-30', '2026-10-24')).toEqual({
			from: '2026-10-01',
			to: '2026-10-24'
		});
	});

	it('werkt ook voor een check vóór het anker', () => {
		expect(differencePeriod('2026-09-30', '2026-09-15')).toEqual({
			from: '2026-09-16',
			to: '2026-09-30'
		});
	});

	it('is één dag als de check op de ankerdatum valt', () => {
		expect(differencePeriod('2026-09-30', '2026-09-30')).toEqual({
			from: '2026-09-30',
			to: '2026-09-30'
		});
	});
});

describe('checkResults', () => {
	const entries = [entry({ date: '2026-10-05', amountCents: -1_250 })];

	it('geeft per check het verschil, de nieuwste eerst', () => {
		const results = checkResults(anchor, entries, [
			{ date: '2026-10-31', amountCents: 97_500 },
			{ date: '2026-10-01', amountCents: 100_000 }
		]);
		expect(results.map((r) => [r.date, r.expectedCents, r.differenceCents])).toEqual([
			['2026-10-31', 98_750, -1_250],
			['2026-10-01', 100_000, 0]
		]);
	});

	it('zoekt een verschil vanaf de laatste check die klopte', () => {
		const [latest, middle] = checkResults(anchor, entries, [
			{ date: '2026-10-01', amountCents: 100_000 },
			{ date: '2026-10-15', amountCents: 90_000 },
			{ date: '2026-10-31', amountCents: 90_000 }
		]);
		// De check van 15 oktober klopte niet, dus het verschil kan sinds 1 oktober zijn ontstaan
		expect(middle!.period).toEqual({ from: '2026-10-02', to: '2026-10-15' });
		expect(latest!.period).toEqual({ from: '2026-10-02', to: '2026-10-31' });
	});

	it('rekent het verschil opnieuw als je de vergeten uitgave toevoegt', () => {
		const checks = [{ date: '2026-10-31', amountCents: 95_000 }];
		expect(checkResults(anchor, entries, checks)[0]!.differenceCents).toBe(-3_750);
		const fixed = [...entries, entry({ date: '2026-10-20', amountCents: -3_750 })];
		expect(checkResults(anchor, fixed, checks)[0]!.differenceCents).toBe(0);
	});
});

describe('checkedInMonth', () => {
	it('kijkt alleen naar de gevraagde maand', () => {
		const checks = [{ date: '2026-09-30' }, { date: '2026-11-01' }];
		expect(checkedInMonth(checks, '2026-10')).toBe(false);
		expect(checkedInMonth([...checks, { date: '2026-10-01' }], '2026-10')).toBe(true);
	});
});
