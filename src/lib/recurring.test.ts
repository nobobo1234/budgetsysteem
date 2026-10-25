import { describe, expect, it } from 'vitest';
import { pace, suggestedLimit } from './budget.ts';
import {
	amountKind,
	dateInMonth,
	detectRecurring,
	median,
	nextOccurrence,
	occurrenceMonth,
	perMonthCents,
	perYearCents,
	reservationFor,
	settlementCents,
	signalFor,
	spreadMonthCents,
	type HistoryItem
} from './recurring.ts';

// Alleen test-IBANs (scripts/test-ibans.txt)
const IBAN_A = 'NL91ABNA0417164300';
const IBAN_B = 'NL20INGB0001234567';

function debit(
	date: string,
	cents: number,
	counterparty = 'Vattenfall',
	iban: string | null = IBAN_A
) {
	return { date, amountCents: -cents, counterparty, counterIban: iban } satisfies HistoryItem;
}

const months = (dates: string[], cents: number | number[], name?: string, iban?: string | null) =>
	dates.map((d, i) => debit(d, Array.isArray(cents) ? cents[i]! : cents, name, iban));

describe('herkennen: maandelijks', () => {
	const rent = months(
		[
			'2026-03-01',
			'2026-04-01',
			'2026-05-01',
			// Weekend: de huur van juni ging al op vrijdag 29 mei af
			'2026-05-29',
			'2026-07-01',
			'2026-08-03',
			'2026-09-01',
			'2026-10-01'
		],
		85000,
		'Woonstichting',
		IBAN_B
	);

	it('herkent huur op de 1e, ook als het weekend hem verschuift', () => {
		const [c] = detectRecurring(rent, '2026-10-24');
		expect(c).toMatchObject({
			interval: 'maand',
			expectedDay: 1,
			kind: 'vast',
			medianCents: 85000,
			minCents: 85000,
			maxCents: 85000,
			lastDate: '2026-10-01',
			nextDate: '2026-11-01'
		});
	});

	it('vraagt 3 keer in de laatste 6 maanden', () => {
		const two = months(['2026-08-05', '2026-09-05', '2026-10-05'], 1299).slice(1);
		expect(detectRecurring(two, '2026-10-24')).toEqual([]);
		const old = months(['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05'], 1299);
		expect(detectRecurring(old, '2026-10-24')).toEqual([]);
	});

	it('weigert een dag die meer dan 4 dagen van de mediaan afwijkt', () => {
		const loose = months(['2026-07-03', '2026-08-02', '2026-09-08', '2026-10-01'], 1299);
		expect(detectRecurring(loose, '2026-10-24')).toEqual([]);
		const ok = months(['2026-07-03', '2026-08-02', '2026-09-06', '2026-10-02'], 1299);
		expect(detectRecurring(ok, '2026-10-24')).toHaveLength(1);
	});

	it('wisselend als de spreiding boven 5% komt; bewaart mediaan, min en max', () => {
		const energy = months(
			['2026-06-12', '2026-07-12', '2026-08-12', '2026-09-12', '2026-10-12'],
			[9000, 11000, 10000, 12000, 9500]
		);
		const [c] = detectRecurring(energy, '2026-10-24');
		expect(c).toMatchObject({
			kind: 'wisselend',
			medianCents: 10000,
			minCents: 9000,
			maxCents: 12000,
			nextDate: '2026-11-12'
		});
	});

	it('vast binnen 5% spreiding', () => {
		expect(amountKind(1000, 1050, 1000)).toBe('vast');
		expect(amountKind(1000, 1051, 1000)).toBe('wisselend');
	});

	it('kijkt alleen naar uitgaande bedragen', () => {
		const incoming = months(['2026-08-25', '2026-09-25', '2026-10-23'], 250000).map((t) => ({
			...t,
			amountCents: -t.amountCents
		}));
		expect(detectRecurring(incoming, '2026-10-24')).toEqual([]);
	});

	it('slaat een losse extra betaling over', () => {
		const withExtra = [
			...months(['2026-07-20', '2026-08-20', '2026-09-20', '2026-10-20'], 1799, 'Ziggo'),
			debit('2026-09-02', 4500, 'Ziggo'),
			debit('2026-10-22', 2500, 'Ziggo')
		];
		const [c] = detectRecurring(withExtra, '2026-10-24');
		expect(c).toMatchObject({ interval: 'maand', expectedDay: 20, medianCents: 1799, count: 4 });
	});

	it('groepeert op tegenpartij en IBAN; eigen invoer zonder IBAN hoort bij de enige IBAN', () => {
		const history = [
			...months(['2026-08-10', '2026-09-10'], 3500, 'Sportschool', IBAN_A),
			debit('2026-10-10', 3500, 'SPORTSCHOOL', null),
			// Zelfde naam, andere IBAN, onregelmatig: geen vaste last en niet in dezelfde groep
			debit('2026-10-01', 2000, 'Kapper', IBAN_A),
			debit('2026-10-02', 2000, 'Kapper', IBAN_B)
		];
		const found = detectRecurring(history, '2026-10-24');
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({
			key: `sportschool|${IBAN_A}`,
			counterIban: IBAN_A,
			count: 3
		});
	});

	it('een historie die eerder stopt, schuift de volgende datum naar deze maand', () => {
		const old = months(['2026-05-14', '2026-06-14', '2026-07-14'], 999, 'Spotify');
		expect(detectRecurring(old, '2026-10-24')[0]?.nextDate).toBe('2026-10-14');
	});

	it('neemt de vaakst gebruikte categorie en rekening over', () => {
		const history = months(['2026-08-05', '2026-09-05', '2026-10-05'], 1299).map((t, i) => ({
			...t,
			categoryId: i === 0 ? 'oud' : 'abonnementen',
			accountId: 'sns'
		}));
		expect(detectRecurring(history, '2026-10-24')[0]).toMatchObject({
			categoryId: 'abonnementen',
			accountId: 'sns'
		});
	});
});

describe('herkennen: kwartaal, halfjaar en jaar', () => {
	it('kwartaal: 3 keer achter elkaar, de laatste recent', () => {
		const water = months(['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15'], 6400);
		expect(detectRecurring(water, '2026-10-24')[0]).toMatchObject({
			interval: 'kwartaal',
			nextDate: '2027-01-15',
			count: 4
		});
		// De laatste meer dan 4 maanden geleden: niet meer actief
		expect(detectRecurring(water.slice(0, 3), '2026-12-01')).toEqual([]);
	});

	it('halfjaarlijks met ongelijke semesters: de volgende in dezelfde maand als een jaar eerder', () => {
		const club = months(['2025-02-01', '2025-09-01', '2026-02-02'], 9000, 'Studievereniging');
		expect(detectRecurring(club, '2026-05-10')[0]).toMatchObject({
			interval: 'halfjaar',
			expectedDay: 1,
			nextDate: '2026-09-01'
		});
	});

	it('halfjaarlijks: de laatste hooguit 7 maanden geleden', () => {
		const club = months(['2025-09-01', '2026-02-01'], 9000, 'Studievereniging');
		expect(detectRecurring(club, '2026-08-31')).toHaveLength(1);
		expect(detectRecurring(club, '2026-09-02')).toEqual([]);
	});

	it('halfjaarlijks: bij drie keer liggen de eerste en de derde een jaar uit elkaar', () => {
		const odd = months(['2025-01-10', '2025-06-10', '2025-11-10'], 4000, 'Opleiding');
		// 304 dagen: alleen de laatste twee tellen
		expect(detectRecurring(odd, '2026-01-05')[0]).toMatchObject({ interval: 'halfjaar', count: 2 });
	});

	it('jaarlijks: 2 keer, 350 tot 380 dagen uit elkaar', () => {
		const insurance = months(['2024-11-20', '2025-11-18'], 14500, 'Reisverzekering');
		expect(detectRecurring(insurance, '2026-10-24')[0]).toMatchObject({
			interval: 'jaar',
			expectedDay: 19,
			nextDate: '2026-11-19'
		});
		expect(detectRecurring(insurance.slice(1), '2026-10-24')).toEqual([]);
	});
});

describe('ritme', () => {
	it('afschrijving rond de maandwisseling hoort bij de juiste maand', () => {
		expect(occurrenceMonth('2026-05-29', 1)).toBe('2026-06');
		expect(occurrenceMonth('2026-07-02', 30)).toBe('2026-06');
		expect(occurrenceMonth('2026-07-03', 1)).toBe('2026-07');
	});

	it('de volgende datum volgt het ritme en de dag, ook in korte maanden', () => {
		expect(nextOccurrence({ interval: 'maand', expectedDay: 31, current: '2026-01-31' })).toBe(
			'2026-02-28'
		);
		expect(nextOccurrence({ interval: 'kwartaal', expectedDay: 15, current: '2026-11-15' })).toBe(
			'2027-02-15'
		);
		expect(
			nextOccurrence({
				interval: 'halfjaar',
				expectedDay: 1,
				current: '2026-02-01',
				previous: '2025-09-01'
			})
		).toBe('2026-09-01');
		expect(nextOccurrence({ interval: 'halfjaar', expectedDay: 1, current: '2026-02-01' })).toBe(
			'2026-08-01'
		);
		expect(dateInMonth('2028-02', 30)).toBe('2028-02-29');
	});

	it('mediaan van een even aantal rondt naar beneden af', () => {
		expect(median([1, 2])).toBe(1);
		expect(median([3, 1, 2])).toBe(2);
	});
});

describe('reserveren (spec: Hoe de reservering werkt)', () => {
	/** Reserveert elke maand vanaf `from` tot en met de afschrijfmaand. */
	function plan(expectedCents: number, from: string, debitMonth: string, start = 0): number[] {
		const out: number[] = [];
		let reserved = start;
		for (let m = from; m <= debitMonth;) {
			const r = reservationFor({ expectedCents, reservedCents: reserved, month: m, debitMonth });
			out.push(r);
			reserved += r;
			const [y, mm] = m.split('-').map(Number);
			m = mm === 12 ? `${y! + 1}-01` : `${y}-${String(mm! + 1).padStart(2, '0')}`;
		}
		return out;
	}

	it('€90 halfjaarlijks met gelijke helften is €15 per maand', () => {
		expect(plan(9000, '2026-02', '2026-07')).toEqual([1500, 1500, 1500, 1500, 1500, 1500]);
	});

	it('rondt naar beneden af; de laatste maand neemt de rest', () => {
		const r = plan(10000, '2026-01', '2026-03');
		expect(r).toEqual([3333, 3333, 3334]);
		expect(r.reduce((a, b) => a + b)).toBe(10000);
	});

	it('instappen halverwege: twee maanden voor de afschrijving elk de helft', () => {
		expect(plan(9000, '2026-05', '2026-06')).toEqual([4500, 4500]);
	});

	it('ongelijke semesters (vijf en zeven maanden) lossen zich met dezelfde formule op', () => {
		const first = plan(9000, '2025-10', '2026-02');
		expect(first).toEqual([1800, 1800, 1800, 1800, 1800]);
		const second = plan(9000, '2026-03', '2026-09');
		// Elke maand opnieuw: (€90 − al opzij) gedeeld door de maanden die nog over zijn
		expect(second).toEqual([1285, 1285, 1286, 1286, 1286, 1286, 1286]);
		expect(second.reduce((a, b) => a + b)).toBe(9000);
	});

	it('een duurdere afschrijving is een extra uitgave, een goedkopere geeft de rest terug', () => {
		expect(settlementCents(9500, 9000)).toBe(500);
		expect(settlementCents(8500, 9000)).toBe(-500);
		// In de afschrijfmaand: €15 opzij, €90 uit de reservering, €95 afgeschreven
		expect(spreadMonthCents({ reservedCents: 1500, drawnCents: 9000, debitCents: 9500 })).toBe(
			2000
		);
		expect(spreadMonthCents({ reservedCents: 1500, drawnCents: 9000, debitCents: 8500 })).toBe(
			1000
		);
		// Precies het verwachte bedrag: de balk ziet er uit als elke andere maand
		expect(spreadMonthCents({ reservedCents: 1500, drawnCents: 9000, debitCents: 9000 })).toBe(
			1500
		);
	});

	it('stoppen: wat al gereserveerd is valt vrij in die maand', () => {
		// Drie maanden €15 opzij, in de vierde (€15 al opzij) gestopt: €60 uit de reservering
		expect(spreadMonthCents({ reservedCents: 1500, drawnCents: 6000, debitCents: 0 })).toBe(-4500);
	});

	it('een prijsverhoging schuift de volgende reserveringen mee; eerdere maanden blijven', () => {
		const debitMonth = '2026-07';
		let reserved = 0;
		const done: number[] = [];
		for (const month of ['2026-02', '2026-03', '2026-04']) {
			const r = reservationFor({ expectedCents: 9000, reservedCents: reserved, month, debitMonth });
			done.push(r);
			reserved += r;
		}
		expect(done).toEqual([1500, 1500, 1500]);
		// Na drie maanden €45 opzij wordt de last €96: de laatste drie maanden €17
		expect(plan(9600, '2026-05', debitMonth, reserved)).toEqual([1700, 1700, 1700]);
		expect(done).toEqual([1500, 1500, 1500]);
	});

	it('na de afschrijfmaand of met genoeg opzij: niets', () => {
		expect(
			reservationFor({
				expectedCents: 9000,
				reservedCents: 0,
				month: '2026-08',
				debitMonth: '2026-07'
			})
		).toBe(0);
		expect(
			reservationFor({
				expectedCents: 9000,
				reservedCents: 9500,
				month: '2026-07',
				debitMonth: '2026-07'
			})
		).toBe(0);
	});
});

describe('overzicht en signalen', () => {
	it('een halfjaarlijkse last telt voor een zesde per maand', () => {
		expect(perMonthCents(9000, 'halfjaar')).toBe(1500);
		expect(perMonthCents(10000, 'kwartaal')).toBe(3333);
		expect(perYearCents(9000, 'halfjaar')).toBe(18000);
		expect(perYearCents(1299, 'maand')).toBe(15588);
	});

	it('prijsverhoging bij een vaste last vanaf 2% duurder dan vorige keer', () => {
		const vast = { kind: 'vast' as const, maxCents: 1000 };
		expect(signalFor({ ...vast, amountCents: 1020, previousCents: 1000 })).toBe('prijsverhoging');
		expect(signalFor({ ...vast, amountCents: 1019, previousCents: 1000 })).toBeNull();
		expect(signalFor({ ...vast, amountCents: 1500, previousCents: null })).toBeNull();
	});

	it('uitschieter bij een wisselende last boven 120% van het hoogste bedrag', () => {
		const w = { kind: 'wisselend' as const, previousCents: 9000, maxCents: 10000 };
		expect(signalFor({ ...w, amountCents: 12001 })).toBe('uitschieter');
		expect(signalFor({ ...w, amountCents: 12000 })).toBeNull();
	});
});

describe('tempo met vaste lasten (spec: Tempo met vaste lasten)', () => {
	const day = { day: 2, daysInMonth: 31 };

	it('huur op de eerste van de maand kleurt de balk niet oranje', () => {
		const r = pace({
			limitCents: 100000,
			spentCents: 85000,
			plannedCents: 85000,
			plannedSpentCents: 85000,
			...day
		});
		expect(r.pace).toBe('rustig');
		expect(r.freeLimitCents).toBe(15000);
		expect(r.otherCents).toBe(0);
		// Zonder planning zou dezelfde maand over de streep gaan
		expect(pace({ limitCents: 100000, spentCents: 85000, ...day }).pace).toBe('snel');
	});

	it('tempo meet de overige uitgaven tegenover limiet min gepland', () => {
		const r = pace({
			limitCents: 50000,
			spentCents: 44000,
			plannedCents: 30000,
			plannedSpentCents: 30000,
			day: 15,
			daysInMonth: 30
		});
		// 14000 van 20000 vrij (70%) bij de helft van de maand
		expect(r.otherCents).toBe(14000);
		expect(r.pace).toBe('snel');
	});

	it('met alleen geplande posten geen tempo, tot de categorie over de limiet gaat', () => {
		// Vereniging: €15 reservering opzij, €8 dispuut nog verwacht, limiet €23
		const base = { limitCents: 2300, plannedCents: 2300, plannedSpentCents: 1500, ...day };
		expect(pace({ ...base, spentCents: 1500 }).pace).toBe('gepland');
		// Een borrel van €5 erbij: met het verwachte dispuut komt de maand op €28
		expect(pace({ ...base, spentCents: 2000 }).pace).toBe('over');
	});

	it('stelt een limiet voor als die lager is dan gepland', () => {
		const r = pace({
			limitCents: 2000,
			spentCents: 1500,
			plannedCents: 2301,
			plannedSpentCents: 1500,
			...day
		});
		expect(r.freeLimitCents).toBe(-301);
		expect(suggestedLimit(2301)).toBe(2400);
		expect(suggestedLimit(2300)).toBe(2300);
	});
});
