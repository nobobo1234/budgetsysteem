// Boodschappen per productgroep met een nagebootste Haiku: nooit een echte API-aanroep. Van gelezen
// bon naar `receipt_lines`, een aangepaste groep met telemetrie, het overzicht per maand en de
// eenmalige migratie van bestaande bonnen (spec: Analyses → Boodschappen per productgroep).
import type Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { asc, eq } from 'drizzle-orm';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, shiftMonth, toIsoDate } from '../../src/lib/dates.ts';
import { resetConfig } from '../../src/lib/server/config.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	accounts,
	auditLog,
	categories,
	receiptLines,
	receipts,
	transactionSplits,
	transactions
} from '../../src/lib/server/db/schema.ts';
import { ValidationError } from '../../src/lib/server/errors.ts';
import { groceryOverview } from '../../src/lib/server/groceries.ts';
import { field, receiptOutput } from '../../src/lib/server/receipts/fixtures.ts';
import { receiptLinesOf, setLineGroup } from '../../src/lib/server/receipts/lines.ts';
import {
	correctReceipt,
	deleteReceipt,
	rereadReceipt,
	settleReceipt
} from '../../src/lib/server/receipts/process.ts';
import type { ReceiptClient } from '../../src/lib/server/receipts/reader.ts';
import type { ReceiptOutput } from '../../src/lib/server/receipts/schema.ts';
import { storeReceipt } from '../../src/lib/server/receipts/store.ts';
import { readStoredReceipt } from '../../src/lib/server/receipts/worker.ts';
import type { TelemetryDB } from '../../src/lib/server/telemetry/db.ts';
import { receiptReadSummary } from '../../src/lib/server/telemetry/receipts.ts';
import { receiptReads } from '../../src/lib/server/telemetry/schema.ts';
import { tempDatabase, tempTelemetry } from './helpers.ts';

// Pushmeldingen niet versturen
vi.mock('../../src/lib/server/push/notify.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/lib/server/push/notify.ts')>();
	return { ...actual, notify: async () => ({ status: 'verstuurd', sent: 1 }) };
});

let dir: string;
let db: DB;
let telemetry: TelemetryDB;
let cleanups: (() => void)[];
let photo: Buffer;

const today = () => toIsoDate(new Date());
const yesterday = () => addDays(today(), -1);

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'budget-boodschappen-'));
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
});
afterEach(() => cleanups.forEach((c) => c()));

function haiku(output: ReceiptOutput): ReceiptClient {
	const message = {
		id: 'msg_test',
		type: 'message',
		role: 'assistant',
		model: 'claude-haiku-5-5',
		content: [{ type: 'text', text: JSON.stringify(output), citations: null }],
		stop_reason: 'end_turn',
		stop_sequence: null,
		usage: { input_tokens: 2500, output_tokens: 300 }
	} as unknown as Anthropic.Message;
	return { messages: { create: vi.fn(async () => message) } } as unknown as ReceiptClient;
}

/** Een bon van gisteren bij Supermarkt Voorbeeld van € 7,37 (zie fixtures). */
const output = (overrides: Partial<ReceiptOutput> = {}) =>
	receiptOutput({ datum: field(yesterday()), ...overrides });

async function read(o: ReceiptOutput): Promise<string> {
	const { id } = await storeReceipt(db, { bytes: photo, mediaType: 'image/jpeg', source: 'app' });
	await readStoredReceipt(db, haiku(o), id);
	return id;
}

const lines = (receiptId: string) =>
	receiptLinesOf(db, receiptId).map((l) => [l.description, l.kind, l.amountCents, l.group]);
const receiptRow = (id: string) => db.select().from(receipts).where(eq(receipts.id, id)).get()!;
const account = (alias: string) =>
	db.select().from(accounts).where(eq(accounts.alias, alias)).get()!.id;
const category = (name: string) =>
	db.select().from(categories).where(eq(categories.name, name)).get()!.id;

const FIXTURE_LINES = [
	['Brood', 'artikel', 249, 'brood_ontbijt'],
	['Melk', 'artikel', 119, 'zuivel_eieren'],
	['Kaas', 'artikel', 429, 'zuivel_eieren'],
	['Bonus kaas', 'bonus', -75, null],
	['Statiegeld', 'statiegeld', 15, null]
];

describe('bonregels na verwerken', () => {
	it('een zekere bon zet zijn regels met productgroep in receipt_lines', async () => {
		const id = await read(output());
		expect(receiptRow(id)).toMatchObject({ status: 'zeker' });
		expect(lines(id)).toEqual(FIXTURE_LINES);
		expect(receiptLinesOf(db, id).map((l) => l.position)).toEqual([0, 1, 2, 3, 4]);
	});

	it('een bon met twijfel is ook verwerkt en krijgt zijn regels meteen', async () => {
		const id = await read(output({ datum: field(yesterday(), 'twijfel') }));
		expect(receiptRow(id)).toMatchObject({ status: 'controleren', handledAt: null });
		expect(lines(id)).toEqual(FIXTURE_LINES);
	});

	it('een onzekere bon pas na de review-inbox', async () => {
		const id = await read(output({ winkel: field('', 'onleesbaar') }));
		expect(receiptRow(id).status).toBe('onzeker');
		expect(lines(id)).toEqual([]);

		correctReceipt(db, id, {
			store: 'Supermarkt Voorbeeld',
			date: yesterday(),
			totalCents: 737,
			currency: 'EUR'
		});
		settleReceipt(db, id, { kind: 'nieuw', accountId: account('sns') });
		expect(lines(id)).toEqual(FIXTURE_LINES);
	});

	it('regels die niet samen het totaal vormen gaan er niet in', async () => {
		const id = await read(output({ totaal: field('7.37', 'twijfel'), regels: [] }));
		expect(lines(id)).toEqual([]);
		const half = output();
		half.regels[2]!.bedrag = 'vier';
		expect(lines(await read(half))).toEqual([]);
	});

	it('een onbekende groep van Haiku wordt overig; een artikel zonder groep ook', async () => {
		const raw = JSON.parse(JSON.stringify(output()));
		raw.regels[0].productgroep = 'bakkerij';
		raw.regels[1].productgroep = '';
		const id = await read(raw);
		expect(lines(id).slice(0, 2)).toEqual([
			['Brood', 'artikel', 249, 'overig'],
			['Melk', 'artikel', 119, 'overig']
		]);
	});

	it('opnieuw lezen haalt de oude regels weg; weggooien ook', async () => {
		const id = await read(
			output({ winkel: field('Super', 'twijfel'), totaal: field('', 'onleesbaar') })
		);
		expect(lines(id)).toEqual([]);
		// Een bon met twijfel zonder transactie mag opnieuw gelezen worden
		const unsure = await read(output({ datum: field(yesterday(), 'twijfel') }));
		db.update(receipts).set({ transactionId: null }).where(eq(receipts.id, unsure)).run();
		expect(lines(unsure)).toHaveLength(5);
		rereadReceipt(db, unsure);
		expect(lines(unsure)).toEqual([]);

		const sure = await read(output());
		expect(lines(sure)).toHaveLength(5);
		await deleteReceipt(db, sure);
		expect(db.select().from(receiptLines).where(eq(receiptLines.receiptId, sure)).all()).toEqual(
			[]
		);
	});
});

describe('groep aanpassen', () => {
	it('past de tabel aan, niet de ruwe uitvoer, en telt als correctie in de telemetrie', async () => {
		const id = await read(output());
		const melk = receiptLinesOf(db, id)[1]!;
		const rawBefore = receiptRow(id).rawAiOutput;

		expect(setLineGroup(db, id, melk.id, 'voorraad')).toBe(true);
		expect(receiptLinesOf(db, id)[1]!.group).toBe('voorraad');
		expect(receiptRow(id).rawAiOutput).toEqual(rawBefore);
		expect(db.select().from(auditLog).where(eq(auditLog.entityId, melk.id)).get()).toMatchObject({
			action: 'gecorrigeerd',
			entity: 'receipt_lines',
			before: { productGroup: 'zuivel_eieren' },
			after: { productGroup: 'voorraad' }
		});

		const read1 = telemetry.select().from(receiptReads).orderBy(asc(receiptReads.id)).all();
		expect(read1.at(-1)).toMatchObject({ receiptId: id, corrected: 'productgroep' });
		const summary = receiptReadSummary(telemetry);
		expect(summary.corrected).toBe(1);
		expect(summary.correctedSure).toBe(0);
		expect(summary.correctedFields.productgroep).toBe(1);

		// Dezelfde groep nog eens: niets te doen
		expect(setLineGroup(db, id, melk.id, 'voorraad')).toBe(false);
	});

	it('een aangepaste groep blijft staan als de bon daarna verwerkt wordt', async () => {
		const id = await read(output({ datum: field(yesterday(), 'twijfel') }));
		const brood = receiptLinesOf(db, id)[0]!;
		setLineGroup(db, id, brood.id, 'kant_en_klaar');
		const linked = receiptRow(id).transactionId!;
		settleReceipt(db, id, { kind: 'koppelen', transactionId: linked });
		expect(receiptLinesOf(db, id)[0]!.group).toBe('kant_en_klaar');
	});

	it('een regel van voor de productgroepen invullen telt niet als correctie', async () => {
		const id = await read(output());
		const line = receiptLinesOf(db, id)[0]!;
		db.update(receiptLines).set({ productGroup: null }).where(eq(receiptLines.id, line.id)).run();
		setLineGroup(db, id, line.id, 'brood_ontbijt');
		expect(receiptReadSummary(telemetry).corrected).toBe(0);
	});

	it('alleen een artikel van deze bon', async () => {
		const id = await read(output());
		const other = await read(output({ winkel: field('Supermarkt Anders 0002') }));
		const [, , , bonus] = receiptLinesOf(db, id);
		expect(() => setLineGroup(db, id, bonus!.id, 'overig')).toThrow(ValidationError);
		expect(() => setLineGroup(db, other, receiptLinesOf(db, id)[0]!.id, 'overig')).toThrow(
			'Deze regel bestaat niet meer'
		);
	});
});

describe('overzicht per maand', () => {
	const month = () => today().slice(0, 7);

	function spend(
		amountCents: number,
		date: string,
		categoryName = 'Boodschappen',
		foreign = false
	) {
		return db
			.insert(transactions)
			.values({
				amountCents: foreign ? 0 : amountCents,
				origAmountCents: foreign ? amountCents : null,
				origCurrency: foreign ? 'USD' : null,
				date,
				counterparty: 'SUPERMARKT VOORBEELD 0001',
				categoryId: category(categoryName),
				accountId: account('sns'),
				source: 'handmatig'
			})
			.returning({ id: transactions.id })
			.get().id;
	}

	/** Een bon die bij een bestaande transactie hoort, met regels in de tabel. */
	async function receiptFor(transactionId: string, o = output()) {
		const id = await read(o);
		const own = receiptRow(id).transactionId;
		db.update(receipts).set({ transactionId }).where(eq(receipts.id, id)).run();
		if (own && own !== transactionId) db.delete(transactions).where(eq(transactions.id, own)).run();
		return id;
	}

	it('verdeelt de boodschappen met een bon over de groepen, met dekking en duurste regels', async () => {
		const date = `${month()}-01`;
		const withReceipt = spend(-737, date);
		await receiptFor(withReceipt);
		// Zonder bon: telt alleen in de dekking
		spend(-1263, date);
		// Andere categorie: telt nergens
		spend(-5000, date, 'Uit eten en bezorgen');

		const o = groceryOverview(db, month());
		expect(o.missingCategory).toBe(false);
		expect(o.coverage).toEqual({ coveredCents: 737, totalCents: 2000, share: 737 / 2000 });
		expect(o.rows).toEqual([
			expect.objectContaining({ bucket: 'zuivel_eieren', cents: 548 }),
			expect.objectContaining({ bucket: 'brood_ontbijt', cents: 249 }),
			expect.objectContaining({ bucket: 'overige_regels', cents: 15 })
		]);
		expect(o.discount.cents).toBe(-75);
		expect(o.total.cents).toBe(737);
		expect(o.topLines.map((l) => [l.description, l.cents, l.counterparty])).toEqual([
			['Kaas', 429, 'SUPERMARKT VOORBEELD 0001'],
			['Brood', 249, 'SUPERMARKT VOORBEELD 0001'],
			['Melk', 119, 'SUPERMARKT VOORBEELD 0001']
		]);
	});

	it('een verdeelde uitgave telt in de dekking met alleen het deel in Boodschappen', async () => {
		const shared = spend(-2000, `${month()}-01`);
		db.insert(transactionSplits)
			.values([
				{ transactionId: shared, categoryId: category('Boodschappen'), amountCents: -1000 },
				{ transactionId: shared, categoryId: category('Terugbetaling'), amountCents: -1000 }
			])
			.run();
		const o = groceryOverview(db, month());
		expect(o.coverage).toEqual({ coveredCents: 0, totalCents: 1000, share: 0 });
	});

	it('een bon in vreemde valuta telt niet mee voor de regels', async () => {
		const foreign = spend(-737, `${month()}-01`, 'Boodschappen', true);
		db.update(transactions).set({ amountCents: -700 }).where(eq(transactions.id, foreign)).run();
		await receiptFor(foreign, output({ valuta: field('USD') }));
		const o = groceryOverview(db, month());
		expect(o.coverage.coveredCents).toBe(0);
		expect(o.rows).toEqual([]);
	});

	it('vergelijkt met de vorige maanden met bonnen', async () => {
		const last = shiftMonth(month(), -1);
		await receiptFor(spend(-737, `${last}-10`));
		await receiptFor(spend(-737, `${month()}-01`));
		const o = groceryOverview(db, month());
		expect(o.comparedMonths).toBe(1);
		expect(o.total).toEqual({ cents: 737, averageCents: 737, diffCents: 0 });
	});

	it('zonder categorie Boodschappen is er niets te verdelen', () => {
		db.update(categories)
			.set({ name: 'Supermarkt' })
			.where(eq(categories.name, 'Boodschappen'))
			.run();
		expect(groceryOverview(db, month())).toMatchObject({
			missingCategory: true,
			rows: [],
			coverage: { share: null }
		});
	});
});

describe('migratie van bestaande bonnen (0012)', () => {
	it('zet de regels van verwerkte bonnen erin, met lege productgroep', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'budget-migratie-'));
		try {
			cpSync('drizzle', join(tmp, 'drizzle'), { recursive: true });
			const journalPath = join(tmp, 'drizzle', 'meta', '_journal.json');
			const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
			const full = structuredClone(journal);
			journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < '0012');
			writeFileSync(journalPath, JSON.stringify(journal));

			const sqlite = new Database(join(tmp, 'budget.db'));
			const old = drizzle(sqlite);
			migrate(old, { migrationsFolder: join(tmp, 'drizzle') });

			const fields = (over: Record<string, unknown> = {}) =>
				JSON.stringify({
					store: 'Supermarkt Voorbeeld',
					date: '2026-09-20',
					totalCents: 368,
					currency: 'EUR',
					paymentMethod: 'pin',
					lines: [
						{ description: 'Brood', cents: 249, kind: 'artikel' },
						{ description: 'Melk', cents: 144, kind: 'artikel' },
						{ description: 'Bonus melk', cents: -25, kind: 'bonus' }
					],
					linesSumCents: 368,
					...over
				});
			const insert = sqlite.prepare(
				`INSERT INTO receipts (id, file_id, source, kind, status, checked_fields, handled_at)
				 VALUES (?, ?, 'app', ?, ?, ?, ?)`
			);
			insert.run('zeker', 'f1', 'bon', 'zeker', fields(), '2026-09-21T10:00:00Z');
			insert.run('twijfel', 'f2', 'bon', 'controleren', fields(), null);
			insert.run('na-inbox', 'f3', 'bon', 'onzeker', fields(), '2026-09-22T10:00:00Z');
			// Niet verwerkt, niet compleet, of geen bon: geen regels
			insert.run('wacht', 'f4', 'bon', 'onzeker', fields(), null);
			insert.run('half', 'f5', 'bon', 'zeker', fields({ linesSumCents: null }), null);
			insert.run('anders', 'f6', 'bon', 'zeker', fields({ totalCents: 500 }), null);
			insert.run('lijst', 'f7', 'lijst', 'zeker', fields(), null);
			insert.run('leeg', 'f8', 'bon', 'fout', null, '2026-09-22T10:00:00Z');

			writeFileSync(journalPath, JSON.stringify(full));
			migrate(old, { migrationsFolder: join(tmp, 'drizzle') });

			const rows = sqlite
				.prepare(
					`SELECT id, receipt_id, position, description, kind, amount_cents, product_group
					 FROM receipt_lines ORDER BY receipt_id, position`
				)
				.all() as Record<string, unknown>[];
			expect(rows.map((r) => r.receipt_id)).toEqual([
				'na-inbox',
				'na-inbox',
				'na-inbox',
				'twijfel',
				'twijfel',
				'twijfel',
				'zeker',
				'zeker',
				'zeker'
			]);
			expect(rows.slice(0, 3).map(({ id: _, receipt_id: __, ...r }) => r)).toEqual([
				{
					position: 0,
					description: 'Brood',
					kind: 'artikel',
					amount_cents: 249,
					product_group: null
				},
				{
					position: 1,
					description: 'Melk',
					kind: 'artikel',
					amount_cents: 144,
					product_group: null
				},
				{
					position: 2,
					description: 'Bonus melk',
					kind: 'bonus',
					amount_cents: -25,
					product_group: null
				}
			]);
			// Willekeurige UUID's (v4), elk anders
			for (const r of rows)
				expect(r.id).toMatch(
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
				);
			expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
			sqlite.close();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
