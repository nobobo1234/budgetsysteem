// De taak bon_lezen met een nagebootste Haiku: nooit een echte API-aanroep. Van opgeslagen bon
// via de lezer en de controles naar de uitkomst, de koppellijst, de review-inbox, de
// pushmelding en de telemetrie (spec: Bonnetjes en koppelen, Telemetrie en monitoring).
import type Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, toIsoDate } from '../../src/lib/dates.ts';
import { resetConfig } from '../../src/lib/server/config.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import { accounts, jobs, receipts, transactions } from '../../src/lib/server/db/schema.ts';
import { MAX_ATTEMPTS, runDueJobs, unregisterJob } from '../../src/lib/server/jobs.ts';
import {
	confirmReceipt,
	correctReceipt,
	deleteReceipt,
	loadReceipt,
	receiptCandidates,
	rereadReceipt,
	settleReceipt
} from '../../src/lib/server/receipts/process.ts';
import { field, receiptOutput } from '../../src/lib/server/receipts/fixtures.ts';
import type { ReceiptClient } from '../../src/lib/server/receipts/reader.ts';
import type { ReceiptOutput } from '../../src/lib/server/receipts/schema.ts';
import { READ_RECEIPT_JOB, storeReceipt } from '../../src/lib/server/receipts/store.ts';
import { readStoredReceipt, registerReceiptReader } from '../../src/lib/server/receipts/worker.ts';
import { reviewInbox } from '../../src/lib/server/review.ts';
import type { TelemetryDB } from '../../src/lib/server/telemetry/db.ts';
import { receiptReadSummary } from '../../src/lib/server/telemetry/receipts.ts';
import { receiptReads } from '../../src/lib/server/telemetry/schema.ts';
import { updateTransaction } from '../../src/lib/server/transactions.ts';
import { tempDatabase, tempTelemetry } from './helpers.ts';

// Pushmeldingen vangen in plaats van versturen; de rest van de module blijft echt
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

let dir: string;
let db: DB;
let telemetry: TelemetryDB;
let cleanups: (() => void)[];
let photo: Buffer;

const today = () => toIsoDate(new Date());
const yesterday = () => addDays(today(), -1);

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'budget-bonlezer-'));
	process.env.RECEIPTS_DIR = dir;
	resetConfig();
	photo = await sharp({ create: { width: 60, height: 120, channels: 3, background: '#fff' } })
		.jpeg()
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

function message(
	output: ReceiptOutput | string,
	stop: Anthropic.StopReason = 'end_turn'
): Anthropic.Message {
	return {
		id: 'msg_test',
		type: 'message',
		role: 'assistant',
		model: 'claude-haiku-5-5',
		content: [
			{
				type: 'text',
				text: typeof output === 'string' ? output : JSON.stringify(output),
				citations: null
			}
		],
		stop_reason: stop,
		stop_sequence: null,
		usage: { input_tokens: 2500, output_tokens: 300 }
	} as unknown as Anthropic.Message;
}

/** Nagebootste Haiku: geeft de antwoorden op volgorde, of gooit een fout. */
function fakeHaiku(...responses: (Anthropic.Message | Error)[]) {
	const create = vi.fn(async () => {
		const next = responses.length > 1 ? responses.shift()! : responses[0]!;
		if (next instanceof Error) throw next;
		return next;
	});
	return { client: { messages: { create } } as unknown as ReceiptClient, create };
}

/** Een bon van gisteren bij Supermarkt Voorbeeld van € 7,37, zeker gelezen. */
const sureOutput = (overrides: Partial<ReceiptOutput> = {}) =>
	receiptOutput({ datum: field(yesterday()), ...overrides });

async function upload(): Promise<string> {
	return (await storeReceipt(db, { bytes: photo, mediaType: 'image/jpeg', source: 'app' })).id;
}

function account(alias: string): string {
	return db.select().from(accounts).where(eq(accounts.alias, alias)).get()!.id;
}

function manual(amountCents: number, date: string, counterparty: string): string {
	return db
		.insert(transactions)
		.values({ amountCents, date, counterparty, accountId: account('sns'), source: 'handmatig' })
		.returning({ id: transactions.id })
		.get().id;
}

const receiptRow = (id: string) => db.select().from(receipts).where(eq(receipts.id, id)).get()!;
const tx = (id: string) => db.select().from(transactions).where(eq(transactions.id, id)).get()!;
const bonTransactions = () =>
	db.select().from(transactions).where(eq(transactions.source, 'bon')).all();

describe('bon_lezen als taak', () => {
	it('leest een zekere bon en maakt een transactie met bron bon', async () => {
		const { client, create } = fakeHaiku(message(sureOutput()));
		registerReceiptReader(() => client);
		const id = await upload();

		expect(await runDueJobs(db)).toBe(1);
		expect(create).toHaveBeenCalledOnce();
		// Eén beeld, binnen de grens van 2576 px, als JPEG
		const request = (create.mock.calls[0] as unknown as [Anthropic.MessageCreateParams])[0];
		const images = (request.messages[0]!.content as Anthropic.ContentBlockParam[]).filter(
			(b) => b.type === 'image'
		);
		expect(images).toHaveLength(1);

		const row = receiptRow(id);
		expect(row).toMatchObject({ status: 'zeker', failure: null });
		expect(row.readAt).not.toBeNull();
		expect(row.handledAt).not.toBeNull();
		expect(row.rawAiOutput).toMatchObject({ stopReason: 'end_turn' });
		expect(row.checkedFields).toMatchObject({
			store: 'Supermarkt Voorbeeld 0001',
			date: yesterday(),
			totalCents: 737,
			currency: 'EUR'
		});
		expect(row.fieldConfidence).toMatchObject({ totaal: { status: 'zeker', model: 'zeker' } });

		const made = tx(row.transactionId!);
		expect(made).toMatchObject({
			source: 'bon',
			status: 'bevestigd',
			amountCents: -737,
			date: yesterday(),
			counterparty: 'Supermarkt Voorbeeld 0001',
			accountId: account('sns')
		});
		expect(db.select().from(jobs).where(eq(jobs.kind, READ_RECEIPT_JOB)).get()!.status).toBe(
			'klaar'
		);
		expect(reviewInbox(db).receipts).toEqual([]);
	});

	it('koppelt aan een handmatige invoer als die duidelijk voorloopt, zonder iets dubbel', async () => {
		const own = manual(-737, yesterday(), 'Supermarkt Voorbeeld');
		manual(-2500, addDays(today(), -6), 'Bakker');
		const id = await upload();
		await readStoredReceipt(db, fakeHaiku(message(sureOutput())).client, id);

		expect(receiptRow(id)).toMatchObject({ status: 'zeker', transactionId: own });
		expect(receiptRow(id).handledAt).not.toBeNull();
		expect(bonTransactions()).toHaveLength(0);
	});

	it('laat je kiezen als er kandidaten zijn zonder duidelijke voorloper', async () => {
		const a = manual(-737, yesterday(), 'Supermarkt Voorbeeld');
		const b = manual(-737, yesterday(), 'Supermarkt Voorbeeld');
		const id = await upload();
		await readStoredReceipt(db, fakeHaiku(message(sureOutput())).client, id);

		expect(receiptRow(id)).toMatchObject({ status: 'zeker', transactionId: null, handledAt: null });
		expect(bonTransactions()).toHaveLength(0);
		const [item] = reviewInbox(db).receipts;
		expect(item).toMatchObject({ id, stage: 'kiezen', store: 'Supermarkt Voorbeeld 0001' });

		// De koppellijst: hoogstens vijf, met label, zonder voorselectie
		const list = receiptCandidates(db, loadReceipt(db, id)!.fields);
		expect(list.preselect).toBeNull();
		expect(list.candidates.map((c) => c.id).sort()).toEqual([a, b].sort());
		expect(list.candidates[0]!.label).toBe('waarschijnlijk');

		expect(settleReceipt(db, id, { kind: 'koppelen', transactionId: b })).toBe(b);
		expect(receiptRow(id).handledAt).not.toBeNull();
		expect(reviewInbox(db).receipts).toEqual([]);
	});

	it('zet een onzekere bon in de review-inbox en boekt niets', async () => {
		const output = sureOutput({ totaal: field('', 'onleesbaar', 'Totaal is gescheurd') });
		const id = await upload();
		await readStoredReceipt(db, fakeHaiku(message(output)).client, id);

		expect(receiptRow(id)).toMatchObject({ status: 'onzeker', transactionId: null });
		expect(bonTransactions()).toHaveLength(0);
		const inbox = reviewInbox(db);
		expect(inbox.receipts).toEqual([
			expect.objectContaining({ id, stage: 'onzeker', totalCents: null, doubt: ['totaal'] })
		]);
		// Geen ruwe uitvoer of notities naar de pagina
		expect(JSON.stringify(inbox.receipts)).not.toContain('gescheurd');

		// Zelf het totaal invullen en verwerken als nieuwe transactie
		correctReceipt(db, id, {
			store: 'Supermarkt Voorbeeld 0001',
			date: yesterday(),
			totalCents: 737,
			currency: 'EUR'
		});
		const made = settleReceipt(db, id, { kind: 'nieuw', accountId: account('rev') });
		expect(tx(made)).toMatchObject({
			source: 'bon',
			status: 'bevestigd',
			amountCents: -737,
			accountId: account('rev')
		});
		expect(reviewInbox(db).receipts).toEqual([]);
	});

	it('verwerkt een bon met twijfel, maar laat hem nakijken', async () => {
		const output = sureOutput({ datum: field(yesterday(), 'twijfel', 'Datum vaag') });
		const id = await upload();
		await readStoredReceipt(db, fakeHaiku(message(output)).client, id);

		const row = receiptRow(id);
		expect(row).toMatchObject({ status: 'controleren', handledAt: null });
		expect(tx(row.transactionId!)).toMatchObject({ source: 'bon', status: 'te_controleren' });
		const inbox = reviewInbox(db);
		expect(inbox.receipts).toEqual([
			expect.objectContaining({
				id,
				stage: 'nakijken',
				doubt: ['datum'],
				transaction: expect.objectContaining({ amountCents: -737 })
			})
		]);
		// Niet ook nog eens als boeking op te controleren
		expect(inbox.transactions).toEqual([]);

		confirmReceipt(db, id);
		expect(receiptRow(id).handledAt).not.toBeNull();
		expect(tx(row.transactionId!).status).toBe('bevestigd');
		expect(reviewInbox(db).receipts).toEqual([]);
	});

	it('bevestigen op Transacties handelt de bon mee af', async () => {
		const output = sureOutput({ totaal: field('7.37', 'twijfel') });
		const id = await upload();
		await readStoredReceipt(db, fakeHaiku(message(output)).client, id);
		const made = receiptRow(id).transactionId!;
		updateTransaction(db, made, { amountCents: -737 });
		expect(receiptRow(id).handledAt).not.toBeNull();
		expect(reviewInbox(db).receipts).toEqual([]);
	});

	it('een bon in dollars wordt een transactie zonder eurobedrag, op Revolut', async () => {
		const output = sureOutput({ valuta: field('USD'), betaalwijze: field('creditcard') });
		const id = await upload();
		await readStoredReceipt(db, fakeHaiku(message(output)).client, id);
		expect(tx(receiptRow(id).transactionId!)).toMatchObject({
			amountCents: 0,
			origAmountCents: -737,
			origCurrency: 'USD',
			status: 'te_controleren',
			accountId: account('rev')
		});
	});

	it('een weigering of ongeldige uitvoer is fout, met de reden en de ruwe uitvoer', async () => {
		const refused = await upload();
		await readStoredReceipt(db, fakeHaiku(message(sureOutput(), 'refusal')).client, refused);
		expect(receiptRow(refused)).toMatchObject({ status: 'fout', failure: 'weigering' });

		const garbage = await upload();
		await readStoredReceipt(db, fakeHaiku(message('<b>geen json</b>')).client, garbage);
		expect(receiptRow(garbage)).toMatchObject({
			status: 'fout',
			failure: 'ongeldig',
			rawAiOutput: { stopReason: 'end_turn', text: '<b>geen json</b>' }
		});
		expect(reviewInbox(db).receipts.map((r) => r.stage)).toEqual(['fout', 'fout']);
	});

	it('probeert een API-fout opnieuw en zet de bon na de laatste poging op fout', async () => {
		const { client, create } = fakeHaiku(new Error('overbelast'));
		registerReceiptReader(() => client);
		const id = await upload();
		let at = Date.now();
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await runDueJobs(db, new Date(at));
			at += 61_000;
		}
		expect(create).toHaveBeenCalledTimes(MAX_ATTEMPTS);
		expect(db.select().from(jobs).where(eq(jobs.kind, READ_RECEIPT_JOB)).get()!.status).toBe(
			'mislukt'
		);
		expect(receiptRow(id)).toMatchObject({ status: 'fout', failure: 'api' });
		expect(reviewInbox(db).receipts).toEqual([expect.objectContaining({ id, stage: 'fout' })]);
		expect(pushed.at(-1)).toMatchObject({
			kind: 'bon',
			message: { text: 'Een bon kon niet gelezen worden', url: `/bonnen/${id}` }
		});

		// Opnieuw lezen gaat weer in de wachtrij en lukt nu
		unregisterJob(READ_RECEIPT_JOB);
		registerReceiptReader(() => fakeHaiku(message(sureOutput())).client);
		rereadReceipt(db, id);
		expect(receiptRow(id).status).toBe('wordt_gelezen');
		await runDueJobs(db, new Date(at));
		expect(receiptRow(id).status).toBe('zeker');
	});

	it('doet niets met een bon die intussen weggegooid is', async () => {
		const { client, create } = fakeHaiku(message(sureOutput()));
		registerReceiptReader(() => client);
		const id = await upload();
		expect(await deleteReceipt(db, id)).toBe(true);
		await runDueJobs(db);
		expect(create).not.toHaveBeenCalled();
		expect(bonTransactions()).toHaveLength(0);
	});
});

describe('pushmelding', () => {
	it('meldt dat een bon gelezen is; winkel en bedrag alleen in het detail', async () => {
		const id = await upload();
		await readStoredReceipt(db, fakeHaiku(message(sureOutput())).client, id);
		expect(pushed).toHaveLength(1);
		const [{ kind, message: m }] = pushed as [{ kind: string; message: Record<string, string> }];
		expect(kind).toBe('bon');
		expect(m.url).toBe(`/bonnen/${id}`);
		// De tekst zonder bedragen of namen; `detail` alleen als het vergrendelscherm dat toestaat
		expect(m.text).toBe('Een bon is gelezen en verwerkt');
		expect(m.text).not.toMatch(/Supermarkt|7,37/);
		expect(m.detail).toContain('Supermarkt Voorbeeld 0001');
		expect(m.detail).toContain('7,37');
	});

	it('een onzekere bon vraagt om controle, zonder detail', async () => {
		const id = await upload();
		const output = sureOutput({ winkel: field('', 'onleesbaar') });
		await readStoredReceipt(db, fakeHaiku(message(output)).client, id);
		expect(pushed).toEqual([
			{
				kind: 'bon',
				message: expect.objectContaining({ text: 'Een bon heeft je controle nodig' })
			}
		]);
		expect(pushed[0]!.message.detail).toBeUndefined();
	});
});

describe('telemetrie', () => {
	it('legt per aanroep tokens, kosten, duur en uitkomst vast, en correcties achteraf', async () => {
		const id = await upload();
		await readStoredReceipt(db, fakeHaiku(message(sureOutput())).client, id);
		const [read] = telemetry.select().from(receiptReads).all();
		expect(read).toMatchObject({
			receiptId: id,
			model: 'claude-haiku-5-5',
			parts: 1,
			inputTokens: 2500,
			outputTokens: 300,
			costNanoUsd: 2500 * 100 + 300 * 500,
			outcome: 'zeker',
			corrected: null,
			correctedSure: false
		});
		expect(read!.durationMs).toBeGreaterThanOrEqual(0);

		// Het totaal was zeker, maar toch fout: dat is het getal dat laag moet blijven
		const fields = loadReceipt(db, id)!.fields;
		expect(
			correctReceipt(db, id, {
				store: fields.store!,
				date: fields.date!,
				totalCents: 773,
				currency: 'EUR'
			})
		).toEqual(['totaal']);
		// De transactie uit deze bon verandert mee
		expect(tx(receiptRow(id).transactionId!).amountCents).toBe(-773);

		const summary = receiptReadSummary(telemetry);
		expect(summary).toMatchObject({
			calls: 1,
			corrected: 1,
			correctedSure: 1,
			correctedFields: { totaal: 1, winkel: 0 },
			outcomes: { zeker: 1 },
			costNanoUsd: 2500 * 100 + 300 * 500
		});
		// Nergens iets van de bon zelf
		expect(JSON.stringify(telemetry.select().from(receiptReads).all())).not.toContain('Supermarkt');
	});
});
