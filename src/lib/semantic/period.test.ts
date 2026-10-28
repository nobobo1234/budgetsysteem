import { describe, expect, it } from 'vitest';
import type { Period } from './format.ts';
import { formatRange, resolvePeriod, todayIn, type ResolvedPeriod } from './period.ts';

// Relatieve periodes in code (spec: Semantische laag, Tests): rond de jaarwisseling en de
// zomertijd, met de klok van Nederland.

function resolved(period: Period, today: string, earliest?: string): ResolvedPeriod {
	const r = resolvePeriod(period, today, earliest);
	if ('error' in r) throw new Error(r.error);
	return r;
}

const range = (period: Period, today: string) => {
	const r = resolved(period, today);
	return [r.from, r.to];
};

describe('vandaag in Nederland', () => {
	it('na middernacht in Nederland is het al de volgende dag, ook als UTC nog gisteren is', () => {
		// Oudejaarsavond 23:30 UTC is 0:30 op nieuwjaarsdag (wintertijd, UTC+1)
		expect(todayIn(new Date('2025-12-31T23:30:00Z'))).toBe('2026-01-01');
		// 31 maart 22:30 UTC is 0:30 op 1 april (zomertijd, UTC+2)
		expect(todayIn(new Date('2026-03-31T22:30:00Z'))).toBe('2026-04-01');
		expect(todayIn(new Date('2026-03-31T21:30:00Z'))).toBe('2026-03-31');
	});

	it('de nacht waarin de klok verzet wordt', () => {
		// 29 maart 2026: om 2:00 naar 3:00; 0:59 UTC is 2:59 zomertijd
		expect(todayIn(new Date('2026-03-29T00:59:00Z'))).toBe('2026-03-29');
		// 25 oktober 2026: om 3:00 terug naar 2:00; 22:59 UTC is nog 23:59 op de 25e
		expect(todayIn(new Date('2026-10-25T22:59:00Z'))).toBe('2026-10-25');
		expect(todayIn(new Date('2026-10-25T23:00:00Z'))).toBe('2026-10-26');
	});

	it('"deze maand" volgt de dag in Nederland', () => {
		const today = todayIn(new Date('2026-03-31T22:30:00Z'));
		expect(range({ woord: 'deze_maand' }, today)).toEqual(['2026-04-01', '2026-04-01']);
		expect(range({ woord: 'vorige_maand' }, today)).toEqual(['2026-03-01', '2026-03-31']);
	});
});

describe('woorden rond de jaarwisseling', () => {
	const today = '2026-01-02';

	it('vorige maand en vorig jaar liggen in het oude jaar', () => {
		expect(range({ woord: 'vorige_maand' }, today)).toEqual(['2025-12-01', '2025-12-31']);
		expect(range({ woord: 'vorig_jaar' }, today)).toEqual(['2025-01-01', '2025-12-31']);
	});

	it('dit jaar loopt van 1 januari tot vandaag', () => {
		const r = resolved({ woord: 'dit_jaar' }, today);
		expect([r.from, r.to]).toEqual(['2026-01-01', '2026-01-02']);
		expect(r.assumption).toBe('dit jaar = 1 januari tot en met 2 januari 2026');
		expect(r.fullMonths).toEqual([]);
	});

	it('de laatste maanden zijn volle maanden vóór deze maand', () => {
		const r = resolved({ woord: 'laatste_3_maanden' }, today);
		expect([r.from, r.to]).toEqual(['2025-10-01', '2025-12-31']);
		expect(r.fullMonths).toEqual(['2025-10', '2025-11', '2025-12']);
		expect(range({ woord: 'laatste_12_maanden' }, today)).toEqual(['2025-01-01', '2025-12-31']);
	});

	it('sinds de zomer: de laatste 1 juni die al geweest is', () => {
		expect(range({ woord: 'sinds_de_zomer' }, today)).toEqual(['2025-06-01', '2026-01-02']);
		expect(range({ woord: 'sinds_de_zomer' }, '2026-06-01')).toEqual(['2026-06-01', '2026-06-01']);
		expect(range({ woord: 'sinds_de_zomer' }, '2026-05-31')).toEqual(['2025-06-01', '2026-05-31']);
	});

	it('alles begint bij de eerste geboekte dag', () => {
		expect(resolved({ woord: 'alles' }, today, '2024-09-14').from).toBe('2024-09-14');
		// Zonder gegevens: alleen vandaag
		expect(range({ woord: 'alles' }, today)).toEqual([today, today]);
	});
});

describe('eigen periodes', () => {
	const today = '2026-10-21';

	it('een maand loopt van de eerste tot de laatste dag', () => {
		expect(range({ van: '2026-02', tot: '2026-02' }, today)).toEqual(['2026-02-01', '2026-02-28']);
		expect(range({ van: '2024-02', tot: '2024-02' }, today)).toEqual(['2024-02-01', '2024-02-29']);
	});

	it('een periode die na vandaag doorloopt, stopt vandaag', () => {
		const r = resolved({ van: '2026-10', tot: '2026-12' }, today);
		expect([r.from, r.to]).toEqual(['2026-10-01', '2026-10-21']);
		expect(r.months).toEqual(['2026-10']);
		expect(r.fullMonths).toEqual([]);
	});

	it('fouten: een datum die niet bestaat, de verkeerde volgorde, de toekomst', () => {
		expect(resolvePeriod({ van: '2026-02-30', tot: '2026-03-01' }, today)).toEqual({
			error: 'datum'
		});
		expect(resolvePeriod({ van: '2026-05', tot: '2026-03' }, today)).toEqual({
			error: 'volgorde'
		});
		expect(resolvePeriod({ van: '2026-11', tot: '2026-11' }, today)).toEqual({
			error: 'toekomst'
		});
	});

	it('een deel van een maand is geen volle maand', () => {
		const r = resolved({ van: '2026-03-15', tot: '2026-05-31' }, today);
		expect(r.months).toEqual(['2026-03', '2026-04', '2026-05']);
		expect(r.fullMonths).toEqual(['2026-04', '2026-05']);
		expect(r.assumption).toBe('periode = 15 maart tot en met 31 mei 2026');
	});
});

describe('datums in een zin', () => {
	it('het jaar staat er één keer als beide in hetzelfde jaar vallen', () => {
		expect(formatRange('2026-01-01', '2026-10-27')).toBe('1 januari tot en met 27 oktober 2026');
		expect(formatRange('2025-09-01', '2026-01-31')).toBe(
			'1 september 2025 tot en met 31 januari 2026'
		);
		expect(formatRange('2026-03-14', '2026-03-14')).toBe('14 maart 2026');
	});
});
