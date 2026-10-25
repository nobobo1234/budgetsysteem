import Database from 'better-sqlite3';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spendingByCategory } from '../../src/lib/server/budgets.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	accounts,
	auditLog,
	categories,
	owed,
	owedPayments,
	recurring,
	recurringShares,
	reservations,
	transactionSplits,
	transactions
} from '../../src/lib/server/db/schema.ts';
import { importRecords } from '../../src/lib/server/import/importer.ts';
import type { ImportRecord } from '../../src/lib/server/import/types.ts';
import {
	applyShare,
	forgiveOwed,
	settlePayment,
	unlinkPayment
} from '../../src/lib/server/owed.ts';
import { createPerson } from '../../src/lib/server/people.ts';
import {
	confirmExpected,
	generateMonth,
	plannedByCategory,
	recurringOverview,
	reserveStatuses,
	skipExpected,
	stopRecurring
} from '../../src/lib/server/recurring.ts';
import {
	acceptProposal,
	addIban,
	changeShareAmount,
	confirmReceived,
	createShare,
	creditToPayable,
	deleteShare,
	dismissProposal,
	dueReceipts,
	listShares,
	shareProposals,
	sharesOverview,
	updateShare
} from '../../src/lib/server/shares.ts';
import {
	deleteTransaction,
	updateTransaction,
	ValidationError
} from '../../src/lib/server/transactions.ts';
import { tempDatabase } from './helpers.ts';

// Alleen test-IBANs (scripts/test-ibans.txt)
const IBAN_OWN = 'NL12SNSB0123456789';
const IBAN_SANNE = 'NL91ABNA0417164300';
const IBAN_TIM = 'NL02ABNA0123456789';
const IBAN_ZIGGO = 'NL18RABO0123459876';

let db: DB;
let cleanup: () => void;
let sns: string;
let cat: (name: string) => string;
let ziggo: string;
let sanne: string;
let tim: string;

beforeEach(() => {
	({ db, cleanup } = tempDatabase());
	sns = db.select().from(accounts).where(eq(accounts.alias, 'sns')).get()!.id;
	cat = (name) => db.select().from(categories).where(eq(categories.name, name)).get()!.id;
	ziggo = db
		.insert(recurring)
		.values({
			matchKey: `ziggo|${IBAN_ZIGGO}`,
			counterparty: 'Ziggo',
			counterIban: IBAN_ZIGGO,
			interval: 'maand',
			expectedDay: 1,
			medianCents: 6000,
			minCents: 6000,
			maxCents: 6000,
			kind: 'vast',
			nextDate: '2026-10-01',
			categoryId: cat('Internet en telefoon'),
			accountId: sns,
			status: 'actief'
		})
		.returning()
		.get().id;
	sanne = createPerson(db, 'Sanne');
	tim = createPerson(db, 'Tim');
	addIban(db, sanne, IBAN_SANNE);
});
afterEach(() => cleanup());

function share(
	personId: string,
	over: Partial<Parameters<typeof createShare>[1]> = {},
	today = '2026-10-01'
) {
	return createShare(
		db,
		{
			recurringId: ziggo,
			personId,
			kind: 'vast',
			amountCents: 2000,
			receiveDay: 28,
			startMonth: '2026-10',
			...over
		},
		today
	);
}

const sharePosts = () =>
	db.select().from(owed).where(isNotNull(owed.shareId)).orderBy(owed.month, owed.date).all();

const postOf = (personId: string, month: string) =>
	sharePosts().find((p) => p.personId === personId && p.month === month);

function expected(month: string) {
	return db
		.select()
		.from(transactions)
		.where(
			and(eq(transactions.recurringId, ziggo), sql`substr(${transactions.date}, 1, 7) = ${month}`)
		)
		.get()!;
}

function splits(transactionId: string) {
	return Object.fromEntries(
		db
			.select()
			.from(transactionSplits)
			.where(eq(transactionSplits.transactionId, transactionId))
			.all()
			.map((s) => [s.note, s.amountCents])
	);
}

function credit(personId: string) {
	return (
		db
			.select({ n: sql<number>`coalesce(sum(${owedPayments.amountCents}), 0)` })
			.from(owedPayments)
			.where(and(eq(owedPayments.personId, personId), sql`${owedPayments.owedId} IS NULL`))
			.get()?.n ?? 0
	);
}

/** Oktober bevestigen: de vaste last schuift door en de post van november verschijnt. */
function toNovember() {
	confirmExpected(db, expected('2026-10').id, undefined, '2026-10-01');
	generateMonth(db, '2026-11');
}

/** Saldo van een categorie in een maand, zoals in het budget (met splits). */
const spent = (month: string, name: string) => spendingByCategory(db, month).get(cat(name)) ?? 0;

function record(over: Partial<ImportRecord>): ImportRecord {
	return {
		accountIban: IBAN_OWN,
		date: '2026-10-27',
		amountCents: 2000,
		counterparty: 'S DE VRIES',
		counterIban: IBAN_SANNE,
		description: 'Ziggo oktober',
		bankReference: null,
		...over
	};
}

describe('elke maand', () => {
	it('een post per persoon zodra de verwachte post verschijnt, en splits met jouw deel', () => {
		share(sanne);
		share(tim);
		expect(sharePosts()).toEqual([]);
		generateMonth(db, '2026-10');
		const t = expected('2026-10');
		expect(t.status).toBe('verwacht');
		expect(t.amountCents).toBe(-6000);
		expect(sharePosts().map((p) => [p.personId, p.amountCents, p.date, p.month])).toEqual([
			[sanne, 2000, '2026-10-28', '2026-10'],
			[tim, 2000, '2026-10-28', '2026-10']
		]);
		expect(splits(t.id)).toEqual({ 'Mijn deel': -2000, Voorgeschoten: -4000 });
		// Idempotent
		generateMonth(db, '2026-10');
		expect(sharePosts()).toHaveLength(2);
	});

	it('een aandeel erbij terwijl de verwachte post er al is', () => {
		generateMonth(db, '2026-10');
		share(sanne);
		expect(postOf(sanne, '2026-10')?.amountCents).toBe(2000);
		expect(splits(expected('2026-10').id)).toEqual({ 'Mijn deel': -4000, Voorgeschoten: -2000 });
	});

	it('budget netto: alleen jouw deel telt, gepland en uitgegeven', () => {
		share(sanne);
		share(tim);
		generateMonth(db, '2026-10');
		const internet = cat('Internet en telefoon');
		expect(plannedByCategory(db, '2026-10').get(internet)?.plannedCents).toBe(2000);
		expect(spent('2026-10', 'Internet en telefoon')).toBe(0);
		confirmExpected(db, expected('2026-10').id, undefined, '2026-10-01');
		expect(spent('2026-10', 'Internet en telefoon')).toBe(2000);
		expect(plannedByCategory(db, '2026-10').get(internet)).toMatchObject({
			plannedCents: 2000,
			plannedSpentCents: 2000
		});
		// Het saldo van Terugbetaling is wat er nog openstaat
		expect(spent('2026-10', 'Terugbetaling')).toBe(4000);
		confirmReceived(db, postOf(sanne, '2026-10')!.id, '2026-10-28');
		expect(spent('2026-10', 'Terugbetaling')).toBe(2000);
		// De transactielijst houdt het bruto bedrag
		expect(expected('2026-10').amountCents).toBe(-6000);
	});

	it('een percentage wordt herberekend als je het echte bedrag bevestigt; vast blijft staan', () => {
		share(sanne, { kind: 'percentage', amountCents: null, basisPoints: 2500 });
		share(tim);
		generateMonth(db, '2026-10');
		expect(postOf(sanne, '2026-10')?.amountCents).toBe(1500);
		confirmExpected(db, expected('2026-10').id, 8001, '2026-10-01');
		expect(postOf(sanne, '2026-10')?.amountCents).toBe(2000);
		expect(postOf(tim, '2026-10')?.amountCents).toBe(2000);
		expect(splits(expected('2026-10').id)).toEqual({ 'Mijn deel': -4001, Voorgeschoten: -4000 });
	});

	it('een ander bedrag via de transactie rekent de aandelen ook opnieuw uit', () => {
		share(sanne, { kind: 'percentage', amountCents: null, basisPoints: 5000 });
		generateMonth(db, '2026-10');
		const t = expected('2026-10');
		confirmExpected(db, t.id, undefined, '2026-10-01');
		updateTransaction(db, t.id, { amountCents: -7000 }, '2026-10-02');
		expect(postOf(sanne, '2026-10')?.amountCents).toBe(3500);
		expect(splits(t.id)).toEqual({ 'Mijn deel': -3500, Voorgeschoten: -3500 });
		// Zelf als voorgeschoten verdelen kan niet over de aandelen heen
		expect(() => applyShare(db, t.id, { personIds: [tim] })).toThrow(ValidationError);
	});

	it('uitgesmeerd: alleen jouw deel wordt gereserveerd', () => {
		db.update(recurring)
			.set({ interval: 'kwartaal', spread: true, nextDate: '2026-12-01', medianCents: 9000 })
			.where(eq(recurring.id, ziggo))
			.run();
		share(sanne, { amountCents: 3000 });
		generateMonth(db, '2026-10');
		const res = db.select().from(reservations).where(eq(reservations.recurringId, ziggo)).get();
		// (9000 − 3000) / 3 maanden
		expect(res?.amountCents).toBe(2000);
		expect(reserveStatuses(db, '2026-10')[0]?.expectedCents).toBe(6000);
	});

	it('overzicht vaste lasten toont bruto en jouw deel', () => {
		share(sanne);
		const item = recurringOverview(db, '2026-10-01').active.find((r) => r.id === ziggo)!;
		expect([item.medianCents, item.mineCents]).toEqual([6000, 4000]);
		expect(listShares(db, ziggo, '2026-10-01').mineCents).toBe(4000);
	});
});

describe('ontvangen en koppelen', () => {
	beforeEach(() => {
		share(sanne);
		share(tim);
		generateMonth(db, '2026-10');
	});

	it('één tik ontvangen boekt een inkomende transactie in Terugbetaling', () => {
		expect(dueReceipts(db, '2026-10-27')).toEqual([]);
		expect(dueReceipts(db, '2026-10-28').map((r) => r.personName)).toEqual(['Sanne', 'Tim']);
		const id = confirmReceived(db, postOf(sanne, '2026-10')!.id, '2026-10-28');
		const t = db.select().from(transactions).where(eq(transactions.id, id)).get()!;
		expect([t.amountCents, t.categoryId, t.date, t.source]).toEqual([
			2000,
			cat('Terugbetaling'),
			'2026-10-28',
			'handmatig'
		]);
		expect(postOf(sanne, '2026-10')?.status).toBe('betaald');
		expect(() => confirmReceived(db, postOf(sanne, '2026-10')!.id, '2026-10-28')).toThrow(
			/niet open/
		);
	});

	it('een import koppelt een overboeking automatisch, met audit-log', () => {
		const summary = importRecords(db, [record({})], 'csv');
		expect([summary.newCount, summary.linkedCount]).toEqual([1, 1]);
		expect(postOf(sanne, '2026-10')?.status).toBe('betaald');
		const t = db.select().from(transactions).where(eq(transactions.counterIban, IBAN_SANNE)).get()!;
		expect(t.categoryId).toBe(cat('Terugbetaling'));
		const audit = db.select().from(auditLog).where(eq(auditLog.action, 'auto_gekoppeld')).all();
		expect(audit.map((a) => a.entityId)).toEqual([t.id]);
		// Geen IBAN in het audit-log
		expect(JSON.stringify(audit)).not.toContain(IBAN_SANNE);
		// Ongedaan maken met één tik: loskoppelen
		unlinkPayment(db, t.id);
		expect(postOf(sanne, '2026-10')?.status).toBe('open');
	});

	it('ontdubbelt tegen een al met één tik bevestigde ontvangst', () => {
		const tapped = confirmReceived(db, postOf(sanne, '2026-10')!.id, '2026-10-28');
		const file = [record({ date: '2026-10-26', bankReference: 'REF-SANNE-OKT' })];
		const first = importRecords(db, file, 'camt053');
		expect([first.newCount, first.duplicateCount, first.linkedCount]).toEqual([0, 1, 0]);
		const incoming = db
			.select()
			.from(transactions)
			.where(sql`${transactions.amountCents} > 0`)
			.all();
		expect(incoming).toHaveLength(1);
		expect(incoming[0]).toMatchObject({
			id: tapped,
			date: '2026-10-26',
			bankReference: 'REF-SANNE-OKT',
			counterIban: IBAN_SANNE,
			source: 'import'
		});
		expect(postOf(sanne, '2026-10')?.status).toBe('betaald');
		const audit = db.select().from(auditLog).where(eq(auditLog.action, 'ontdubbeld')).all();
		expect(audit.map((a) => a.entityId)).toEqual([tapped]);
		expect(JSON.stringify(audit)).not.toContain(IBAN_SANNE);
		// Dezelfde export nog een keer: niets dubbel
		const again = importRecords(db, file, 'camt053');
		expect([again.newCount, again.duplicateCount]).toEqual([0, 1]);
		expect(
			db
				.select()
				.from(transactions)
				.where(sql`${transactions.amountCents} > 0`)
				.all()
		).toHaveLength(1);
	});

	it('geen automatische koppeling bij een ander bedrag of een onbekende IBAN', () => {
		const summary = importRecords(
			db,
			[record({ amountCents: 1500 }), record({ counterIban: IBAN_TIM, description: 'Tim' })],
			'csv'
		);
		expect([summary.newCount, summary.linkedCount]).toEqual([2, 0]);
		expect(postOf(sanne, '2026-10')?.status).toBe('open');
	});

	it('minder wordt deels, meer wordt tegoed dat naar de volgende post gaat', () => {
		const pay = (cents: number, date: string) =>
			db
				.insert(transactions)
				.values({ amountCents: cents, date, accountId: sns, source: 'handmatig' })
				.returning()
				.get().id;
		settlePayment(db, pay(1500, '2026-10-28'), { personId: sanne });
		expect(postOf(sanne, '2026-10')?.status).toBe('deels');
		settlePayment(db, pay(2500, '2026-10-29'), { personId: sanne });
		expect(postOf(sanne, '2026-10')?.status).toBe('betaald');
		expect(credit(sanne)).toBe(2000);
		// De volgende maand: het tegoed dekt de nieuwe post
		toNovember();
		expect(postOf(sanne, '2026-11')?.status).toBe('betaald');
		expect(credit(sanne)).toBe(0);
	});

	it('een overboeking voor de post er is (op de 28e voor de 1e) telt voor de volgende maand', () => {
		// Oktober en alvast november, voordat de post van november er is
		const summary = importRecords(
			db,
			[
				record({ date: '2026-10-27', bankReference: 'OKT' }),
				record({ date: '2026-10-30', bankReference: 'NOV' })
			],
			'csv'
		);
		expect(summary.linkedCount).toBe(2);
		expect(postOf(sanne, '2026-10')?.status).toBe('betaald');
		expect(credit(sanne)).toBe(2000);
		toNovember();
		expect(postOf(sanne, '2026-11')?.status).toBe('betaald');
		expect(credit(sanne)).toBe(0);
	});

	it('dubbel betaald: tegoed, en desgewenst een post te betalen', () => {
		confirmReceived(db, postOf(sanne, '2026-10')!.id, '2026-10-28');
		const extra = db
			.insert(transactions)
			.values({ amountCents: 2000, date: '2026-10-29', accountId: sns, source: 'handmatig' })
			.returning()
			.get().id;
		settlePayment(db, extra, { personId: sanne });
		expect(credit(sanne)).toBe(2000);
		expect(sharesOverview(db, '2026-10-29').creditCents).toBe(2000);
		creditToPayable(db, sanne, '2026-10-29');
		expect(credit(sanne)).toBe(0);
		const payable = db.select().from(owed).where(eq(owed.direction, 'te_betalen')).get()!;
		expect([payable.personId, payable.amountCents, payable.status]).toEqual([sanne, 2000, 'open']);
	});

	it('kwijtschelden: het deel gaat in de oorspronkelijke maand naar de categorie', () => {
		const t = expected('2026-10');
		confirmExpected(db, t.id, undefined, '2026-10-01');
		forgiveOwed(db, postOf(tim, '2026-10')!.id);
		expect(spent('2026-10', 'Internet en telefoon')).toBe(4000);
		// Herberekenen houdt het kwijtschelden vast
		updateTransaction(db, t.id, { note: 'wifi' }, '2026-11-02');
		expect(spent('2026-10', 'Internet en telefoon')).toBe(4000);
		forgiveOwed(db, postOf(tim, '2026-10')!.id, true);
		expect(spent('2026-10', 'Internet en telefoon')).toBe(2000);
	});
});

describe('randgevallen', () => {
	it('last gemist: geen posten, een betaling die al binnen was wordt tegoed', () => {
		share(sanne);
		generateMonth(db, '2026-10');
		confirmReceived(db, postOf(sanne, '2026-10')!.id, '2026-10-28');
		skipExpected(db, expected('2026-10').id, 'gemist', '2026-10-29');
		expect(sharePosts()).toEqual([]);
		expect(credit(sanne)).toBe(2000);
	});

	it('last gestopt of afschrijving verwijderd: posten vervallen', () => {
		share(sanne);
		generateMonth(db, '2026-10');
		deleteTransaction(db, expected('2026-10').id);
		expect(sharePosts()).toEqual([]);
		generateMonth(db, '2026-11');
		expect(sharePosts()).toHaveLength(1);
		stopRecurring(db, ziggo, '2026-11-02');
		expect(sharePosts()).toEqual([]);
	});

	it('huisgenoot vertrekt: geen nieuwe posten, jouw deel stijgt, openstaande blijven', () => {
		const id = share(sanne);
		share(tim);
		generateMonth(db, '2026-10');
		updateShare(db, id, { endMonth: '2026-10' });
		expect(postOf(sanne, '2026-10')?.status).toBe('open');
		toNovember();
		expect(postOf(sanne, '2026-11')).toBeUndefined();
		expect(splits(expected('2026-11').id)).toEqual({ 'Mijn deel': -4000, Voorgeschoten: -2000 });
		// Een latere overboeking wordt tegoed (na de open post van oktober)
		importRecords(db, [record({ date: '2026-11-27', amountCents: 4000 })], 'csv');
		expect(postOf(sanne, '2026-10')?.status).toBe('open');
		const late = record({ date: '2026-11-28', bankReference: 'LAAT' });
		importRecords(db, [late], 'csv');
		expect(postOf(sanne, '2026-10')?.status).toBe('betaald');
	});

	it('een ander bedrag vanaf een maand: oude maanden blijven zoals ze waren', () => {
		const id = share(sanne);
		generateMonth(db, '2026-10');
		changeShareAmount(db, id, { amountCents: 2200 }, '2026-11', '2026-10-15');
		toNovember();
		expect(postOf(sanne, '2026-10')?.amountCents).toBe(2000);
		expect(postOf(sanne, '2026-11')?.amountCents).toBe(2200);
		const rows = db.select().from(recurringShares).all();
		expect(rows.map((r) => [r.amountCents, r.startMonth, r.endMonth])).toEqual([
			[2000, '2026-10', '2026-10'],
			[2200, '2026-11', null]
		]);
	});

	it('goedkoper dan de vaste aandelen samen: weigeren, jouw deel kan niet onder nul', () => {
		share(sanne);
		share(tim);
		generateMonth(db, '2026-10');
		expect(() => confirmExpected(db, expected('2026-10').id, 3500, '2026-10-01')).toThrow(
			/lager dan wat de anderen nog moeten/
		);
		expect(expected('2026-10').status).toBe('verwacht');
		confirmExpected(db, expected('2026-10').id, 4000, '2026-10-01');
		expect(splits(expected('2026-10').id)).toEqual({ 'Mijn deel': 0, Voorgeschoten: -4000 });
	});

	it('een ingehaalde afschrijving krijgt ook zijn posten', () => {
		share(sanne);
		generateMonth(db, '2026-10');
		// Oktober niet bevestigd; november wordt ingehaald
		generateMonth(db, '2026-11');
		expect(sharePosts().map((p) => [p.month, p.personId])).toEqual([
			['2026-10', sanne],
			['2026-11', sanne]
		]);
		expect(splits(expected('2026-11').id)).toEqual({ 'Mijn deel': -4000, Voorgeschoten: -2000 });
	});

	it('aandelen samen niet meer dan de last', () => {
		share(sanne, { amountCents: 4000 });
		expect(() => share(tim, { amountCents: 2001 })).toThrow(/meer dan het bedrag/);
		expect(() => share(sanne, { startMonth: '2026-12' })).toThrow(/al een aandeel/);
	});

	it('een aandeel verwijderen: posten vervallen, betaald wordt tegoed', () => {
		const id = share(sanne);
		generateMonth(db, '2026-10');
		confirmReceived(db, postOf(sanne, '2026-10')!.id, '2026-10-28');
		deleteShare(db, id);
		expect(sharePosts()).toEqual([]);
		expect(credit(sanne)).toBe(2000);
		expect(splits(expected('2026-10').id)).toEqual({});
	});
});

describe('terugwerkend en voorstellen', () => {
	function historic() {
		db.insert(transactions)
			.values([
				...['2026-07-01', '2026-08-01', '2026-09-01'].map((date) => ({
					amountCents: -6000,
					date,
					counterparty: 'Ziggo',
					counterIban: IBAN_ZIGGO,
					accountId: sns,
					source: 'import' as const
				})),
				...['2026-06-28', '2026-07-28', '2026-08-28', '2026-09-28'].map((date) => ({
					amountCents: 2000,
					date,
					counterparty: 'T BAKKER',
					counterIban: IBAN_TIM,
					accountId: sns,
					source: 'import' as const
				}))
			])
			.run();
	}

	it('startmaand in het verleden: posten vanaf die maand en de historie één keer gekoppeld', () => {
		historic();
		addIban(db, tim, IBAN_TIM);
		generateMonth(db, '2026-10');
		share(tim, { startMonth: '2026-08' }, '2026-10-05');
		expect(sharePosts().map((p) => [p.month, p.status])).toEqual([
			['2026-08', 'betaald'],
			['2026-09', 'betaald'],
			['2026-10', 'betaald']
		]);
		// De overboeking van juli (28 juli voor augustus) dekt augustus; die van 28 september oktober
		const debits = db.select().from(transactions).where(eq(transactions.recurringId, ziggo)).all();
		expect(debits.map((d) => d.date).sort()).toEqual(['2026-08-01', '2026-09-01', '2026-10-01']);
		expect(spent('2026-09', 'Internet en telefoon')).toBe(0);
		expect(splits(debits.find((d) => d.date === '2026-09-01')!.id)).toEqual({
			'Mijn deel': -4000,
			Voorgeschoten: -2000
		});
	});

	it('voorstel uit de historie, bevestigen met een nieuwe persoon en afwijzen', () => {
		historic();
		const [p] = shareProposals(db, '2026-10-05');
		expect(p).toMatchObject({
			recurringId: ziggo,
			recurringName: 'Ziggo',
			counterparty: 'T BAKKER',
			personId: null,
			amountCents: 2000,
			receiveDay: 28,
			startMonth: '2026-06'
		});
		// Geen IBAN naar de browser
		expect(JSON.stringify(p)).not.toContain(IBAN_TIM);

		dismissProposal(db, p!.key, '2026-10-05');
		expect(shareProposals(db, '2026-10-05')).toEqual([]);
	});

	it('voorstel bevestigen: IBAN bij de persoon, aandeel terugwerkend', () => {
		historic();
		const [p] = shareProposals(db, '2026-10-05');
		acceptProposal(
			db,
			{
				key: p!.key,
				recurringId: ziggo,
				newName: 'Tim Bakker',
				amountCents: 2000,
				receiveDay: 28,
				startMonth: '2026-08'
			},
			'2026-10-05'
		);
		const person = sharesOverview(db, '2026-10-05').persons[0]!;
		expect(person.name).toBe('Tim Bakker');
		// Mei tot en met oktober; oktober heeft nog geen afschrijving
		expect(person.boxes.map((b) => b.state)).toEqual([
			'geen',
			'geen',
			'geen',
			'binnen',
			'binnen',
			'geen'
		]);
		expect(shareProposals(db, '2026-10-05')).toEqual([]);
	});
});

describe('IBAN later koppelen', () => {
	/** Tim deelt sinds augustus, maar zonder IBAN koppelde de import zijn overboekingen niet. */
	function withoutIban(payments: [string, number][]) {
		const ids = db
			.insert(transactions)
			.values([
				...['2026-07-01', '2026-08-01', '2026-09-01'].map((date) => ({
					amountCents: -6000,
					date,
					counterparty: 'Ziggo',
					counterIban: IBAN_ZIGGO,
					accountId: sns,
					source: 'import' as const
				})),
				...payments.map(([date, amountCents]) => ({
					amountCents,
					date,
					counterparty: 'T BAKKER',
					counterIban: IBAN_TIM,
					accountId: sns,
					source: 'import' as const
				}))
			])
			.returning({ id: transactions.id, date: transactions.date })
			.all();
		generateMonth(db, '2026-10');
		share(tim, { startMonth: '2026-08' }, '2026-10-05');
		expect(sharePosts().map((p) => p.status)).toEqual(['open', 'open', 'open']);
		return (date: string) => ids.find((t) => t.date === date)!.id;
	}

	const linksOf = (transactionId: string) =>
		db
			.select({ owedId: owedPayments.owedId, amountCents: owedPayments.amountCents })
			.from(owedPayments)
			.where(eq(owedPayments.transactionId, transactionId))
			.all();

	it('koppelt de oude overboekingen oudste eerst; een afwijkend bedrag blijft los', () => {
		const tx = withoutIban([
			['2026-06-28', 2000],
			['2026-07-28', 2000],
			['2026-08-28', 2000],
			['2026-09-15', 1234],
			['2026-09-28', 2000]
		]);
		expect(addIban(db, tim, IBAN_TIM, '2026-10-05')).toEqual({ linked: 3, unmatched: 1 });
		expect(sharePosts().map((p) => [p.month, p.status])).toEqual([
			['2026-08', 'betaald'],
			['2026-09', 'betaald'],
			['2026-10', 'betaald']
		]);
		expect(linksOf(tx('2026-07-28'))).toEqual([
			{ owedId: postOf(tim, '2026-08')!.id, amountCents: 2000 }
		]);
		expect(linksOf(tx('2026-08-28'))).toEqual([
			{ owedId: postOf(tim, '2026-09')!.id, amountCents: 2000 }
		]);
		expect(linksOf(tx('2026-09-28'))).toEqual([
			{ owedId: postOf(tim, '2026-10')!.id, amountCents: 2000 }
		]);
		// Het afwijkende bedrag blijft voor de koppellijst; juni ligt voor de oudste open post
		expect(linksOf(tx('2026-09-15'))).toEqual([]);
		expect(linksOf(tx('2026-06-28'))).toEqual([]);

		const audit = db.select().from(auditLog).where(eq(auditLog.action, 'auto_gekoppeld')).all();
		expect(audit.map((a) => a.entityId).sort()).toEqual(
			[tx('2026-07-28'), tx('2026-08-28'), tx('2026-09-28')].sort()
		);
		// Geen IBAN in het audit-log
		const all = db.select().from(auditLog).all();
		expect(JSON.stringify(all)).not.toContain(IBAN_TIM);
		// Ongedaan maken met één tik: loskoppelen
		unlinkPayment(db, tx('2026-09-28'));
		expect(postOf(tim, '2026-10')?.status).toBe('open');
	});

	it("al gekoppelde transacties, storno's en dubbele ontvangsten blijven ongemoeid", () => {
		const tx = withoutIban([
			['2026-07-28', 2000],
			['2026-08-30', 2000],
			['2026-09-10', 2000],
			['2026-09-28', 2000]
		]);
		// Oktober zelf gekoppeld; september met één tik bevestigd, terwijl de bank die al had
		settlePayment(db, tx('2026-09-28'), { owedId: postOf(tim, '2026-10')!.id });
		const tapped = confirmReceived(db, postOf(tim, '2026-09')!.id, '2026-09-01');
		// Een storno staat op te controleren tot hij aan het origineel gekoppeld is
		db.update(transactions)
			.set({ status: 'te_controleren' })
			.where(eq(transactions.id, tx('2026-09-10')))
			.run();
		const before = linksOf(tx('2026-09-28'));

		// De overboeking van 30 augustus lijkt de bevestigde ontvangst en telt niet dubbel
		expect(addIban(db, tim, IBAN_TIM, '2026-10-05')).toEqual({ linked: 1, unmatched: 1 });
		expect(linksOf(tx('2026-07-28'))).toEqual([
			{ owedId: postOf(tim, '2026-08')!.id, amountCents: 2000 }
		]);
		expect(linksOf(tx('2026-08-30'))).toEqual([]);
		expect(linksOf(tx('2026-09-10'))).toEqual([]);
		expect(linksOf(tapped)).toEqual([{ owedId: postOf(tim, '2026-09')!.id, amountCents: 2000 }]);
		expect(linksOf(tx('2026-09-28'))).toEqual(before);
		expect(sharePosts().map((p) => p.status)).toEqual(['betaald', 'betaald', 'betaald']);
		expect(credit(tim)).toBe(0);
	});

	it('een IBAN van iemand anders of een eigen rekening wordt geweigerd en koppelt niets', () => {
		withoutIban([['2026-09-28', 2000]]);
		db.update(accounts).set({ iban: IBAN_OWN }).where(eq(accounts.id, sns)).run();
		expect(() => addIban(db, tim, IBAN_SANNE, '2026-10-05')).toThrow(/iemand anders/);
		expect(() => addIban(db, tim, IBAN_OWN, '2026-10-05')).toThrow(/eigen rekening/);
		expect(db.select().from(owedPayments).all()).toEqual([]);
		expect(sharePosts().map((p) => p.status)).toEqual(['open', 'open', 'open']);

		expect(addIban(db, tim, IBAN_TIM, '2026-10-05')).toEqual({ linked: 1, unmatched: 0 });
		// Hetzelfde IBAN nog een keer: niets nieuws
		expect(addIban(db, tim, IBAN_TIM, '2026-10-05')).toEqual({ linked: 0, unmatched: 0 });
	});

	it('zonder open posten: een recente overboeking van het maandaandeel wordt tegoed', () => {
		db.insert(transactions)
			.values(
				['2026-08-28', '2026-09-28'].map((date) => ({
					amountCents: 2000,
					date,
					counterparty: 'T BAKKER',
					counterIban: IBAN_TIM,
					accountId: sns,
					source: 'import' as const
				}))
			)
			.run();
		share(tim, {}, '2026-10-01');
		expect(sharePosts()).toEqual([]);
		// Alleen vanaf 15 dagen voor vandaag; de oudere overboeking blijft buiten beschouwing
		expect(addIban(db, tim, IBAN_TIM, '2026-10-05')).toEqual({ linked: 1, unmatched: 0 });
		expect(credit(tim)).toBe(2000);
	});
});

describe('overzicht Terugbetalingen', () => {
	it('achterstand, tegoed en vakjes per maand', () => {
		share(sanne, { receiveDay: 1 });
		share(tim, { receiveDay: 1 });
		generateMonth(db, '2026-10');
		confirmReceived(db, postOf(sanne, '2026-10')!.id, '2026-10-02');
		const o = sharesOverview(db, '2026-10-20');
		expect(o.arrearsCents).toBe(2000);
		const byName = Object.fromEntries(o.persons.map((p) => [p.name, p]));
		expect(byName.Sanne?.boxes.at(-1)?.state).toBe('binnen');
		expect(byName.Tim?.boxes.at(-1)?.state).toBe('te_laat');
		expect(byName.Tim).toMatchObject({ expectedCents: 2000, receivedCents: 0, arrearsCents: 2000 });
		expect(o.lasts).toEqual([
			expect.objectContaining({ counterparty: 'Ziggo', grossCents: 6000, mineCents: 2000 })
		]);
		// Wie achterloopt staat bovenaan
		expect(o.persons[0]?.name).toBe('Tim');
	});
});

describe('migratie 0008: aandelen', () => {
	function statements(file: string): string[] {
		return readFileSync(`drizzle/${file}`, 'utf8')
			.split('--> statement-breakpoint')
			.map((s) => s.trim())
			.filter(Boolean);
	}

	it('bestaande posten en betalingen blijven gekoppeld', () => {
		const sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		for (const f of [
			'0000_init.sql',
			'0001_regelbron.sql',
			'0002_saldocheck.sql',
			'0003_pushmeldingen.sql',
			'0004_vaste_lasten.sql',
			'0005_te_krijgen.sql',
			'0006_reservering_categorie.sql',
			'0007_terugboekingen.sql'
		])
			sqlite.transaction(() => statements(f).forEach((s) => sqlite.exec(s)))();
		sqlite.exec(`
			INSERT INTO accounts (id, name, kind, alias) VALUES ('a', 'SNS', 'sns', 'sns');
			INSERT INTO people (id, name) VALUES ('p', 'Sanne');
			INSERT INTO transactions (id, amount_cents, date, account_id, source) VALUES
				('t', 1500, '2026-09-03', 'a', 'handmatig');
			INSERT INTO owed (id, person_id, amount_cents, direction, date) VALUES
				('o', 'p', 1500, 'te_krijgen', '2026-09-01');
			INSERT INTO owed_payments (id, transaction_id, person_id, owed_id, amount_cents) VALUES
				('x', 't', 'p', 'o', 1500);
		`);
		// Zoals de migrator: alles in één transactie, met foreign keys aan
		sqlite.transaction(() => {
			for (const s of statements('0008_gedeelde_vaste_lasten.sql')) sqlite.exec(s);
		})();
		expect(sqlite.prepare('SELECT owed_id FROM owed_payments').all()).toEqual([{ owed_id: 'o' }]);
		expect(sqlite.prepare('SELECT share_id, month FROM owed').all()).toEqual([
			{ share_id: null, month: null }
		]);
		expect(() => sqlite.exec(`UPDATE owed SET month = '2026-09'`)).toThrow(/owed_share_month/);
		expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
		sqlite.close();
	});
});
