import { describe, expect, it } from 'vitest';
import { allocatePayment } from './owed.ts';
import type { HistoryItem } from './recurring.ts';
import {
	checkShares,
	detectShareProposals,
	ibanLinkText,
	isActive,
	lastMonths,
	monthState,
	monthsFrom,
	proposedShareCents,
	shareCents,
	splitShared,
	type ShareTerms
} from './shares.ts';

// Alleen test-IBANs (zie scripts/test-ibans.txt)
const IBAN_SANNE = 'NL91ABNA0417164300';
const IBAN_TIM = 'NL02ABNA0123456789';

const vast = (amountCents: number, startMonth = '2026-01', endMonth: string | null = null) =>
	({ kind: 'vast', amountCents, basisPoints: null, startMonth, endMonth }) satisfies ShareTerms;
const pct = (basisPoints: number, startMonth = '2026-01', endMonth: string | null = null) =>
	({
		kind: 'percentage',
		amountCents: null,
		basisPoints,
		startMonth,
		endMonth
	}) satisfies ShareTerms;

describe('verdeling in centen', () => {
	it('vast: jouw deel is wat overblijft', () => {
		expect(splitShared(6000, [vast(2000), vast(2000)])).toEqual({
			mine: 2000,
			others: [2000, 2000]
		});
	});

	it('percentage: naar beneden afgerond, de restcent is van jou', () => {
		// 25% van €60,01 is €15,0025: elk aandeel €15,00, jij €30,01
		expect(splitShared(6001, [pct(2500), pct(2500)])).toEqual({ mine: 3001, others: [1500, 1500] });
		// Een derde van €10: 3333 basispunten
		expect(splitShared(1000, [pct(3333), pct(3333)])).toEqual({ mine: 334, others: [333, 333] });
	});

	it('samen altijd precies het totaal', () => {
		for (const total of [0, 1, 99, 6001, 12345, 99999]) {
			const { mine, others } = splitShared(total, [pct(3333), vast(500), pct(1)]);
			expect(mine + others.reduce((s, n) => s + n, 0)).toBe(total);
		}
	});

	it('een vast aandeel volgt het bedrag niet, een percentage wel', () => {
		expect(shareCents(vast(2000), 9000)).toBe(2000);
		expect(shareCents(pct(2500), 9000)).toBe(2250);
	});

	it('weigert een ongeldig totaal', () => {
		expect(() => splitShared(-1, [])).toThrow(RangeError);
		expect(() => splitShared(1.5, [])).toThrow(RangeError);
	});
});

describe('aandelen samen', () => {
	it('niet meer dan het bedrag van de last', () => {
		expect(checkShares(6000, [vast(2000), vast(2000)])).toBeNull();
		expect(checkShares(6000, [vast(2000), vast(4000)])).toBeNull();
		expect(checkShares(6000, [vast(2000), vast(4001)])).toMatch(/meer dan het bedrag/);
		expect(checkShares(6000, [vast(3000), pct(5000)])).toBeNull();
		expect(checkShares(6000, [pct(6000), pct(5000)])).toMatch(/100%/);
		expect(checkShares(6000, [vast(3000), pct(5017)])).toMatch(/meer dan het bedrag/);
	});

	it('telt per maand: wie vertrekt maakt plaats voor wie erbij komt', () => {
		const sanne = vast(4000, '2026-01', '2026-05');
		const tim = vast(4000, '2026-06');
		expect(checkShares(6000, [sanne, tim])).toBeNull();
		expect(checkShares(6000, [sanne, vast(4000, '2026-05')])).toMatch(/meer dan het bedrag/);
	});

	it('eindmaand niet voor de startmaand', () => {
		expect(checkShares(6000, [vast(1000, '2026-05', '2026-04')])).toMatch(/eindmaand/);
	});

	it('actief van startmaand tot en met eindmaand', () => {
		const s = vast(1000, '2026-03', '2026-05');
		expect(['2026-02', '2026-03', '2026-05', '2026-06'].map((m) => isActive(s, m))).toEqual([
			false,
			true,
			true,
			false
		]);
		expect(isActive(vast(1000, '2026-03'), '2030-01')).toBe(true);
	});
});

describe('toewijzing oudste eerst', () => {
	const posts = [
		{ id: 'sep', outstandingCents: 2000 },
		{ id: 'okt', outstandingCents: 2000 },
		{ id: 'nov', outstandingCents: 2000 }
	];

	it('een betaling gaat naar de oudste open post', () => {
		expect(allocatePayment(2000, posts)).toEqual({
			allocations: [{ id: 'sep', cents: 2000 }],
			creditCents: 0
		});
	});

	it('meer dan open staat: de rest is tegoed', () => {
		expect(allocatePayment(7000, posts)).toEqual({
			allocations: [
				{ id: 'sep', cents: 2000 },
				{ id: 'okt', cents: 2000 },
				{ id: 'nov', cents: 2000 }
			],
			creditCents: 1000
		});
	});

	it('minder: de post wordt deels betaald', () => {
		expect(allocatePayment(1500, posts)).toEqual({
			allocations: [{ id: 'sep', cents: 1500 }],
			creditCents: 0
		});
	});

	it('niets open (overboeking voor de post er is): alles tegoed', () => {
		expect(allocatePayment(2000, [])).toEqual({ allocations: [], creditCents: 2000 });
	});
});

describe('status per maand', () => {
	const base = { amountCents: 2000, paidCents: 0, forgiven: false, dueDate: '2026-10-01' };

	it('binnen, deels en open', () => {
		expect(monthState({ ...base, paidCents: 2000, today: '2026-10-20' })).toBe('binnen');
		expect(monthState({ ...base, paidCents: 2500, today: '2026-10-20' })).toBe('binnen');
		expect(monthState({ ...base, paidCents: 500, today: '2026-10-03' })).toBe('deels');
		expect(monthState({ ...base, today: '2026-10-03' })).toBe('open');
		// Voor de ontvangstdag staat hij gewoon open
		expect(monthState({ ...base, today: '2026-09-25' })).toBe('open');
	});

	it('te laat: niet volledig binnen 7 dagen na de ontvangstdag', () => {
		expect(monthState({ ...base, today: '2026-10-08' })).toBe('open');
		expect(monthState({ ...base, today: '2026-10-09' })).toBe('te_laat');
		expect(monthState({ ...base, paidCents: 1999, today: '2026-10-09' })).toBe('te_laat');
	});

	it('kwijtgescholden blijft kwijtgescholden', () => {
		expect(monthState({ ...base, forgiven: true, today: '2026-12-01' })).toBe('kwijtgescholden');
	});

	it('maanden voor de vakjes', () => {
		expect(lastMonths('2026-02', 6)).toEqual([
			'2025-09',
			'2025-10',
			'2025-11',
			'2025-12',
			'2026-01',
			'2026-02'
		]);
		expect(monthsFrom('2025-11', '2026-01')).toEqual(['2025-11', '2025-12', '2026-01']);
		expect(monthsFrom('2026-02', '2026-01')).toEqual([]);
	});
});

describe('voorstellen uit de historie', () => {
	const ziggo = { id: 'ziggo', counterparty: 'Ziggo', medianCents: 6000, expectedDay: 1 };
	const vattenfall = {
		id: 'vattenfall',
		counterparty: 'Vattenfall',
		medianCents: 12000,
		expectedDay: 20
	};

	function transfers(iban: string, cents: number, dates: string[], name = 'S. de Vries') {
		return dates.map((date): HistoryItem => ({
			date,
			amountCents: cents,
			counterparty: name,
			counterIban: iban
		}));
	}

	const monthly = ['2026-06-28', '2026-07-28', '2026-08-28', '2026-09-28'];

	it('maandelijkse overboeking tussen 10% en 90% van een vaste last', () => {
		expect(
			detectShareProposals(transfers(IBAN_SANNE, 2000, monthly), [ziggo], '2026-10-05')
		).toEqual([
			{
				counterIban: IBAN_SANNE,
				counterparty: 'S. de Vries',
				recurringId: 'ziggo',
				amountCents: 2000,
				receiveDay: 28,
				startMonth: '2026-06'
			}
		]);
	});

	it('buiten 10% tot 90% geen voorstel', () => {
		expect(
			detectShareProposals(transfers(IBAN_SANNE, 599, monthly), [ziggo], '2026-10-05')
		).toEqual([]);
		expect(
			detectShareProposals(transfers(IBAN_SANNE, 600, monthly), [ziggo], '2026-10-05')
		).toHaveLength(1);
		expect(
			detectShareProposals(transfers(IBAN_SANNE, 5400, monthly), [ziggo], '2026-10-05')
		).toHaveLength(1);
		expect(
			detectShareProposals(transfers(IBAN_SANNE, 5401, monthly), [ziggo], '2026-10-05')
		).toEqual([]);
	});

	it('geen ritme, geen voorstel; uitgaande bedragen tellen niet', () => {
		const irregular = ['2026-06-02', '2026-06-20', '2026-09-28'];
		expect(
			detectShareProposals(transfers(IBAN_SANNE, 2000, irregular), [ziggo], '2026-10-05')
		).toEqual([]);
		expect(
			detectShareProposals(transfers(IBAN_SANNE, -2000, monthly), [ziggo], '2026-10-05')
		).toEqual([]);
	});

	it('zonder IBAN geen voorstel', () => {
		const items = monthly.map((date) => ({
			date,
			amountCents: 2000,
			counterparty: 'Sanne',
			counterIban: null
		}));
		expect(detectShareProposals(items, [ziggo], '2026-10-05')).toEqual([]);
	});

	it('past hij bij meer lasten, dan de last rond dezelfde dag', () => {
		const tim = transfers(
			IBAN_TIM,
			3000,
			['2026-06-19', '2026-07-21', '2026-08-20', '2026-09-19'],
			'T. Bakker'
		);
		const [p] = detectShareProposals(tim, [ziggo, vattenfall], '2026-10-05');
		expect(p?.recurringId).toBe('vattenfall');
		const [q] = detectShareProposals(
			transfers(IBAN_SANNE, 2000, monthly),
			[vattenfall, ziggo],
			'2026-10-05'
		);
		expect(q?.recurringId).toBe('ziggo');
	});

	it('voorstel bij een duurdere last: naar verhouding, naar beneden afgerond', () => {
		expect(proposedShareCents(2000, 6000, 6500)).toBe(2166);
		expect(proposedShareCents(2000, 6000, 6000)).toBe(2000);
		expect(proposedShareCents(2000, 0, 6000)).toBe(2000);
	});
});

describe('melding na een nieuw IBAN', () => {
	it('telt gekoppeld en niet gepast, met enkelvoud en meervoud', () => {
		expect(ibanLinkText('Sanne', 3, 1)).toBe(
			'3 betalingen van Sanne gekoppeld · 1 paste niet, koppel die zelf'
		);
		expect(ibanLinkText('Sanne', 1, 2)).toBe(
			'1 betaling van Sanne gekoppeld · 2 pasten niet, koppel ze zelf'
		);
		expect(ibanLinkText('Sanne', 2, 0)).toBe('2 betalingen van Sanne gekoppeld');
		expect(ibanLinkText('Sanne', 0, 1)).toBe('1 betaling van Sanne paste niet, koppel die zelf');
		expect(ibanLinkText('Sanne', 0, 0)).toBeNull();
	});
});
