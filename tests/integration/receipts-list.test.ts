// Een screenshot van een bankapp met meerdere transacties (spec: Verwerking stap 6), met een
// nagebootste Haiku: nooit een echte API-aanroep. Van lezen via de controles naar een lijst die
// nooit stil boekt, bevestigen in één keer met de koppellijst per regel, en een latere bankimport
// die de geboekte regels samenvoegt. Verzonnen namen en bedragen; alleen test-IBANs.
import type Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, toIsoDate } from '../../src/lib/dates.ts';
import { resetConfig } from '../../src/lib/server/config.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import { accounts, receiptItems, receipts, transactions } from '../../src/lib/server/db/schema.ts';
import { ValidationError } from '../../src/lib/server/errors.ts';
import { importRecords } from '../../src/lib/server/import/importer.ts';
import { mergeImported } from '../../src/lib/server/import/koppellijst.ts';
import type { ImportRecord } from '../../src/lib/server/import/types.ts';
import { unregisterJob } from '../../src/lib/server/jobs.ts';
import {
	field,
	listItem,
	listOutput,
	receiptOutput
} from '../../src/lib/server/receipts/fixtures.ts';
import {
	confirmList,
	defaultListAccount,
	listWithMatches,
	loadListItems,
	type ListChoice
} from '../../src/lib/server/receipts/list.ts';
import {
	confirmReceipt,
	correctReceipt,
	deleteReceipt,
	loadReceipt,
	rereadReceipt,
	settleReceipt
} from '../../src/lib/server/receipts/process.ts';
import type { ReceiptClient } from '../../src/lib/server/receipts/reader.ts';
import type { ReceiptOutput } from '../../src/lib/server/receipts/schema.ts';
import { READ_RECEIPT_JOB, storeReceipt } from '../../src/lib/server/receipts/store.ts';
import { readStoredReceipt } from '../../src/lib/server/receipts/worker.ts';
import { reviewInbox } from '../../src/lib/server/review.ts';
import type { TelemetryDB } from '../../src/lib/server/telemetry/db.ts';
import { receiptReads } from '../../src/lib/server/telemetry/schema.ts';
import { tempDatabase, tempTelemetry } from './helpers.ts';

const pushed = vi.hoisted(() => [] as { kind: string; message: Record<string, unknown> }[]);
vi.mock('../../src/lib/server/push/notify.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/lib/server/push/notify.ts')>();
	return {
		...actual,
		notify: async (kind: string, message: Record<string, unknown>) => {
			pushed.push({ kind, message });
			return { status: 'verstuurd', sent: 1 };
		}
	};
});

const IBAN_OWN = 'NL12SNSB0123456789';

let dir: string;
let db: DB;
let telemetry: TelemetryDB;
let cleanups: (() => void)[];
let photo: Buffer;

const today = () => toIsoDate(new Date());
const daysAgo = (n: number) => addDays(today(), -n);

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'budget-bonlijst-'));
	process.env.RECEIPTS_DIR = dir;
	resetConfig();
	photo = await sharp({ create: { width: 90, height: 190, channels: 3, background: '#fff' } })
		.png()
		.toBuffer();
});
afterAll(() => {
	delete process.env.RECEIPTS_DIR;
	resetConfig();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	const main = tempDatabase();
	const t = tempTelemetry();
	db = main.db;
	telemetry = t.telemetry;
	cleanups = [main.cleanup, t.cleanup];
	pushed.length = 0;
});
afterEach(() => {
	unregisterJob(READ_RECEIPT_JOB);
	cleanups.forEach((c) => c());
});

function message(output: ReceiptOutput): Anthropic.Message {
	return {
		id: 'msg_test',
		type: 'message',
		role: 'assistant',
		model: 'claude-haiku-5-5',
		content: [{ type: 'text', text: JSON.stringify(output), citations: null }],
		stop_reason: 'end_turn',
		stop_sequence: null,
		usage: { input_tokens: 2500, output_tokens: 600 }
	} as unknown as Anthropic.Message;
}

function fakeHaiku(...outputs: ReceiptOutput[]) {
	const create = vi.fn(async () => message(outputs.length > 1 ? outputs.shift()! : outputs[0]!));
	return { client: { messages: { create } } as unknown as ReceiptClient, create };
}

async function upload(): Promise<string> {
	return (await storeReceipt(db, { bytes: photo, mediaType: 'image/png', source: 'deelmenu' })).id;
}

const account = (alias: string) =>
	db.select().from(accounts).where(eq(accounts.alias, alias)).get()!.id;
const tx = (id: string) => db.select().from(transactions).where(eq(transactions.id, id)).get()!;
const allTransactions = () => db.select().from(transactions).all();
const receiptRow = (id: string) => db.select().from(receipts).where(eq(receipts.id, id)).get()!;

/** Een boeking zoals een eerdere bankimport hem maakte. */
function imported(amountCents: number, date: string, counterparty: string): string {
	return db
		.insert(transactions)
		.values({
			amountCents,
			date,
			counterparty,
			accountId: account('sns'),
			source: 'import',
			bankReference: `REF-${randomUUID()}`
		})
		.returning({ id: transactions.id })
		.get().id;
}

/** Vier transacties zoals op een screenshot van de bankapp, van boven naar beneden. */
const screenshot = () =>
	listOutput([
		listItem(daysAgo(1), 'ALBERT HEIJN 1234', '-23.45'),
		listItem(daysAgo(2), 'Werkgever Voorbeeld', '2150.00'),
		listItem(daysAgo(2), 'Koffiebar Voorbeeld', '-6.50', 'USD'),
		listItem(daysAgo(3), 'Bakkerij Voorbeeld', '-3.10')
	]);

async function readList(output = screenshot()): Promise<string> {
	const id = await upload();
	await readStoredReceipt(db, fakeHaiku(output).client, id);
	return id;
}

const choose = (items: { id: string }[], ...targets: (string | null)[]): ListChoice[] =>
	targets.flatMap((t, i) =>
		t === null
			? []
			: [
					{
						itemId: items[i]!.id,
						target:
							t === 'nieuw'
								? { kind: 'nieuw' as const }
								: { kind: 'koppelen' as const, transactionId: t }
					}
				]
	);

describe('een screenshot met transacties lezen', () => {
	it('zet de transacties in een lijst en boekt niets', async () => {
		const { client, create } = fakeHaiku(screenshot());
		const id = await upload();
		const saved = await readStoredReceipt(db, client, id);

		// De ontvangstdatum gaat mee, voor "Vandaag" en datums zonder jaar
		const request = (create.mock.calls[0] as unknown as [Anthropic.MessageCreateParams])[0];
		const texts = (request.messages[0]!.content as Anthropic.ContentBlockParam[]).flatMap((b) =>
			b.type === 'text' ? [b.text] : []
		);
		expect(texts.at(-1)).toContain(`Ontvangen op ${today()}`);

		expect(saved).toMatchObject({ status: 'zeker', stage: 'lijst', transactionId: null });
		expect(saved!.plan).toEqual({ action: 'inbox', reason: 'lijst' });
		expect(receiptRow(id)).toMatchObject({ kind: 'lijst', transactionId: null, handledAt: null });
		expect(allTransactions()).toHaveLength(0);

		const items = loadListItems(db, id);
		expect(
			items.map((i) => [i.position, i.date, i.counterparty, i.amountCents, i.currency])
		).toEqual([
			[0, daysAgo(1), 'ALBERT HEIJN 1234', -2345, 'EUR'],
			[1, daysAgo(2), 'Werkgever Voorbeeld', 215000, 'EUR'],
			[2, daysAgo(2), 'Koffiebar Voorbeeld', -650, 'USD'],
			[3, daysAgo(3), 'Bakkerij Voorbeeld', -310, 'EUR']
		]);
		expect(items.every((i) => i.complete && i.outcome === 'zeker')).toBe(true);

		// In de review-inbox als lijst, met een melding zonder bedragen of namen
		expect(reviewInbox(db).receipts).toEqual([
			expect.objectContaining({ id, stage: 'lijst', items: 4, doubt: [] })
		]);
		expect(pushed).toEqual([
			{
				kind: 'bon',
				message: expect.objectContaining({
					text: 'Een screenshot met transacties is gelezen; bevestig de lijst',
					url: `/bonnen/${id}`
				})
			}
		]);
		expect(pushed[0]!.message).not.toHaveProperty('detail');
		expect(telemetry.select().from(receiptReads).all()).toEqual([
			expect.objectContaining({ receiptId: id, outcome: 'zeker' })
		]);
	});

	it('de slechtste transactie bepaalt de uitkomst; een onvolledige is niet te boeken', async () => {
		const output = screenshot();
		output.transacties[1]!.bedrag = field('', 'onleesbaar', 'Bedrag valt buiten beeld');
		output.transacties[2]!.tegenpartij = field('Koffiebar Voorbeeld', 'twijfel');
		const id = await readList(output);

		expect(receiptRow(id).status).toBe('onzeker');
		const items = listWithMatches(db, id);
		expect(items.map((i) => [i.outcome, i.complete, i.plan.action, i.plan.checked])).toEqual([
			['zeker', true, 'nieuw', true],
			['onzeker', false, 'onvolledig', false],
			['controleren', true, 'nieuw', true],
			['zeker', true, 'nieuw', true]
		]);
		expect(items[1]!.confidence.bedrag).toMatchObject({
			status: 'onzeker',
			note: 'Bedrag valt buiten beeld'
		});
	});

	it('een lijst zonder transacties wacht ook, met niets om aan te vinken', async () => {
		const id = await readList(listOutput([]));
		expect(loadReceipt(db, id)).toMatchObject({ kind: 'lijst', stage: 'lijst', status: 'onzeker' });
		expect(loadListItems(db, id)).toEqual([]);
	});

	it('een gewone bon blijft een bon, zonder lijst', async () => {
		const id = await upload();
		await readStoredReceipt(db, fakeHaiku(receiptOutput({ datum: field(daysAgo(1)) })).client, id);
		expect(receiptRow(id)).toMatchObject({ kind: 'bon', status: 'zeker' });
		expect(receiptRow(id).handledAt).not.toBeNull();
		expect(loadListItems(db, id)).toEqual([]);
		expect(tx(receiptRow(id).transactionId!)).toMatchObject({ source: 'bon', amountCents: -737 });
	});
});

describe('een lijst bevestigen', () => {
	it('koppelt wat er al is, boekt de rest als bon en slaat uitgevinkte over', async () => {
		const bank = imported(-2345, daysAgo(1), 'ALBERT HEIJN 1234 UTRECHT');
		const before = tx(bank);
		const id = await readList();

		const items = listWithMatches(db, id);
		// Een geïmporteerde boeking wint: koppelen in plaats van dubbel boeken
		expect(items[0]!.plan).toEqual({ action: 'koppelen', transactionId: bank, checked: true });
		expect(items.slice(1).map((i) => i.plan)).toEqual([
			{ action: 'nieuw', checked: true },
			{ action: 'nieuw', checked: true },
			{ action: 'nieuw', checked: true }
		]);
		// Vreemde valuta: op Revolut, net als een bon in dollars
		const accountId = defaultListAccount(db, items);
		expect(accountId).toBe(account('rev'));

		const done = confirmList(db, id, choose(items, bank, 'nieuw', 'nieuw', null), account('sns'));
		expect(done).toEqual({ created: 2, linked: 1 });

		// De bankboeking blijft zoals hij was
		expect(tx(bank)).toEqual(before);
		const after = loadListItems(db, id);
		expect(after[0]!.transactionId).toBe(bank);
		expect(after[3]!.transactionId).toBeNull();
		expect(tx(after[1]!.transactionId!)).toMatchObject({
			source: 'bon',
			status: 'bevestigd',
			amountCents: 215000,
			date: daysAgo(2),
			counterparty: 'Werkgever Voorbeeld',
			accountId: account('sns'),
			origAmountCents: null
		});
		expect(tx(after[2]!.transactionId!)).toMatchObject({
			source: 'bon',
			status: 'te_controleren',
			amountCents: 0,
			origAmountCents: -650,
			origCurrency: 'USD'
		});
		expect(allTransactions()).toHaveLength(3);

		// Afgehandeld: de lijst is weg uit de inbox; het dollarbedrag wacht op een eurobedrag
		expect(loadReceipt(db, id)).toMatchObject({ stage: 'klaar' });
		const inbox = reviewInbox(db);
		expect(inbox.receipts).toEqual([]);
		expect(inbox.transactions.map((t) => t.id)).toEqual([after[2]!.transactionId]);
		expect(() => confirmList(db, id, choose(items, 'nieuw'), account('sns'))).toThrow(
			'al bevestigd'
		);
	});

	it('een latere bankimport voegt een geboekte regel samen via de koppellijst', async () => {
		const id = await readList(listOutput([listItem(daysAgo(2), 'Werkgever Voorbeeld', '2150.00')]));
		const [item] = listWithMatches(db, id);
		confirmList(db, id, choose([item!], 'nieuw'), account('sns'));
		const own = loadListItems(db, id)[0]!.transactionId!;

		const record: ImportRecord = {
			accountIban: IBAN_OWN,
			date: daysAgo(2),
			amountCents: 215000,
			counterparty: 'WERKGEVER VOORBEELD BV',
			counterIban: null,
			description: 'Salaris',
			bankReference: 'REF-SALARIS'
		};
		const summary = importRecords(db, [record], 'camt053');
		expect(summary.matched.merged.map((m) => m.id)).toEqual([own]);
		expect(allTransactions()).toHaveLength(1);
		expect(tx(own)).toMatchObject({ source: 'import', bankReference: 'REF-SALARIS' });
		// De regel van het screenshot wijst nog naar dezelfde transactie
		expect(loadListItems(db, id)[0]!.transactionId).toBe(own);
	});

	it('een regel gekoppeld aan een wachtende bankboeking gaat mee bij samenvoegen', async () => {
		const own = db
			.insert(transactions)
			.values({
				amountCents: -4500,
				date: daysAgo(3),
				counterparty: 'Café Voorbeeld',
				accountId: account('sns'),
				source: 'handmatig'
			})
			.returning({ id: transactions.id })
			.get().id;
		// Een fooi erbij: de import twijfelt en zet de boeking op te controleren
		importRecords(
			db,
			[
				{
					accountIban: IBAN_OWN,
					date: daysAgo(3),
					amountCents: -4600,
					counterparty: 'CAFE VOORBEELD',
					counterIban: null,
					description: '',
					bankReference: 'REF-CAFE'
				}
			],
			'camt053'
		);
		const pending = allTransactions().find((t) => t.source === 'import')!;
		expect(pending.status).toBe('te_controleren');

		const id = await readList(listOutput([listItem(daysAgo(3), 'CAFE VOORBEELD', '-46.00')]));
		const [item] = listWithMatches(db, id);
		expect(item!.candidates.map((c) => c.id)).toContain(pending.id);
		confirmList(db, id, choose([item!], pending.id), null);

		mergeImported(db, pending.id, own);
		expect(loadListItems(db, id)[0]!.transactionId).toBe(own);
	});

	it('twee regels die op dezelfde transactie lijken: de tweede kies je zelf', async () => {
		const bank = imported(-2345, daysAgo(1), 'ALBERT HEIJN 1234');
		const id = await readList(
			listOutput([
				listItem(daysAgo(1), 'ALBERT HEIJN 1234', '-23.45'),
				listItem(daysAgo(1), 'ALBERT HEIJN 1234', '-23.45')
			])
		);
		const items = listWithMatches(db, id);
		expect(items.map((i) => i.plan)).toEqual([
			{ action: 'koppelen', transactionId: bank, checked: true },
			{ action: 'kiezen', checked: false }
		]);
		expect(() => confirmList(db, id, choose(items, bank, bank), null)).toThrow(
			'dezelfde transactie'
		);
		// Zelf gekozen: de tweede is een nieuwe uitgave
		expect(confirmList(db, id, choose(items, bank, 'nieuw'), account('sns'))).toEqual({
			created: 1,
			linked: 1
		});
	});

	it('weigert bij twijfel alles en boekt dan niets', async () => {
		const other = imported(-99999, daysAgo(20), 'Iets anders');
		const output = screenshot();
		output.transacties[3]!.bedrag = field('', 'onleesbaar');
		const id = await readList(output);
		const items = listWithMatches(db, id);
		const fail = (choices: ListChoice[], accountId: string | null, message: string) => {
			const call = () => confirmList(db, id, choices, accountId);
			expect(call).toThrow(ValidationError);
			expect(call).toThrow(message);
		};

		fail([], account('sns'), 'minstens één');
		fail(choose(items, other), null, 'past niet');
		fail(choose(items, null, null, null, 'nieuw'), account('sns'), 'niet volledig');
		fail(choose(items, 'nieuw'), null, 'rekening');
		fail(choose(items, 'nieuw'), randomUUID(), 'rekening');
		fail([...choose(items, 'nieuw'), ...choose(items, 'nieuw')], account('sns'), 'hoort niet bij');
		fail([{ itemId: randomUUID(), target: { kind: 'nieuw' } }], account('sns'), 'hoort niet bij');

		expect(allTransactions()).toHaveLength(1);
		expect(receiptRow(id).handledAt).toBeNull();
	});

	it('een bon is geen lijst, en bonacties werken niet op een lijst', async () => {
		const id = await readList();
		const bonId = await upload();
		await readStoredReceipt(
			db,
			fakeHaiku(receiptOutput({ datum: field(daysAgo(1)), totaal: field('', 'onleesbaar') }))
				.client,
			bonId
		);
		expect(() => confirmList(db, bonId, [], null)).toThrow('geen lijst');
		expect(() => settleReceipt(db, id, { kind: 'nieuw', accountId: account('sns') })).toThrow(
			'als lijst'
		);
		expect(() => confirmReceipt(db, id)).toThrow('als lijst');
		expect(() =>
			correctReceipt(db, id, { store: 'X', date: daysAgo(1), totalCents: 100, currency: 'EUR' })
		).toThrow('als lijst');
		expect(allTransactions()).toHaveLength(0);
	});

	it('opnieuw lezen vervangt de lijst; weggooien laat geboekte transacties staan', async () => {
		const id = await readList();
		rereadReceipt(db, id);
		expect(loadReceipt(db, id)).toMatchObject({ stage: 'wordt_gelezen' });
		await readStoredReceipt(
			db,
			fakeHaiku(listOutput([listItem(daysAgo(1), 'Bakkerij Voorbeeld', '-3.10')])).client,
			id
		);
		const items = listWithMatches(db, id);
		expect(items.map((i) => i.counterparty)).toEqual(['Bakkerij Voorbeeld']);

		confirmList(db, id, choose(items, 'nieuw'), account('sns'));
		const made = loadListItems(db, id)[0]!.transactionId!;
		await deleteReceipt(db, id);
		expect(db.select().from(receiptItems).all()).toEqual([]);
		expect(tx(made)).toMatchObject({ source: 'bon', amountCents: -310 });
	});
});
