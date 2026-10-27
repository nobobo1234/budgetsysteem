import { describe, expect, it } from 'vitest';
import {
	byRoom,
	historyMonths,
	median,
	periodSentence,
	plan,
	proposeLimit,
	roundEuro
} from './startLimits.ts';

describe('maanden met historie', () => {
	it('neemt de laatste zes volle maanden, zonder de lopende maand', () => {
		expect(historyMonths('2026-10', '2025-01-01')).toEqual([
			'2026-04',
			'2026-05',
			'2026-06',
			'2026-07',
			'2026-08',
			'2026-09'
		]);
	});

	it('telt een maand waarin de historie halverwege begint niet mee', () => {
		expect(historyMonths('2026-10', '2026-06-14')).toEqual(['2026-07', '2026-08', '2026-09']);
	});

	it('telt een maand mee als de historie op de eerste begint', () => {
		expect(historyMonths('2026-10', '2026-06-01')).toEqual([
			'2026-06',
			'2026-07',
			'2026-08',
			'2026-09'
		]);
	});

	it('loopt over de jaarwisseling', () => {
		expect(historyMonths('2027-02', '2026-01-01')).toEqual([
			'2026-08',
			'2026-09',
			'2026-10',
			'2026-11',
			'2026-12',
			'2027-01'
		]);
	});

	it('zonder historie: geen maanden', () => {
		expect(historyMonths('2026-10', null)).toEqual([]);
		expect(historyMonths('2026-10', '2026-10-01')).toEqual([]);
	});
});

describe('mediaan', () => {
	it('oneven aantal: de middelste', () => {
		expect(median([300, 100, 200])).toBe(200);
	});

	it('even aantal: het gemiddelde van de middelste twee', () => {
		expect(median([100, 400, 200, 300])).toBe(250);
		expect(median([100, 200])).toBe(150);
	});

	it('even aantal kan op een halve cent uitkomen', () => {
		expect(median([100, 101])).toBe(100.5);
	});

	it('maanden met € 0 tellen mee', () => {
		expect(median([0, 0, 0, 5000, 9000, 12000])).toBe(2500);
		expect(median([0, 0, 4000])).toBe(0);
	});

	it('één uitschieter trekt de mediaan niet op', () => {
		expect(median([20000, 22000, 21000, 150000, 19000])).toBe(21000);
	});
});

describe('afronden', () => {
	it('naar de dichtstbijzijnde hele euro', () => {
		expect(roundEuro(12349)).toBe(12300);
		expect(roundEuro(12350)).toBe(12400);
		expect(roundEuro(12351)).toBe(12400);
		expect(roundEuro(49)).toBe(0);
	});
});

describe('voorstel per categorie', () => {
	it('is de mediaan van de maanden, op hele euro', () => {
		const p = proposeLimit([18040, 34000, 22510, 25000], 0);
		expect(p).toEqual({
			kind: 'voorstel',
			proposalCents: 23800,
			plannedCents: 0,
			medianCents: 23755,
			lowestCents: 18040,
			highestCents: 34000
		});
	});

	it('telt op wat er deze maand gepland is, ook in de laagste en hoogste maand', () => {
		const p = proposeLimit([4000, 6000, 5000], 2500);
		expect(p).toMatchObject({
			proposalCents: 7500,
			plannedCents: 2500,
			lowestCents: 6500,
			highestCents: 8500
		});
	});

	it('rondt de som af, niet de delen', () => {
		// 25,40 gepland + 40,40 mediaan = 65,80 → 66
		expect(proposeLimit([4040, 4040, 4040], 2540)).toMatchObject({ proposalCents: 6600 });
	});

	it('mediaan € 0 en niets gepland: geen voorstel', () => {
		expect(proposeLimit([0, 0, 8000], 0)).toEqual({ kind: 'geen_uitgaven' });
		expect(proposeLimit([0, 0, 0], 0)).toEqual({ kind: 'geen_uitgaven' });
	});

	it('mediaan € 0 maar wel iets gepland: het geplande bedrag', () => {
		expect(proposeLimit([0, 0, 0], 4500)).toMatchObject({ kind: 'voorstel', proposalCents: 4500 });
	});

	it('een maand met meer terug dan uitgegeven telt als € 0', () => {
		expect(proposeLimit([-3000, 6000, 8000], 0)).toMatchObject({
			proposalCents: 6000,
			lowestCents: 0
		});
	});
});

describe('plan met spaardoel', () => {
	const base = { incomeCents: 250000, savingsCents: 0, existingLimitsCents: 90000 };

	it('telt bestaande limieten en aangevinkte voorstellen op', () => {
		expect(plan({ ...base, chosenCents: [40000, 25000] })).toEqual({
			totalCents: 155000,
			leftCents: 95000,
			distributableCents: 250000,
			shortfallCents: 0
		});
	});

	it('toont het tekort als het totaal boven inkomen min spaardoel komt', () => {
		const p = plan({ ...base, savingsCents: 100000, chosenCents: [40000, 28500] });
		expect(p.distributableCents).toBe(150000);
		expect(p.shortfallCents).toBe(8500);
		expect(p.leftCents).toBe(91500);
	});

	it('geen tekort als het precies past', () => {
		expect(plan({ ...base, savingsCents: 95000, chosenCents: [40000, 25000] }).shortfallCents).toBe(
			0
		);
	});
});

describe('volgorde bij een tekort', () => {
	it('grootste verschil tussen voorstel en laagste maand eerst, verder stabiel', () => {
		const rows = [
			{ id: 'a', valueCents: 30000, lowestCents: 25000 },
			{ id: 'b', valueCents: 30000, lowestCents: 10000 },
			{ id: 'c', valueCents: 8000, lowestCents: 3000 },
			{ id: 'd', valueCents: 12000, lowestCents: 2000 }
		];
		expect(byRoom(rows).map((r) => r.id)).toEqual(['b', 'd', 'a', 'c']);
	});
});

describe('zin over de periode', () => {
	it('binnen één jaar zonder jaartal', () => {
		expect(periodSentence(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'])).toBe(
			'Mediaan van april tot en met september'
		);
	});

	it('over de jaarwisseling met jaartallen', () => {
		expect(periodSentence(['2025-11', '2025-12', '2026-01'])).toBe(
			'Mediaan van november 2025 tot en met januari 2026'
		);
	});
});
