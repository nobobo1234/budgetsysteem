import { describe, expect, it } from 'vitest';
import {
	addYears,
	dueReminders,
	firstYearEnd,
	formatLeft,
	fullyRefunded,
	isProposal,
	lifetimeEnd,
	nextEnd,
	reminderKey,
	reminderText,
	reminders,
	strip,
	warrantySentence,
	WARRANTY_MIN_CENTS,
	type ProposalFacts
} from './warranty.ts';

// Garantie: de datums, de voorstelregel, de momenten van de herinneringen en de zinnen.

const laptop = {
	purchaseDate: '2026-03-10',
	deliveryDate: '2026-03-12',
	factoryUntil: null,
	lifetimeYears: 5,
	status: 'actief' as const
};

describe('datums', () => {
	it('het eerste jaar loopt tot dezelfde dag een jaar na aflevering', () => {
		expect(firstYearEnd('2026-03-12')).toBe('2027-03-12');
		expect(firstYearEnd('2026-12-31')).toBe('2027-12-31');
	});

	it('29 februari: een jaar later is het 28 februari', () => {
		expect(addYears('2024-02-29', 1)).toBe('2025-02-28');
		expect(firstYearEnd('2028-02-29')).toBe('2029-02-28');
		// In een schrikkeljaar blijft het 29 februari
		expect(addYears('2024-02-29', 4)).toBe('2028-02-29');
		expect(addYears('2023-02-28', 1)).toBe('2024-02-28');
	});

	it('de levensduur telt vanaf de aflevering, in hele jaren', () => {
		expect(lifetimeEnd(laptop)).toBe('2031-03-12');
		expect(lifetimeEnd({ deliveryDate: '2024-02-29', lifetimeYears: 3 })).toBe('2027-02-28');
		expect(lifetimeEnd({ deliveryDate: '2026-03-12', lifetimeYears: 8 })).toBe('2034-03-12');
	});
});

describe('herinneringen', () => {
	it('30 dagen voor het einde van het eerste jaar, en van de fabrieksgarantie als die er is', () => {
		expect(reminders(laptop)).toEqual([
			{ moment: 'jaar', endDate: '2027-03-12', remindOn: '2027-02-10' }
		]);
		expect(reminders({ ...laptop, factoryUntil: '2028-03-12' })).toEqual([
			{ moment: 'jaar', endDate: '2027-03-12', remindOn: '2027-02-10' },
			{ moment: 'fabriek', endDate: '2028-03-12', remindOn: '2028-02-11' }
		]);
	});

	it('aan de beurt vanaf de dag van de herinnering tot het einde, daarna niet meer', () => {
		expect(dueReminders(laptop, '2027-02-09')).toEqual([]);
		expect(dueReminders(laptop, '2027-02-10')).toEqual([
			{ moment: 'jaar', endDate: '2027-03-12', remindOn: '2027-02-10', daysLeft: 30 }
		]);
		// Een gemiste ochtend komt later alsnog, met het echte aantal dagen
		expect(dueReminders(laptop, '2027-03-11')[0]!.daysLeft).toBe(1);
		expect(dueReminders(laptop, '2027-03-12')).toEqual([]);
	});

	it('een afleverdatum die je terugzet, verschuift de herinnering mee', () => {
		const earlier = { ...laptop, deliveryDate: '2026-03-01' };
		expect(reminders(earlier)[0]).toEqual({
			moment: 'jaar',
			endDate: '2027-03-01',
			remindOn: '2027-01-30'
		});
		expect(dueReminders(earlier, '2027-01-29')).toEqual([]);
		expect(dueReminders(earlier, '2027-01-30')).toHaveLength(1);
	});

	it('de sleutel verschilt per moment en per einddatum', () => {
		const [year] = reminders(laptop);
		expect(reminderKey('w1', year!)).toBe('garantie:jaar:w1:2027-03-12');
		expect(reminderKey('w1', { moment: 'fabriek', endDate: '2027-03-12' })).not.toBe(
			reminderKey('w1', year!)
		);
	});

	it('op het vergrendelscherm zonder product of winkel', () => {
		const t = reminderText({ moment: 'jaar', daysLeft: 30 }, 'laptop', 'Coolblue');
		expect(t.text).toBe('Een garantie loopt over 30 dagen af');
		expect(t.text).not.toMatch(/laptop|Coolblue/);
		expect(t.detail).toBe(
			'Nog 30 dagen waarin Coolblue moet bewijzen dat je laptop in orde was. Werkt alles nog?'
		);
		const f = reminderText({ moment: 'fabriek', daysLeft: 1 }, 'wasmachine', 'Bol');
		expect(f.text).toBe('Een garantie loopt over 1 dag af');
		expect(f.detail).toBe('Nog 1 dag fabrieksgarantie op je wasmachine. Werkt alles nog?');
	});
});

describe('voorstelregel', () => {
	const today = '2026-10-28';
	const base: ProposalFacts = {
		amountCents: -64900,
		status: 'bevestigd',
		date: '2026-10-20',
		shareCents: 64900,
		refundedCents: 0,
		decided: false
	};

	it('een bevestigde uitgave vanaf de drempel in een categorie met garantie', () => {
		expect(isProposal(base, today)).toBe(true);
		expect(WARRANTY_MIN_CENTS).toBe(5000);
	});

	it('de drempel geldt voor jouw deel: precies € 50 wel, € 49,99 niet', () => {
		expect(isProposal({ ...base, amountCents: -5000, shareCents: 5000 }, today)).toBe(true);
		expect(isProposal({ ...base, amountCents: -4999, shareCents: 4999 }, today)).toBe(false);
		// Voorgeschoten: € 120 betaald, jouw deel € 40
		expect(isProposal({ ...base, amountCents: -12000, shareCents: 4000 }, today)).toBe(false);
		// De drempel is instelbaar
		expect(isProposal({ ...base, amountCents: -4000, shareCents: 4000 }, today, 2500)).toBe(true);
	});

	it('niet in een categorie zonder garantie (geen deel daarin)', () => {
		expect(isProposal({ ...base, shareCents: 0 }, today)).toBe(false);
	});

	it('een retour die alles verrekent haalt het voorstel weg; een deel niet', () => {
		expect(fullyRefunded({ amountCents: -64900, refundedCents: 64900 })).toBe(true);
		expect(isProposal({ ...base, refundedCents: 64900 }, today)).toBe(false);
		expect(isProposal({ ...base, refundedCents: 10000 }, today)).toBe(true);
	});

	it('een afgewezen voorstel (of een garantie die er al is) komt niet terug', () => {
		expect(isProposal({ ...base, decided: true }, today)).toBe(false);
	});

	it('alleen bevestigde uitgaven, en alleen zolang het eerste jaar na aankoop loopt', () => {
		expect(isProposal({ ...base, status: 'verwacht' }, today)).toBe(false);
		expect(isProposal({ ...base, status: 'te_controleren' }, today)).toBe(false);
		expect(isProposal({ ...base, amountCents: 64900 }, today)).toBe(false);
		expect(isProposal({ ...base, date: '2025-10-29' }, today)).toBe(true);
		expect(isProposal({ ...base, date: '2025-10-28' }, today)).toBe(false);
		expect(isProposal({ ...base, date: '2026-10-29' }, today)).toBe(false);
	});
});

describe('weergave', () => {
	it('in het eerste jaar: wat de winkel nog moet bewijzen', () => {
		expect(warrantySentence(laptop, 'Coolblue', '2026-08-12')).toBe(
			'Coolblue moet nog 7 maanden bewijzen dat hij in orde was.'
		);
		expect(warrantySentence(laptop, 'Coolblue', '2027-03-02')).toBe(
			'Coolblue moet nog 10 dagen bewijzen dat hij in orde was.'
		);
	});

	it('daarna een schatting, en nooit "verlopen"', () => {
		const after = warrantySentence(laptop, 'Coolblue', '2027-03-12');
		expect(after).toBe('Wettelijke garantie kan nog gelden tot ongeveer 2031 (schatting).');
		const late = warrantySentence(laptop, 'Coolblue', '2032-01-01');
		expect(late).toBe('De geschatte levensduur liep tot ongeveer 2031.');
		for (const day of ['2026-03-11', '2026-04-01', '2027-03-12', '2031-03-12', '2040-01-01'])
			expect(warrantySentence(laptop, 'Coolblue', day)).not.toMatch(/verlopen/i);
		expect(warrantySentence({ ...laptop, status: 'afgedankt' }, 'Coolblue', '2026-08-12')).toMatch(
			/geen meldingen/
		);
	});

	it('hoe lang nog: dagen, weken, maanden', () => {
		expect(formatLeft('2026-10-28', '2026-10-29')).toBe('1 dag');
		expect(formatLeft('2026-10-28', '2026-11-10')).toBe('13 dagen');
		expect(formatLeft('2026-10-28', '2026-11-18')).toBe('3 weken');
		expect(formatLeft('2026-10-28', '2026-12-28')).toBe('2 maanden');
		// Hele kalendermaanden: een dag te kort is een maand minder
		expect(formatLeft('2026-08-12', '2027-03-12')).toBe('7 maanden');
		expect(formatLeft('2026-08-13', '2027-03-12')).toBe('6 maanden');
	});

	it('binnenkort: het eerstvolgende einde binnen 60 dagen', () => {
		expect(nextEnd(laptop, '2026-12-01')).toBeNull();
		expect(nextEnd(laptop, '2027-01-11')).toEqual({
			moment: 'jaar',
			endDate: '2027-03-12',
			daysLeft: 60
		});
		const factory = { ...laptop, factoryUntil: '2028-03-12' };
		expect(nextEnd(factory, '2027-03-12')).toBeNull();
		expect(nextEnd(factory, '2028-02-01')?.moment).toBe('fabriek');
	});

	it('de strook loopt van aankoop tot het einde van de levensduur', () => {
		const s = strip({ ...laptop, factoryUntil: '2028-03-12' }, '2026-03-10');
		expect(s.end).toBe('2031-03-12');
		const at = Object.fromEntries(s.marks.map((m) => [m.key, m.at]));
		expect(at.vandaag).toBe(0);
		expect(at.jaar).toBeGreaterThan(0.19);
		expect(at.jaar).toBeLessThan(0.21);
		expect(at.fabriek).toBeGreaterThan(at.jaar!);
		// Vandaag na het einde blijft op de strook
		expect(strip(laptop, '2040-01-01').marks.find((m) => m.key === 'vandaag')!.at).toBe(1);
	});
});
