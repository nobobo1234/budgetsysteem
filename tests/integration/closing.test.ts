// Maandafsluiting: afsluiten met een late import, open punten, voorstellen en de melding om 9:00.
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveBalanceCheck } from '../../src/lib/server/balance.ts';
import { setBudget } from '../../src/lib/server/budgets.ts';
import {
	CLOSING_JOB,
	notifyMonthClosing,
	scheduleClosingNotifications
} from '../../src/lib/server/closing-notify.ts';
import {
	applyProposal,
	closeMonth,
	closedMonths,
	closingPage,
	closingSignal,
	getClosing,
	openItems,
	proposalsFor
} from '../../src/lib/server/closing.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	accounts,
	auditLog,
	budgets,
	categories,
	jobs,
	recurring,
	transactions
} from '../../src/lib/server/db/schema.ts';
import { importRecords } from '../../src/lib/server/import/importer.ts';
import { runDueJobs, unregisterJob } from '../../src/lib/server/jobs.ts';
import { markSent, type NotifyMessage } from '../../src/lib/server/push/notify.ts';
import type { Send } from '../../src/lib/server/recurring-notify.ts';
import { ValidationError } from '../../src/lib/server/errors.ts';
import { actions } from '../../src/routes/(app)/afsluiting/[maand]/+page.server.ts';
import { fakeEvent, tempDatabase } from './helpers.ts';

let db: DB;
let cleanup: () => void;
beforeEach(() => ({ db, cleanup } = tempDatabase()));
afterEach(() => {
	unregisterJob(CLOSING_JOB);
	cleanup();
});

const category = (name: string) =>
	db.select().from(categories).where(eq(categories.name, name)).get()!.id;
const account = (alias: string) =>
	db.select().from(accounts).where(eq(accounts.alias, alias)).get()!.id;

function spend(date: string, cents: number, categoryName: string, alias = 'sns') {
	return db
		.insert(transactions)
		.values({
			amountCents: -cents,
			date,
			counterparty: 'Winkel',
			categoryId: category(categoryName),
			accountId: account(alias),
			source: 'handmatig'
		})
		.returning()
		.get().id;
}

/** Een verwachte vaste last op `date`, nog niet bevestigd. */
function expected(date: string) {
	const r = db
		.insert(recurring)
		.values({
			matchKey: `huur-${date}|`,
			counterparty: 'Woonstichting',
			interval: 'maand',
			expectedDay: Number(date.slice(8, 10)),
			medianCents: 90000,
			minCents: 90000,
			maxCents: 90000,
			kind: 'vast',
			nextDate: date,
			categoryId: category('Wonen'),
			accountId: account('sns'),
			status: 'actief'
		})
		.returning()
		.get();
	return db
		.insert(transactions)
		.values({
			amountCents: -90000,
			date,
			counterparty: 'Woonstichting',
			categoryId: category('Wonen'),
			accountId: account('sns'),
			source: 'verwacht',
			status: 'verwacht',
			recurringId: r.id
		})
		.returning()
		.get().id;
}

/** Saldocheck op de laatste dag voor alle rekeningen in gebruik, zodat die geen open punt zijn. */
function checkBalances(date: string) {
	for (const a of db.select().from(accounts).all())
		saveBalanceCheck(db, { accountId: a.id, date, amountCents: 0 });
}

describe('afsluiten', () => {
	beforeEach(() => {
		setBudget(db, '2026-09', category('Boodschappen'), 30000);
		setBudget(db, '2026-09', category('Uit eten en bezorgen'), 10000);
		spend('2026-09-05', 25000, 'Boodschappen');
		spend('2026-09-12', 4000, 'Uit eten en bezorgen');
	});

	it('legt een momentopname vast, met de uitkomst en de open punten', () => {
		const closing = closeMonth(db, '2026-09', '2026-10-03');
		expect(closing.snapshot.outcome).toEqual({ kind: 'over', cents: 40000 - 29000 });
		expect(closing.snapshot.categories.map((c) => [c.name, c.spentCents])).toEqual(
			expect.arrayContaining([
				['Boodschappen', 25000],
				['Uit eten en bezorgen', 4000]
			])
		);
		// Rekening SNS heeft geen saldocheck na 30 september
		expect(closing.openItems.map((o) => o.kind)).toEqual(['saldocheck']);
		// Zonder IBANs of omschrijvingen in de momentopname
		expect(JSON.stringify(closing)).not.toMatch(/NL\d{2}[A-Z]{4}/);
		expect(
			db.select().from(auditLog).where(eq(auditLog.entity, 'month_closings')).all()
		).toHaveLength(1);
		expect(closedMonths(db).map((c) => c.month)).toEqual(['2026-09']);
	});

	it('een lopende maand of een tweede keer afsluiten wordt geweigerd', () => {
		expect(() => closeMonth(db, '2026-10', '2026-10-03')).toThrow(ValidationError);
		closeMonth(db, '2026-09', '2026-10-03');
		expect(() => closeMonth(db, '2026-09', '2026-10-04')).toThrow('al afgesloten');
	});

	it('een late import blijft mogelijk en toont het verschil sinds afsluiten', () => {
		closeMonth(db, '2026-09', '2026-10-03');
		const summary = importRecords(
			db,
			[
				{
					accountIban: '',
					accountKind: 'revolut',
					date: '2026-09-29',
					amountCents: -1200,
					counterparty: 'Bakker',
					counterIban: null,
					description: 'Brood',
					bankReference: 'late-1'
				}
			],
			'revolut'
		);
		expect(summary.newCount).toBe(1);
		// Zet de late boeking bij Boodschappen, zoals een correctie in de interface
		db.update(transactions)
			.set({ categoryId: category('Boodschappen') })
			.where(eq(transactions.bankReference, 'late-1'))
			.run();

		const page = closingPage(db, '2026-09', '2026-10-06');
		expect(page.status).toBe('afgesloten');
		// De momentopname staat; afsluiten veranderde geen bedragen
		expect(page.content.totalSpentCents).toBe(29000);
		expect(page.change).toEqual({
			totalCents: 1200,
			categories: [{ categoryId: category('Boodschappen'), name: 'Boodschappen', diffCents: 1200 }]
		});
		// De open punten van toen blijven bij de afsluiting
		expect(page.openAtClose.map((o) => o.kind)).toEqual(['saldocheck']);
	});

	it('de actie op de pagina sluit af', async () => {
		const result = await actions.close!(
			fakeEvent({
				path: '/afsluiting/2026-09?/close',
				routeId: '/(app)/afsluiting/[maand]',
				method: 'POST',
				params: { maand: '2026-09' }
			}) as never
		);
		expect(result).toEqual({ closed: '2026-09' });
		expect(getClosing(db, '2026-09')).not.toBeNull();
	});
});

describe('open punten', () => {
	it('verwachte posten, inbox en saldocheck uit die maand; weg zodra ze geregeld zijn', () => {
		const post = expected('2026-09-28');
		expected('2026-10-01');
		const review = db
			.insert(transactions)
			.values({
				amountCents: -5000,
				date: '2026-09-14',
				counterparty: 'Storno',
				accountId: account('sns'),
				source: 'import',
				status: 'te_controleren'
			})
			.returning()
			.get().id;

		const items = openItems(db, '2026-09', '2026-10-02');
		expect(items.map((o) => `${o.kind}:${o.id}`)).toEqual([
			`verwacht:${post}`,
			`boeking:${review}`,
			`saldocheck:${account('sns')}`
		]);

		db.update(transactions).set({ status: 'bevestigd' }).where(eq(transactions.id, post)).run();
		db.update(transactions).set({ status: 'bevestigd' }).where(eq(transactions.id, review)).run();
		checkBalances('2026-09-30');
		expect(openItems(db, '2026-09', '2026-10-02')).toEqual([]);
	});

	it('het signaalkaartje staat er tot je afsluit, en niet voor een maand zonder data', () => {
		expect(closingSignal(db, '2026-10-01')).toBeNull();
		spend('2026-09-05', 1000, 'Boodschappen');
		expect(closingSignal(db, '2026-10-01')).toMatchObject({
			month: '2026-09',
			open: 1,
			href: '/afsluiting/2026-09',
			big: 'September',
			small: 'afsluiten, nog 1 open punt'
		});
		closeMonth(db, '2026-09', '2026-10-01');
		expect(closingSignal(db, '2026-10-01')).toBeNull();
	});
});

describe('voorstellen voor de nieuwe maand', () => {
	it('drie maanden over de limiet: één tik zet de limiet van de volgende maand', () => {
		for (const [month, cents] of [
			['2026-07', 34000],
			['2026-08', 32000],
			['2026-09', 33050]
		] as const) {
			setBudget(db, month, category('Boodschappen'), 30000);
			spend(`${month}-10`, cents, 'Boodschappen');
		}
		setBudget(db, '2026-10', category('Boodschappen'), 30000);
		const [p] = proposalsFor(db, '2026-09', '2026-10-02');
		expect(p).toMatchObject({ name: 'Boodschappen', fromCents: 30000, toCents: 33000 });

		expect(applyProposal(db, '2026-09', p!.categoryId, '2026-10-02')).toBe(33000);
		const limit = db
			.select()
			.from(budgets)
			.where(and(eq(budgets.month, '2026-10'), eq(budgets.categoryId, p!.categoryId)))
			.get();
		expect(limit?.limitCents).toBe(33000);
		// Overgenomen: geen voorstel meer, en een tweede tik wordt geweigerd
		expect(proposalsFor(db, '2026-09', '2026-10-02')).toEqual([]);
		expect(() => applyProposal(db, '2026-09', p!.categoryId, '2026-10-02')).toThrow(
			ValidationError
		);
		// De limieten van september zelf blijven zoals ze waren
		expect(
			db
				.select()
				.from(budgets)
				.where(and(eq(budgets.month, '2026-09'), eq(budgets.categoryId, p!.categoryId)))
				.get()?.limitCents
		).toBe(30000);
	});

	it('maanden zonder eigen limieten nemen die van de maand ervoor, zonder ze aan te maken', () => {
		setBudget(db, '2026-07', category('Boodschappen'), 30000);
		for (const month of ['2026-07', '2026-08', '2026-09'])
			spend(`${month}-10`, 10000, 'Boodschappen');
		const [p] = proposalsFor(db, '2026-09', '2026-10-02');
		expect(p).toMatchObject({ reason: 'onder', toCents: 10000 });
		expect(db.select().from(budgets).where(eq(budgets.month, '2026-08')).all()).toEqual([]);
	});

	it('bij een oude afsluiting geen voorstellen meer', () => {
		for (const month of ['2026-04', '2026-05', '2026-06']) {
			setBudget(db, month, category('Boodschappen'), 30000);
			spend(`${month}-10`, 40000, 'Boodschappen');
		}
		expect(proposalsFor(db, '2026-06', '2026-07-02')).toHaveLength(1);
		expect(proposalsFor(db, '2026-06', '2026-10-02')).toEqual([]);
	});
});

describe('melding om 9:00', () => {
	function recorder() {
		const calls: { kind: string; message: NotifyMessage }[] = [];
		const send: Send = async (kind, message) => {
			calls.push({ kind, message });
			markSent(db, kind, [message.key!]);
			return { status: 'verstuurd', sent: 1 };
		};
		return { calls, send };
	}

	beforeEach(() => {
		setBudget(db, '2026-09', category('Boodschappen'), 30000);
		spend('2026-09-05', 25000, 'Boodschappen');
	});

	it('met open punten pas op de 5e, met het aantal en zonder bedragen', async () => {
		expected('2026-09-29');
		const { calls, send } = recorder();
		for (const day of ['01', '02', '03', '04'])
			expect(await notifyMonthClosing(db, new Date(`2026-10-${day}T07:00:00Z`), send)).toBe(false);
		expect(await notifyMonthClosing(db, new Date('2026-10-05T07:00:00Z'), send)).toBe(true);
		expect(calls).toEqual([
			{
				kind: 'maand',
				message: {
					key: 'maand:2026-09',
					text: 'De afsluiting van september staat klaar, met nog 2 open punten.',
					detail: expect.stringMatching(
						/^De afsluiting van september staat klaar, met nog 2 open punten\. Je hield €\s50 over\.$/
					),
					url: '/afsluiting/2026-09'
				}
			}
		]);
		expect(calls[0]!.message.text).not.toMatch(/€|Woonstichting/);
		// Eén per maand
		expect(await notifyMonthClosing(db, new Date('2026-10-06T07:00:00Z'), send)).toBe(false);
		expect(calls).toHaveLength(1);
	});

	it('zodra niets meer openstaat, op de eerste dag om 9:00', async () => {
		checkBalances('2026-09-30');
		const { calls, send } = recorder();
		// 1 oktober 8:59 in Nederland (CEST): nog niet
		expect(await notifyMonthClosing(db, new Date('2026-10-01T06:59:00Z'), send)).toBe(false);
		expect(await notifyMonthClosing(db, new Date('2026-10-01T07:00:00Z'), send)).toBe(true);
		expect(calls[0]!.message.text).toBe('De afsluiting van september staat klaar.');
	});

	it('een al afgesloten maand krijgt geen melding', async () => {
		closeMonth(db, '2026-09', '2026-10-02');
		const { calls, send } = recorder();
		expect(await notifyMonthClosing(db, new Date('2026-10-05T07:00:00Z'), send)).toBe(false);
		expect(calls).toEqual([]);
	});

	it('de taak draait om 9:00 Nederlandse tijd en plant de volgende ochtend in', async () => {
		checkBalances('2026-09-30');
		const { calls, send } = recorder();
		// Gestart op 1 oktober om 1:30 in Nederland (30 september 23:30 UTC)
		scheduleClosingNotifications(db, new Date('2026-09-30T23:30:00Z'), send);
		expect(await runDueJobs(db, new Date('2026-10-01T06:59:00Z'))).toBe(0);
		expect(await runDueJobs(db, new Date('2026-10-01T07:00:10Z'))).toBe(1);
		expect(calls).toHaveLength(1);
		const next = db
			.select()
			.from(jobs)
			.where(and(eq(jobs.kind, CLOSING_JOB), eq(jobs.status, 'wachtend')))
			.all();
		expect(next.map((j) => j.runAt)).toEqual(['2026-10-02T07:00:00.000Z']);
	});
});
