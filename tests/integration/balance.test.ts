import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handle } from '../../src/hooks.server.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	accounts,
	auditLog,
	balanceAnchors,
	balanceChecks,
	transactions
} from '../../src/lib/server/db/schema.ts';
import { balanceCheckDue, balanceOverview } from '../../src/lib/server/balance.ts';
import { parseBankFile } from '../../src/lib/server/import/index.ts';
import { importRecords } from '../../src/lib/server/import/importer.ts';
import { listTransactions } from '../../src/lib/server/transactions.ts';
import { actions, load } from '../../src/routes/(app)/saldocheck/+page.server.ts';
import { fakeEvent, ORIGIN, tempDatabase } from './helpers.ts';

const TODAY = '2026-10-24';

let db: DB;
let cleanup: () => void;
let sns: string;
let rev: string;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(`${TODAY}T12:00:00`));
	({ db, cleanup } = tempDatabase());
	sns = db.select().from(accounts).where(eq(accounts.kind, 'sns')).get()!.id;
	rev = db.select().from(accounts).where(eq(accounts.kind, 'revolut')).get()!.id;
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function importFile(name: string, from?: string) {
	const { format, records, balances } = parseBankFile(readFileSync(`tests/fixtures/${name}`));
	return importRecords(db, records, format, { from, balances });
}

function anchorOf(accountId: string) {
	return db.select().from(balanceAnchors).where(eq(balanceAnchors.accountId, accountId)).get();
}

function addTx(accountId: string, date: string, amountCents: number, status = 'bevestigd') {
	db.insert(transactions)
		.values({
			accountId,
			date,
			amountCents,
			source: 'handmatig',
			status: status as 'bevestigd'
		})
		.run();
}

async function submit(action: 'check' | 'anchor', fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	const request = new Request(`${ORIGIN}/saldocheck?/${action}`, { method: 'POST', body });
	return actions[action]!({ request } as never);
}

const overview = (accountId: string) =>
	balanceOverview(db, TODAY).find((a) => a.account.id === accountId)!;

describe('startsaldo uit de import', () => {
	it('CAMT: het saldo vlak vóór de eerste boeking wordt het anker', () => {
		const summary = importFile('camt053-v02.xml');
		expect(anchorOf(sns)).toMatchObject({
			date: '2026-09-01',
			amountCents: 100000,
			source: 'import',
			importBatchId: summary.batchId
		});
		expect(summary.anchors).toEqual([
			{ accountName: 'SNS', date: '2026-09-01', amountCents: 100000 }
		]);
		// Verwacht = het eindsaldo van het afschrift
		expect(overview(sns).expectedTodayCents).toBe(215657);
	});

	it('Revolut-CSV: anker in euro op de Revolut-rekening', () => {
		importFile('revolut.csv');
		expect(anchorOf(rev)).toMatchObject({ date: '2026-01-29', amountCents: 0, source: 'import' });
		expect(overview(rev).expectedTodayCents).toBe(37253);
	});

	it('met een begindatum: het saldo op die dag, inclusief wat eerder in het bestand stond', () => {
		const summary = importFile('camt053-v02.xml', '2026-09-26');
		expect(summary.earlierCount).toBe(2);
		expect(anchorOf(sns)).toMatchObject({
			date: '2026-09-25',
			amountCents: 100000 - 2345 + 125000
		});
		expect(overview(sns).expectedTodayCents).toBe(215657);
	});

	it('een latere import verschuift het anker niet', () => {
		importFile('sns.csv');
		const first = anchorOf(sns)!;
		const again = importFile('camt053-v02.xml');
		expect(again.anchors).toEqual([]);
		expect(anchorOf(sns)).toEqual(first);
	});

	it('een zelf ingevuld anker blijft staan bij een import', async () => {
		await submit('anchor', { accountId: sns, date: '2026-08-31', amount: '900' });
		importFile('camt053-v02.xml');
		expect(anchorOf(sns)).toMatchObject({ amountCents: 90000, source: 'handmatig' });
	});
});

describe('saldocheck', () => {
	beforeEach(() => importFile('camt053-v02.xml'));

	it('slaat het echte saldo op en toont het verschil', async () => {
		addTx(sns, '2026-10-05', -1250);
		expect(await submit('check', { accountId: sns, date: TODAY, amount: '2.131,57' })).toEqual({
			saved: 'check',
			accountId: sns
		});
		const [latest] = overview(sns).checks;
		expect(latest).toMatchObject({
			date: TODAY,
			amountCents: 213157,
			expectedCents: 214407,
			differenceCents: -1250,
			period: { from: '2026-09-02', to: TODAY }
		});

		// De vergeten uitgave alsnog invoeren: het verschil verdwijnt
		addTx(sns, '2026-10-12', -1250);
		expect(overview(sns).checks[0]!.differenceCents).toBe(0);
	});

	it('dezelfde dag nog eens overschrijft, met audit-log', async () => {
		await submit('check', { accountId: sns, date: TODAY, amount: '10' });
		await submit('check', { accountId: sns, date: TODAY, amount: '-12,50' });
		const rows = db.select().from(balanceChecks).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.amountCents).toBe(-1250);
		const audit = db.select().from(auditLog).where(eq(auditLog.entity, 'balance_checks')).all();
		expect(audit.map((a) => a.action)).toEqual(['aangemaakt', 'gewijzigd']);
	});

	it('verwachte posten tellen niet mee in het saldo', () => {
		addTx(sns, '2026-10-20', -95000, 'verwacht');
		expect(overview(sns).expectedTodayCents).toBe(215657);
	});

	it.each([
		['bedrag als tekst', { amount: 'veel' }],
		['bedrag met drie decimalen', { amount: '12,345' }],
		['te groot bedrag', { amount: '2.000.000' }],
		['datum in de toekomst', { date: '2026-10-25' }],
		['ongeldige datum', { date: '2026-02-30' }],
		['geen UUID', { accountId: '1' }],
		['leeg bedrag', { amount: '' }]
	])('weigert %s', async (_name, override) => {
		const result = await submit('check', {
			accountId: sns,
			date: TODAY,
			amount: '10',
			...override
		});
		expect(result).toMatchObject({ status: 400 });
		expect(db.select().from(balanceChecks).all()).toHaveLength(0);
	});

	it('weigert onbekende velden en een onbekende rekening', async () => {
		const extra = await submit('check', {
			accountId: sns,
			date: TODAY,
			amount: '10',
			isAdmin: '1'
		});
		expect(extra).toMatchObject({ status: 400 });
		const unknown = await submit('anchor', {
			accountId: crypto.randomUUID(),
			date: TODAY,
			amount: '10'
		});
		expect(unknown).toMatchObject({ status: 404 });
		expect(db.select().from(balanceChecks).all()).toHaveLength(0);
	});

	it('load geeft per rekening het overzicht', () => {
		const data = load({} as never) as { today: string; accounts: { account: { id: string } }[] };
		expect(data.today).toBe(TODAY);
		expect(data.accounts.map((a) => a.account.id)).toEqual([sns, rev]);
	});
});

describe('herinnering', () => {
	it('alleen rekeningen in gebruik zonder check deze maand', async () => {
		expect(balanceCheckDue(db, TODAY)).toEqual([]);
		importFile('camt053-v02.xml');
		expect(balanceCheckDue(db, TODAY).map((a) => a.id)).toEqual([sns]);
		addTx(rev, '2026-10-01', -500);
		expect(balanceCheckDue(db, TODAY).map((a) => a.id)).toEqual([sns, rev]);

		// Een check van vorige maand telt niet, een van deze maand wel
		await submit('check', { accountId: sns, date: '2026-09-30', amount: '1' });
		expect(balanceCheckDue(db, TODAY).map((a) => a.id)).toEqual([sns, rev]);
		await submit('check', { accountId: sns, date: '2026-10-01', amount: '1' });
		expect(balanceCheckDue(db, TODAY).map((a) => a.id)).toEqual([rev]);
	});
});

describe('transacties van één rekening in een periode', () => {
	it('filtert op rekening en datums, beide inclusief', () => {
		importFile('camt053-v02.xml');
		addTx(rev, '2026-09-25', -500);
		const rows = listTransactions(db, { accountId: sns, from: '2026-09-25', to: '2026-09-26' });
		expect(rows.map((r) => [r.date, r.amountCents])).toEqual([
			['2026-09-26', -5000],
			['2026-09-25', 125000]
		]);
	});
});

describe('zonder sessie', () => {
	it.each(['GET', 'POST'])('%s /saldocheck geeft 401', async (method) => {
		const event = fakeEvent({
			path: method === 'POST' ? '/saldocheck?/check' : '/saldocheck',
			routeId: '/(app)/saldocheck',
			method,
			body: method === 'POST' ? {} : undefined
		});
		const response = await handle({
			event,
			resolve: async () => {
				throw new Error('mag niet');
			}
		});
		expect(response.status).toBe(401);
		expect(db.select().from(balanceChecks).all()).toHaveLength(0);
	});
});
