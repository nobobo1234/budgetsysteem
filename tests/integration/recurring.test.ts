import Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { monthOverview, setBudget } from '../../src/lib/server/budgets.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	accounts,
	categories,
	jobs,
	owed,
	recurring,
	reservations,
	transactionSplits,
	transactions
} from '../../src/lib/server/db/schema.ts';
import { runDueJobs } from '../../src/lib/server/jobs.ts';
import { applyShare, shareFromNames } from '../../src/lib/server/owed.ts';
import {
	MONTHLY_JOB,
	awaitingConfirmation,
	chargesThisMonth,
	confirmExpected,
	confirmProposal,
	generateMonth,
	getRecurring,
	onRecurringEvent,
	recurringOverview,
	refreshProposals,
	rejectProposal,
	reserveBalance,
	scheduleRecurringJobs,
	skipExpected,
	stopRecurring,
	updateRecurring,
	type RecurringEvent
} from '../../src/lib/server/recurring.ts';
import { deleteTransaction, ValidationError } from '../../src/lib/server/transactions.ts';
import { tempDatabase } from './helpers.ts';

// Alleen test-IBANs (scripts/test-ibans.txt)
const RENT_IBAN = 'NL20INGB0001234567';
const CLUB_IBAN = 'NL91ABNA0417164300';

let db: DB;
let cleanup: () => void;
let sns: string;
let cat: (name: string) => string;

beforeEach(() => {
	({ db, cleanup } = tempDatabase());
	sns = db.select().from(accounts).where(eq(accounts.alias, 'sns')).get()!.id;
	cat = (name) => db.select().from(categories).where(eq(categories.name, name)).get()!.id;
});
afterEach(() => cleanup());

function history(rows: [date: string, cents: number, counterparty: string, iban: string | null][]) {
	db.insert(transactions)
		.values(
			rows.map(([date, cents, counterparty, counterIban]) => ({
				amountCents: -cents,
				date,
				counterparty,
				counterIban,
				accountId: sns,
				source: 'import' as const
			}))
		)
		.run();
}

const rentHistory = () =>
	history(
		['2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01'].map(
			(d) => [d, 85000, 'Woonstichting', RENT_IBAN]
		)
	);

function proposal(name: string) {
	return db.select().from(recurring).where(eq(recurring.counterparty, name)).get()!;
}

function expectedPosts(recurringId: string) {
	return db
		.select()
		.from(transactions)
		.where(and(eq(transactions.recurringId, recurringId), eq(transactions.status, 'verwacht')))
		.all();
}

function line(month: string, today: string, name: string) {
	return monthOverview(db, month, today).lines.find((l) => l.categoryId === cat(name))!;
}

describe('voorstellen', () => {
	it('stelt vaste lasten uit de historie voor, en voegt niets toe zonder bevestiging', () => {
		rentHistory();
		history([['2026-10-12', 2500, 'Bakker', null]]);
		expect(refreshProposals(db, '2026-10-24')).toBe(1);
		const p = proposal('Woonstichting');
		expect(p).toMatchObject({ status: 'voorstel', interval: 'maand', nextDate: '2026-11-01' });
		expect(db.select().from(transactions).where(eq(transactions.status, 'verwacht')).all()).toEqual(
			[]
		);
		// Opnieuw zoeken maakt geen tweede voorstel
		expect(refreshProposals(db, '2026-10-24')).toBe(0);
	});

	it('een afgewezen voorstel komt niet terug', () => {
		rentHistory();
		refreshProposals(db, '2026-10-24');
		rejectProposal(db, proposal('Woonstichting').id);
		expect(refreshProposals(db, '2026-10-24')).toBe(0);
		expect(recurringOverview(db, '2026-10-24').proposals).toEqual([]);
	});

	it('negeert interne overboekingen', () => {
		history(
			['2026-08-25', '2026-09-25', '2026-10-23'].map((d) => [d, 20000, 'Eigen spaarrekening', null])
		);
		db.update(transactions)
			.set({ categoryId: cat('Interne overboeking'), categorySource: 'intern' })
			.run();
		expect(refreshProposals(db, '2026-10-24')).toBe(0);
	});
});

describe('bevestigen en verwachte posten', () => {
	it('bij bevestigen kun je de volgende datum aanpassen; de post komt in die maand', () => {
		rentHistory();
		refreshProposals(db, '2026-10-24');
		const p = proposal('Woonstichting');
		confirmProposal(
			db,
			p.id,
			{ nextDate: '2026-10-28', categoryId: cat('Wonen'), spread: false },
			'2026-10-24'
		);
		const [post] = expectedPosts(p.id);
		expect(post).toMatchObject({
			date: '2026-10-28',
			amountCents: -85000,
			status: 'verwacht',
			source: 'verwacht',
			categoryId: cat('Wonen')
		});
		expect(() =>
			confirmProposal(db, p.id, { nextDate: '2026-11-01', categoryId: null, spread: false })
		).toThrow(ValidationError);
	});

	it('de maandjob maakt verwachte posten en reserveringen aan, één keer', () => {
		rentHistory();
		history([
			['2025-11-03', 9000, 'Studievereniging', CLUB_IBAN],
			['2026-05-04', 9000, 'Studievereniging', CLUB_IBAN]
		]);
		refreshProposals(db, '2026-10-24');
		const rent = proposal('Woonstichting');
		const club = proposal('Studievereniging');
		expect(club).toMatchObject({ interval: 'halfjaar', spread: true, nextDate: '2026-11-03' });
		confirmProposal(
			db,
			rent.id,
			{ nextDate: '2026-11-01', categoryId: cat('Wonen'), spread: false },
			'2026-10-24'
		);
		confirmProposal(
			db,
			club.id,
			{ nextDate: '2026-11-03', categoryId: cat('Hobby en entertainment'), spread: true },
			'2026-10-24'
		);
		// Instappen in oktober: de helft nu, de rest in november
		expect(reserveBalance(db, club.id, '2026-10')).toBe(4500);

		const events: RecurringEvent[] = [];
		const off = onRecurringEvent((e) => events.push(e));
		scheduleRecurringJobs(db, new Date(2026, 10, 1, 0, 5));
		expect(runDueJobs(db, new Date(2026, 10, 1, 0, 6))).toBe(1);
		off();

		expect(expectedPosts(rent.id)).toHaveLength(1);
		expect(expectedPosts(club.id)).toHaveLength(1);
		const nov = db
			.select()
			.from(reservations)
			.where(and(eq(reservations.recurringId, club.id), eq(reservations.month, '2026-11')))
			.get();
		expect(nov).toMatchObject({ amountCents: 4500, transactionId: expectedPosts(club.id)[0]!.id });
		expect(events).toEqual([{ type: 'verwacht', transactionIds: expect.any(Array) }]);
		expect((events[0] as { transactionIds: string[] }).transactionIds).toHaveLength(2);

		// De job plant zichzelf voor de eerste van de volgende maand in
		const next = db
			.select()
			.from(jobs)
			.where(and(eq(jobs.kind, MONTHLY_JOB), eq(jobs.status, 'wachtend')))
			.get();
		expect(new Date(next!.runAt).getMonth()).toBe(11);

		// Nog een keer draaien maakt niets dubbel
		expect(generateMonth(db, '2026-11')).toEqual({ expected: 0, reservations: 0 });
	});

	it('één tik bevestigt; de vaste last schuift door naar de volgende maand', () => {
		rentHistory();
		refreshProposals(db, '2026-10-24');
		const rent = proposal('Woonstichting');
		confirmProposal(
			db,
			rent.id,
			{ nextDate: '2026-11-01', categoryId: cat('Wonen'), spread: false },
			'2026-10-24'
		);
		generateMonth(db, '2026-11');
		setBudget(db, '2026-11', cat('Wonen'), 100000);
		const [post] = expectedPosts(rent.id);

		// Verwacht: telt in de planning, nog niet in de uitgaven
		let l = line('2026-11', '2026-11-01', 'Wonen');
		expect(l).toMatchObject({ spentCents: 0, plannedCents: 85000, plannedSpentCents: 0 });
		expect(awaitingConfirmation(db, '2026-11-01').map((a) => a.id)).toEqual([post!.id]);

		confirmExpected(db, post!.id, undefined, '2026-11-01');
		expect(db.select().from(transactions).where(eq(transactions.id, post!.id)).get()).toMatchObject(
			{ status: 'bevestigd', amountCents: -85000 }
		);
		expect(proposal('Woonstichting').nextDate).toBe('2026-12-01');
		l = line('2026-11', '2026-11-01', 'Wonen');
		// Huur op de eerste kleurt de balk niet oranje
		expect(l).toMatchObject({ spentCents: 85000, plannedSpentCents: 85000, pace: 'rustig' });
		expect(awaitingConfirmation(db, '2026-11-01')).toEqual([]);
		// Al bevestigd: nog een keer kan niet
		expect(() => confirmExpected(db, post!.id)).toThrow(ValidationError);
	});

	it('een wisselende last bevestig je met het echte bedrag; boven 120% is een uitschieter', () => {
		history(
			[
				['2026-06-12', 9000],
				['2026-07-12', 11000],
				['2026-08-12', 10000],
				['2026-09-12', 12000],
				['2026-10-12', 9500]
			].map(([d, c]) => [d as string, c as number, 'Vattenfall', CLUB_IBAN] as const)
		);
		refreshProposals(db, '2026-10-24');
		const energy = proposal('Vattenfall');
		expect(energy.kind).toBe('wisselend');
		confirmProposal(
			db,
			energy.id,
			{ nextDate: '2026-11-12', categoryId: cat('Energie en water'), spread: false },
			'2026-10-24'
		);
		generateMonth(db, '2026-11');
		const [post] = expectedPosts(energy.id);
		expect(post!.amountCents).toBe(-10000);
		const events: RecurringEvent[] = [];
		const off = onRecurringEvent((e) => events.push(e));
		expect(confirmExpected(db, post!.id, 14500, '2026-11-12').signal).toBe('uitschieter');
		off();
		expect(events).toContainEqual({
			type: 'signaal',
			recurringId: energy.id,
			signal: 'uitschieter'
		});
		expect(proposal('Vattenfall')).toMatchObject({
			signal: 'uitschieter',
			signalFromCents: 12000,
			signalToCents: 14500,
			maxCents: 14500
		});
	});

	it('een vaste last 2% duurder: prijsverhoging en een nieuw verwacht bedrag', () => {
		history(['2026-08-05', '2026-09-05', '2026-10-05'].map((d) => [d, 1299, 'Netflix', CLUB_IBAN]));
		refreshProposals(db, '2026-10-24');
		const n = proposal('Netflix');
		confirmProposal(
			db,
			n.id,
			{ nextDate: '2026-11-05', categoryId: cat('Abonnementen'), spread: false },
			'2026-10-24'
		);
		generateMonth(db, '2026-11');
		confirmExpected(db, expectedPosts(n.id)[0]!.id, 1399, '2026-11-05');
		expect(proposal('Netflix')).toMatchObject({
			signal: 'prijsverhoging',
			signalFromCents: 1299,
			signalToCents: 1399,
			medianCents: 1399
		});
		generateMonth(db, '2026-12');
		expect(expectedPosts(n.id)[0]!.amountCents).toBe(-1399);
	});

	it('gemist: de post vervalt en de vaste last loopt door; opgezegd: hij stopt', () => {
		rentHistory();
		refreshProposals(db, '2026-10-24');
		const rent = proposal('Woonstichting');
		confirmProposal(
			db,
			rent.id,
			{ nextDate: '2026-10-01', categoryId: cat('Wonen'), spread: false },
			'2026-10-24'
		);
		const [post] = expectedPosts(rent.id);
		expect(awaitingConfirmation(db, '2026-10-24')[0]).toMatchObject({ id: post!.id, missed: true });
		skipExpected(db, post!.id, 'gemist', '2026-10-24');
		expect(expectedPosts(rent.id)).toEqual([]);
		expect(proposal('Woonstichting')).toMatchObject({ status: 'actief', nextDate: '2026-11-01' });

		generateMonth(db, '2026-11');
		skipExpected(db, expectedPosts(rent.id)[0]!.id, 'opgezegd', '2026-11-09');
		expect(proposal('Woonstichting')).toMatchObject({ status: 'gestopt', nextDate: null });
		expect(generateMonth(db, '2026-12')).toEqual({ expected: 0, reservations: 0 });
	});

	it('een verwachte post verwijderen is "deze keer niet"', () => {
		rentHistory();
		refreshProposals(db, '2026-10-24');
		const rent = proposal('Woonstichting');
		confirmProposal(
			db,
			rent.id,
			{ nextDate: '2026-10-30', categoryId: cat('Wonen'), spread: false },
			'2026-10-24'
		);
		deleteTransaction(db, expectedPosts(rent.id)[0]!.id);
		// De gekozen datum zet ook de verwachte dag
		expect(proposal('Woonstichting')).toMatchObject({ expectedDay: 30, nextDate: '2026-11-30' });
		expect(generateMonth(db, '2026-10').expected).toBe(0);
	});
});

/** Vereniging uit de spec: €90 in januari en juli, €8 dispuut per maand. */
function club() {
	history([
		['2025-07-01', 9000, 'Vereniging', CLUB_IBAN],
		['2026-01-02', 9000, 'Vereniging', CLUB_IBAN]
	]);
	refreshProposals(db, '2026-01-20');
	const c = proposal('Vereniging');
	expect(c).toMatchObject({ interval: 'halfjaar', nextDate: '2026-07-01' });
	confirmProposal(
		db,
		c.id,
		{ nextDate: '2026-07-01', categoryId: cat('Hobby en entertainment'), spread: true },
		'2026-02-01'
	);
	return c.id;
}

describe('reserveringen in het budget', () => {
	it('elke maand €15 opzij; in de afschrijfmaand komt de €90 uit de reservering', () => {
		const id = club();
		setBudget(db, '2026-02', cat('Hobby en entertainment'), 2300);
		for (const month of ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07'])
			generateMonth(db, month);
		const amounts = db
			.select({ month: reservations.month, amountCents: reservations.amountCents })
			.from(reservations)
			.where(eq(reservations.recurringId, id))
			.all();
		expect(amounts.map((r) => r.amountCents)).toEqual([1500, 1500, 1500, 1500, 1500, 1500]);

		// Een maand voor de afschrijving: €15 telt als uitgave en is gepland, tempo alleen op de rest
		const june = line('2026-06', '2026-06-10', 'Hobby en entertainment');
		expect(june).toMatchObject({
			spentCents: 1500,
			plannedCents: 1500,
			plannedSpentCents: 1500,
			freeLimitCents: 800
		});
		expect(june.reserves[0]).toMatchObject({ reservedCents: 7500, expectedCents: 9000 });

		// Afschrijfmaand vóór bevestigen: alleen de reservering, de €90 is al opzij
		let july = line('2026-07', '2026-07-01', 'Hobby en entertainment');
		expect(july).toMatchObject({ spentCents: 1500, plannedCents: 1500 });

		const [post] = expectedPosts(id);
		confirmExpected(db, post!.id, undefined, '2026-07-02');
		july = line('2026-07', '2026-07-02', 'Hobby en entertainment');
		expect(july).toMatchObject({ spentCents: 1500, plannedSpentCents: 1500 });
		// Daarna begint de reservering weer bij nul, en de volgende is januari
		expect(reserveBalance(db, id, '2026-07')).toBe(0);
		expect(proposal('Vereniging').nextDate).toBe('2027-01-01');
		generateMonth(db, '2026-08');
		expect(reserveBalance(db, id, '2026-08')).toBe(1500);
	});

	it('duurder dan gereserveerd is een extra uitgave, goedkoper geeft de rest terug', () => {
		const id = club();
		for (const month of ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07'])
			generateMonth(db, month);
		const [post] = expectedPosts(id);
		confirmExpected(db, post!.id, 9500, '2026-07-02');
		expect(line('2026-07', '2026-07-02', 'Hobby en entertainment').spentCents).toBe(2000);
	});

	it('goedkoper geeft de rest terug', () => {
		const id = club();
		for (const month of ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07'])
			generateMonth(db, month);
		confirmExpected(db, expectedPosts(id)[0]!.id, 8500, '2026-07-02');
		expect(line('2026-07', '2026-07-02', 'Hobby en entertainment').spentCents).toBe(1000);
	});

	it('stoppen laat wat gereserveerd is vrijvallen in die maand; eerdere maanden blijven', () => {
		const id = club();
		for (const month of ['2026-03', '2026-04']) generateMonth(db, month);
		stopRecurring(db, id, '2026-04-15');
		expect(line('2026-03', '2026-04-15', 'Hobby en entertainment').spentCents).toBe(1500);
		// April: €15 opzij en €45 vrijgevallen
		expect(line('2026-04', '2026-04-15', 'Hobby en entertainment').spentCents).toBe(-3000);
		expect(reserveBalance(db, id, '2026-04')).toBe(0);
		expect(generateMonth(db, '2026-05')).toEqual({ expected: 0, reservations: 0 });
	});

	it('uitsmeren uitzetten: de reservering valt vrij en de afschrijfmaand krijgt de piek', () => {
		const id = club();
		generateMonth(db, '2026-03');
		updateRecurring(db, id, { spread: false }, '2026-03-10');
		expect(reserveBalance(db, id, '2026-03')).toBe(0);
		for (const month of ['2026-04', '2026-05', '2026-06', '2026-07']) generateMonth(db, month);
		expect(line('2026-06', '2026-06-10', 'Hobby en entertainment').spentCents).toBe(0);
		const july = line('2026-07', '2026-07-01', 'Hobby en entertainment');
		expect(july).toMatchObject({ spentCents: 0, plannedCents: 9000 });
	});

	it('een prijsverhoging schuift de volgende reserveringen mee; een afgesloten maand niet', () => {
		const id = club();
		generateMonth(db, '2026-03');
		updateRecurring(db, id, { medianCents: 9600 }, '2026-03-20');
		generateMonth(db, '2026-04');
		const rows = db
			.select({ month: reservations.month, amountCents: reservations.amountCents })
			.from(reservations)
			.where(eq(reservations.recurringId, id))
			.all();
		// Februari en maart €15; april: (€96 − €30) / 4 maanden = €16,50
		expect(rows.map((r) => r.amountCents)).toEqual([1500, 1500, 1650]);
	});

	it('nog vrij telt reserveringen mee', () => {
		const id = club();
		setBudget(db, '2026-02', cat('Hobby en entertainment'), 2300);
		setBudget(db, '2026-02', cat('Boodschappen'), 30000);
		expect(reserveBalance(db, id, '2026-02')).toBe(1500);
		expect(monthOverview(db, '2026-02', '2026-02-10').freeCents).toBe(2300 + 30000 - 1500);
	});
});

describe('achterstand inhalen', () => {
	/** Huur op de 1e, bevestigd in december voor januari. */
	function rent() {
		history(
			['2025-10-01', '2025-11-01', '2025-12-01'].map((d) => [d, 85000, 'Woonstichting', RENT_IBAN])
		);
		refreshProposals(db, '2025-12-20');
		const r = proposal('Woonstichting');
		confirmProposal(
			db,
			r.id,
			{ nextDate: '2026-01-01', categoryId: cat('Wonen'), spread: false },
			'2025-12-20'
		);
		return r.id;
	}
	const dates = (id: string) => expectedPosts(id).map((t) => t.date);

	it('een open post van vorige maand houdt de volgende maand niet tegen', () => {
		const id = rent();
		for (const month of ['2026-01', '2026-02', '2026-03']) generateMonth(db, month);
		expect(dates(id)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
		// Januari pas in maart bevestigen: februari en maart blijven staan, april komt erbij
		confirmExpected(db, expectedPosts(id)[0]!.id, undefined, '2026-03-05');
		expect(proposal('Woonstichting').nextDate).toBe('2026-02-01');
		generateMonth(db, '2026-04');
		expect(dates(id)).toEqual(['2026-02-01', '2026-03-01', '2026-04-01']);
	});

	it('een post van vorige maand weggooien laat deze maand en de volgende staan', () => {
		const id = rent();
		generateMonth(db, '2026-01');
		generateMonth(db, '2026-02');
		deleteTransaction(db, expectedPosts(id)[0]!.id);
		expect(proposal('Woonstichting').nextDate).toBe('2026-02-01');
		generateMonth(db, '2026-03');
		expect(dates(id)).toEqual(['2026-02-01', '2026-03-01']);
	});

	it('een maand zonder job: de gemiste post komt alsnog, als "gemist of opgezegd?"', () => {
		const id = rent();
		generateMonth(db, '2026-01');
		confirmExpected(db, expectedPosts(id)[0]!.id, undefined, '2026-01-02');
		// In februari draaide de job niet
		generateMonth(db, '2026-03');
		expect(dates(id)).toEqual(['2026-02-01', '2026-03-01']);
		const awaiting = awaitingConfirmation(db, '2026-03-10');
		expect(awaiting.map((a) => [a.date, a.missed])).toEqual([
			['2026-02-01', true],
			['2026-03-01', true]
		]);
		// Overslaan haalt alleen februari weg
		skipExpected(db, awaiting[0]!.id, 'gemist', '2026-03-10');
		expect(dates(id)).toEqual(['2026-03-01']);
		expect(proposal('Woonstichting').nextDate).toBe('2026-03-01');
	});
});

describe('categorie van een uitgesmeerde vaste last wijzigen', () => {
	const hobby = (month: string, today: string) => line(month, today, 'Hobby en entertainment');
	const abo = (month: string, today: string) => line(month, today, 'Abonnementen');

	it('afgesloten maanden houden hun reservering; vanaf deze maand de nieuwe categorie', () => {
		const id = club();
		for (const month of ['2026-03', '2026-04']) generateMonth(db, month);
		updateRecurring(db, id, { categoryId: cat('Abonnementen') }, '2026-04-10');
		expect(hobby('2026-03', '2026-04-10').spentCents).toBe(1500);
		expect(abo('2026-03', '2026-04-10').spentCents).toBe(0);
		expect(hobby('2026-04', '2026-04-10').spentCents).toBe(0);
		expect(abo('2026-04', '2026-04-10').spentCents).toBe(1500);
	});

	it('na de afschrijving blijft de afschrijfmaand zoals hij was', () => {
		const id = club();
		for (const month of ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07'])
			generateMonth(db, month);
		confirmExpected(db, expectedPosts(id)[0]!.id, undefined, '2026-07-02');
		updateRecurring(db, id, { categoryId: cat('Abonnementen') }, '2026-08-03');
		expect(hobby('2026-07', '2026-08-03').spentCents).toBe(1500);
		expect(abo('2026-07', '2026-08-03').spentCents).toBe(0);
	});
});

describe('gedeelde vaste last', () => {
	function ziggo() {
		history(['2026-08-05', '2026-09-05', '2026-10-05'].map((d) => [d, 6000, 'Ziggo', RENT_IBAN]));
		refreshProposals(db, '2026-10-24');
		const z = proposal('Ziggo');
		confirmProposal(
			db,
			z.id,
			{ nextDate: '2026-11-05', categoryId: cat('Abonnementen'), spread: false },
			'2026-10-24'
		);
		generateMonth(db, '2026-11');
		const post = expectedPosts(z.id)[0]!;
		db.transaction((tx) => applyShare(tx, post.id, shareFromNames(tx, 3, ['Sanne', 'Tim'])));
		return { id: z.id, post: post.id };
	}
	const splits = (id: string) =>
		db
			.select({ note: transactionSplits.note, amountCents: transactionSplits.amountCents })
			.from(transactionSplits)
			.where(eq(transactionSplits.transactionId, id))
			.all();

	it('tempo telt alleen jouw deel als gepland', () => {
		const { post } = ziggo();
		setBudget(db, '2026-11', cat('Abonnementen'), 10000);
		// Nog verwacht: jouw deel van €60 is gepland
		expect(line('2026-11', '2026-11-04', 'Abonnementen').plannedCents).toBe(2000);
		confirmExpected(db, post, undefined, '2026-11-05');
		db.insert(transactions)
			.values({
				amountCents: -4000,
				date: '2026-11-06',
				counterparty: 'Spotify',
				accountId: sns,
				source: 'handmatig',
				categoryId: cat('Abonnementen')
			})
			.run();
		const l = line('2026-11', '2026-11-10', 'Abonnementen');
		expect(l).toMatchObject({
			spentCents: 6000,
			plannedCents: 2000,
			plannedSpentCents: 2000,
			otherCents: 4000,
			freeLimitCents: 8000
		});
	});

	it('bevestigen met een ander bedrag: hun deel blijft, jouw deel neemt het verschil', () => {
		const { post } = ziggo();
		confirmExpected(db, post, 7500, '2026-11-05');
		expect(splits(post)).toEqual(
			expect.arrayContaining([
				{ note: 'Mijn deel', amountCents: -3500 },
				{ note: 'Voorgeschoten', amountCents: -4000 }
			])
		);
		// Lager dan wat de anderen moeten kan niet; de post blijft verwacht
		const second = ziggo2();
		expect(() => confirmExpected(db, second, 3000, '2026-12-05')).toThrow(ValidationError);
		expect(db.select().from(transactions).where(eq(transactions.id, second)).get()!.status).toBe(
			'verwacht'
		);
	});

	it('overslaan of stoppen laat geen open posten van anderen achter', () => {
		const { id, post } = ziggo();
		skipExpected(db, post, 'gemist', '2026-11-12');
		expect(db.select().from(owed).all()).toEqual([]);
		generateMonth(db, '2026-12');
		const dec = expectedPosts(id)[0]!;
		db.transaction((tx) => applyShare(tx, dec.id, shareFromNames(tx, 2, ['Sanne'])));
		stopRecurring(db, id, '2026-12-01');
		expect(db.select().from(owed).all()).toEqual([]);
	});

	/** December: de volgende post van Ziggo, gedeeld met Sanne en Tim. */
	function ziggo2() {
		const z = proposal('Ziggo');
		generateMonth(db, '2026-12');
		const post = expectedPosts(z.id).find((t) => t.date.startsWith('2026-12'))!;
		db.transaction((tx) => applyShare(tx, post.id, shareFromNames(tx, 3, ['Sanne', 'Tim'])));
		return post.id;
	}
});

describe('afschrijving van een vaste last verwijderen', () => {
	it('een prijsverhoging van die afschrijving gaat terug; het geld staat weer opzij', () => {
		const id = club();
		for (const month of ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07'])
			generateMonth(db, month);
		const post = expectedPosts(id)[0]!;
		expect(confirmExpected(db, post.id, 9900, '2026-07-02').signal).toBe('prijsverhoging');
		expect(proposal('Vereniging').medianCents).toBe(9900);
		deleteTransaction(db, post.id);
		expect(proposal('Vereniging')).toMatchObject({
			medianCents: 9000,
			lastCents: 9000,
			signal: null,
			// Weggooien is "deze keer niet": de vaste last schuift niet terug
			nextDate: '2027-01-01'
		});
		expect(reserveBalance(db, id, '2026-07')).toBe(9000);
	});
});

describe('vrijval in een categorie zonder limiet', () => {
	it('stoppen geeft alles wat opzij stond terug in nog vrij', () => {
		const id = club();
		setBudget(db, '2026-02', cat('Boodschappen'), 30000);
		for (const month of ['2026-03', '2026-04']) generateMonth(db, month);
		const before = monthOverview(db, '2026-04', '2026-04-15').freeCents;
		stopRecurring(db, id, '2026-04-15');
		const after = monthOverview(db, '2026-04', '2026-04-15').freeCents;
		// Februari, maart en april stond er elk €15 opzij
		expect(after - before).toBe(4500);
	});
});

describe('migratie', () => {
	it('een bestaande rij in recurring overleeft de migratie naar vaste lasten (0004)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'budget-migratie-'));
		try {
			cpSync('drizzle', join(dir, 'drizzle'), { recursive: true });
			const journalPath = join(dir, 'drizzle', 'meta', '_journal.json');
			const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
			const full = structuredClone(journal);
			journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < '0004');
			writeFileSync(journalPath, JSON.stringify(journal));

			const sqlite = new Database(join(dir, 'budget.db'));
			const old = drizzle(sqlite);
			migrate(old, { migrationsFolder: join(dir, 'drizzle') });
			sqlite
				.prepare(
					`INSERT INTO recurring (id, counterparty, interval, expected_day, median_cents, min_cents, max_cents, kind)
					 VALUES ('r1', 'Oud', 'maand', 5, 1000, 1000, 1000, 'vast')`
				)
				.run();

			writeFileSync(journalPath, JSON.stringify(full));
			migrate(old, { migrationsFolder: join(dir, 'drizzle') });
			expect(sqlite.prepare('SELECT match_key, status, spread FROM recurring').get()).toEqual({
				match_key: 'oud:r1',
				status: 'voorstel',
				spread: 0
			});
			sqlite.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('bestaande reserveringen krijgen de categorie van hun vaste last (0006)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'budget-migratie-'));
		try {
			cpSync('drizzle', join(dir, 'drizzle'), { recursive: true });
			const journalPath = join(dir, 'drizzle', 'meta', '_journal.json');
			const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
			const full = structuredClone(journal);
			journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < '0006');
			writeFileSync(journalPath, JSON.stringify(journal));

			const sqlite = new Database(join(dir, 'budget.db'));
			const old = drizzle(sqlite);
			migrate(old, { migrationsFolder: join(dir, 'drizzle') });
			sqlite
				.prepare(`INSERT INTO categories (id, name, "group") VALUES ('c1', 'Club', 'Vrije tijd')`)
				.run();
			sqlite
				.prepare(
					`INSERT INTO recurring (id, counterparty, interval, expected_day, median_cents, min_cents, max_cents, kind, match_key, category_id)
					 VALUES ('r1', 'Club', 'halfjaar', 1, 9000, 9000, 9000, 'vast', 'club', 'c1')`
				)
				.run();
			sqlite
				.prepare(
					`INSERT INTO reservations (id, recurring_id, month, amount_cents) VALUES ('x1', 'r1', '2026-03', 1500)`
				)
				.run();

			writeFileSync(journalPath, JSON.stringify(full));
			migrate(old, { migrationsFolder: join(dir, 'drizzle') });
			expect(sqlite.prepare('SELECT category_id FROM reservations').get()).toEqual({
				category_id: 'c1'
			});
			sqlite.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// C12 en C13: de afschrijvingen uit de import tellen mee, ook al zijn ze niet gekoppeld
describe('afschrijvingen op Vaste lasten en de detailpagina', () => {
	it('de detailpagina toont ook de afschrijvingen uit de historie, met een prijsverhoging', () => {
		history([
			['2026-06-05', 4500, 'ZIGGO SERVICES BV', null],
			['2026-07-05', 4500, 'ZIGGO SERVICES BV', null],
			['2026-08-05', 4800, 'ZIGGO SERVICES BV', null],
			['2026-09-05', 4800, 'ZIGGO SERVICES BV', null],
			['2026-09-12', 1099, 'Spotify AB', null]
		]);
		refreshProposals(db, '2026-09-24');
		const p = proposal('ZIGGO SERVICES BV');
		confirmProposal(
			db,
			p.id,
			{ nextDate: '2026-10-05', categoryId: null, spread: false },
			'2026-09-24'
		);
		const item = getRecurring(db, p.id, '2026-09-24')!;
		// Nieuwste eerst, positieve centen; Spotify hoort er niet bij
		expect(item.history.map((h) => [h.date, h.amountCents])).toEqual([
			['2026-09-05', 4800],
			['2026-08-05', 4800],
			['2026-07-05', 4500],
			['2026-06-05', 4500]
		]);
		// Na de maandjob staat de verwachte post van oktober vooraan
		generateMonth(db, '2026-10');
		const later = getRecurring(db, p.id, '2026-10-02')!;
		expect(later.history[0]).toMatchObject({ date: '2026-10-05', status: 'verwacht' });
	});

	it('de maandstrook: al afgeschreven uit de import, en wat nog komt', () => {
		rentHistory();
		history([
			['2026-07-28', 9500, 'Vattenfall', null],
			['2026-08-28', 10100, 'Vattenfall', null],
			['2026-09-28', 9800, 'Vattenfall', null]
		]);
		refreshProposals(db, '2026-10-24');
		const rent = proposal('Woonstichting');
		const energy = proposal('Vattenfall');
		confirmProposal(
			db,
			rent.id,
			{ nextDate: '2026-11-01', categoryId: cat('Wonen'), spread: false },
			'2026-10-24'
		);
		confirmProposal(
			db,
			energy.id,
			{ nextDate: '2026-10-28', categoryId: null, spread: false },
			'2026-10-24'
		);
		const charges = chargesThisMonth(db, '2026-10-24');
		expect(charges.map((c) => [c.date, c.amountCents, c.done])).toEqual([
			['2026-10-01', 85000, true],
			['2026-10-28', 9800, false]
		]);
		expect(charges[0]).toMatchObject({ recurringId: rent.id, categoryGroup: 'Vaste lasten' });
	});
});
