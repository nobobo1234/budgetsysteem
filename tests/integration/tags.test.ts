import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	accounts,
	categories,
	transactionTags,
	transactions
} from '../../src/lib/server/db/schema.ts';
import { importRecords } from '../../src/lib/server/import/importer.ts';
import type { ImportRecord } from '../../src/lib/server/import/types.ts';
import {
	createTag,
	deleteTag,
	setTransactionTag,
	tagDetail,
	tagSummaries,
	transactionTagChips,
	updateTag
} from '../../src/lib/server/tags.ts';
import {
	createTransaction,
	deleteTransaction,
	updateTransaction
} from '../../src/lib/server/transactions.ts';
import { newTransactionSchema } from '../../src/lib/server/validation.ts';
import { actions as tagActions } from '../../src/routes/(app)/tags/[id]/+page.server.ts';
import { actions as tagsActions } from '../../src/routes/(app)/tags/+page.server.ts';
import { actions as txActions } from '../../src/routes/(app)/transacties/[id]/+page.server.ts';
import { fakeEvent, ORIGIN, tempDatabase } from './helpers.ts';

let db: DB;
let cleanup: () => void;
let sns: string;
let cat: (name: string) => string;

const TODAY = '2026-10-26';
const LISSABON = { name: 'Lissabon', startDate: '2026-10-12', endDate: '2026-10-19', hue: 169 };

beforeEach(() => {
	({ db, cleanup } = tempDatabase());
	sns = db.select().from(accounts).where(eq(accounts.alias, 'sns')).get()!.id;
	cat = (name) => db.select().from(categories).where(eq(categories.name, name)).get()!.id;
});
afterEach(() => cleanup());

function tx(over: Partial<Record<string, unknown>> = {}) {
	const input = newTransactionSchema.parse({
		id: crypto.randomUUID(),
		amountCents: -2500,
		date: '2026-10-14',
		counterparty: 'Time Out Market',
		categoryId: cat('Uit eten en bezorgen'),
		accountId: sns,
		...over
	});
	createTransaction(db, input, TODAY);
	return input.id;
}

const links = (tagId: string) =>
	db.select().from(transactionTags).where(eq(transactionTags.tagId, tagId)).all();
const linked = (tagId: string) =>
	links(tagId)
		.filter((l) => l.active)
		.map((l) => l.transactionId)
		.sort();
const total = (tagId: string) => tagDetail(db, tagId, TODAY)!.totalCents;

const record = (over: Partial<ImportRecord>): ImportRecord => ({
	accountIban: 'NL12SNSB0123456789',
	date: '2026-10-14',
	amountCents: -1000,
	counterparty: 'Pastelaria',
	counterIban: null,
	description: '',
	bankReference: crypto.randomUUID(),
	...over
});

describe('import met een actieve tag', () => {
	it('nieuwe boekingen in de periode krijgen de tag, andere niet', () => {
		const tagId = createTag(db, LISSABON);
		const summary = importRecords(
			db,
			[
				record({ date: '2026-10-12', bankReference: 'IN-1' }),
				record({ date: '2026-10-19', bankReference: 'IN-2', amountCents: -2000 }),
				record({ date: '2026-10-20', bankReference: 'NA' })
			],
			'camt053'
		);
		expect(summary.newCount).toBe(3);
		const byRef = (ref: string) =>
			db.select().from(transactions).where(eq(transactions.bankReference, ref)).get()!.id;
		expect(linked(tagId)).toEqual([byRef('IN-1'), byRef('IN-2')].sort());
		expect(links(tagId).every((l) => l.source === 'automatisch')).toBe(true);
		// Zonder categorie telt wat er uitging
		expect(total(tagId)).toBe(3000);
	});

	it('rolt bij een fout ook de tags terug', () => {
		const tagId = createTag(db, LISSABON);
		const good = record({ bankReference: 'GOED' });
		const bad = record({ bankReference: 'FOUT', date: '14-10-2026' });
		expect(() => importRecords(db, [good, bad], 'camt053')).toThrow();
		expect(db.select().from(transactions).all()).toHaveLength(0);
		expect(links(tagId)).toHaveLength(0);
	});

	it('een tweede import van hetzelfde bestand zet niets dubbel en laat uitgezette tags uit', () => {
		const tagId = createTag(db, LISSABON);
		const file = [record({ bankReference: 'R1' }), record({ bankReference: 'R2' })];
		importRecords(db, file, 'camt053');
		const [first] = linked(tagId);
		setTransactionTag(db, first!, tagId, false);
		const again = importRecords(db, file, 'camt053');
		expect(again.newCount).toBe(0);
		expect(links(tagId)).toHaveLength(2);
		expect(linked(tagId)).not.toContain(first);
	});
});

describe('automatisch toewijzen', () => {
	it('een nieuwe tag neemt bestaande transacties in zijn periode mee', () => {
		const binnen = tx();
		tx({ date: '2026-10-25' });
		const tagId = createTag(db, LISSABON);
		expect(linked(tagId)).toEqual([binnen]);
	});

	it('handmatige invoer en snelinvoer krijgen de tag vanzelf', () => {
		const tagId = createTag(db, LISSABON);
		const id = tx();
		expect(linked(tagId)).toEqual([id]);
	});

	it('een open einde loopt door', () => {
		const tagId = createTag(db, { ...LISSABON, name: 'Zweden', endDate: null });
		const later = tx({ date: '2026-10-26' });
		expect(linked(tagId)).toContain(later);
	});

	it('een andere datum schuift de tag mee', () => {
		const tagId = createTag(db, LISSABON);
		const id = tx();
		updateTransaction(db, id, { date: '2026-10-22' }, TODAY);
		expect(linked(tagId)).toEqual([]);
		updateTransaction(db, id, { date: '2026-10-18' }, TODAY);
		expect(linked(tagId)).toEqual([id]);
	});

	it('een andere periode neemt automatische tags mee en laat eigen keuzes staan', () => {
		const tagId = createTag(db, LISSABON);
		const vlucht = tx({
			date: '2026-09-01',
			counterparty: 'TAP Air Portugal',
			amountCents: -18000
		});
		const lunch = tx();
		const huur = tx({ date: '2026-10-15', counterparty: 'Woonstichting', amountCents: -80000 });
		setTransactionTag(db, vlucht, tagId, true);
		setTransactionTag(db, huur, tagId, false);
		expect(linked(tagId)).toEqual([vlucht, lunch].sort());

		updateTag(db, tagId, { ...LISSABON, startDate: '2026-10-15', endDate: '2026-10-20' });
		// De lunch op de 14e valt erbuiten; de vlucht blijft, de huur blijft uit
		expect(linked(tagId)).toEqual([vlucht]);
		updateTag(db, tagId, LISSABON);
		expect(linked(tagId)).toEqual([vlucht, lunch].sort());
		expect(links(tagId).find((l) => l.transactionId === huur)).toMatchObject({
			source: 'handmatig',
			active: false
		});
	});

	it('verwijderen haalt de tag weg, niet de transacties', () => {
		const tagId = createTag(db, LISSABON);
		const id = tx();
		deleteTag(db, tagId);
		expect(links(tagId)).toHaveLength(0);
		expect(db.select().from(transactions).where(eq(transactions.id, id)).get()).toBeDefined();
	});

	it('een verwijderde transactie verdwijnt uit de tag', () => {
		const tagId = createTag(db, LISSABON);
		const id = tx();
		deleteTransaction(db, id);
		expect(links(tagId)).toHaveLength(0);
	});
});

describe('totaal', () => {
	it('telt jouw deel van een gedeelde uitgave en verlaagt met een retour', () => {
		const tagId = createTag(db, LISSABON);
		// €90 diner voor drie: jouw deel €30
		tx({ amountCents: -9000, share: { people: 3, with: ['Sanne', 'Tim'] } });
		// Schoenen €60, €20 teruggebracht na de reis
		const schoenen = tx({ amountCents: -6000, counterparty: 'Zara', categoryId: cat('Kleding') });
		tx({
			amountCents: 2000,
			date: '2026-10-24',
			counterparty: 'Zara',
			categoryId: cat('Kleding'),
			correct: { transactionId: schoenen }
		});
		// Eigen overboeking en inkomen tellen niet mee
		tx({
			amountCents: -50000,
			counterparty: 'Spaarrekening',
			categoryId: cat('Interne overboeking')
		});
		tx({ amountCents: 250000, counterparty: 'Werkgever', categoryId: cat('Inkomen') });

		const detail = tagDetail(db, tagId, TODAY)!;
		expect(detail.totalCents).toBe(3000 + 4000);
		expect(detail.byCategory.map((c) => [c.name, c.cents])).toEqual([
			['Kleding', 4000],
			['Uit eten en bezorgen', 3000]
		]);
		// De retour staat onder zijn uitgave, niet los
		const zara = detail.items.find((i) => i.id === schoenen)!;
		expect(zara.corrections.map((c) => c.amountCents)).toEqual([2000]);
		expect(detail.items).toHaveLength(2);
		expect(detail.notCounted.map((i) => i.counterparty).sort()).toEqual([
			'Spaarrekening',
			'Werkgever'
		]);
		expect(detail.items.find((i) => i.counterparty === 'Time Out Market')?.mineCents).toBe(-3000);
	});

	it('een uitgezette tag telt niet mee', () => {
		const tagId = createTag(db, LISSABON);
		tx();
		const huur = tx({
			counterparty: 'Woonstichting',
			amountCents: -80000,
			categoryId: cat('Wonen')
		});
		expect(total(tagId)).toBe(82500);
		setTransactionTag(db, huur, tagId, false);
		expect(total(tagId)).toBe(2500);
		expect(tagDetail(db, tagId, TODAY)!.off.map((i) => i.id)).toEqual([huur]);
	});

	it('het overzicht zet lopende en komende tags voor afgelopen', () => {
		createTag(db, LISSABON);
		createTag(db, { ...LISSABON, name: 'Zweden', startDate: '2026-08-20', endDate: null });
		createTag(db, { ...LISSABON, name: 'Kerst', startDate: '2026-12-24', endDate: '2026-12-26' });
		expect(tagSummaries(db, TODAY).map((t) => [t.name, t.state])).toEqual([
			['Zweden', 'loopt'],
			['Kerst', 'komt'],
			['Lissabon', 'voorbij']
		]);
	});
});

describe('schermen', () => {
	function event(path: string, routeId: string, params: Record<string, string>, form: FormData) {
		const base = fakeEvent({ path, routeId, method: 'POST', params });
		const request = new Request(`${ORIGIN}${path}`, {
			method: 'POST',
			body: form,
			headers: { origin: ORIGIN }
		});
		return { ...base, request } as never;
	}
	const formOf = (fields: Record<string, string>) => {
		const form = new FormData();
		for (const [k, v] of Object.entries(fields)) form.set(k, v);
		return form;
	};

	it('een nieuwe tag gaat naar zijn pagina', async () => {
		const form = formOf({
			name: 'Lissabon',
			startDate: '2026-10-12',
			endDate: '2026-10-19',
			hue: '169'
		});
		await expect(
			tagsActions.create!(event('/tags?/create', '/(app)/tags', {}, form))
		).rejects.toMatchObject({ status: 303, location: expect.stringMatching(/^\/tags\//) });
		expect(tagSummaries(db, TODAY)).toHaveLength(1);
	});

	it('weigert een einde voor het begin en een onbekende kleur', async () => {
		const early = await tagsActions.create!(
			event(
				'/tags?/create',
				'/(app)/tags',
				{},
				formOf({ name: 'X', startDate: '2026-10-12', endDate: '2026-10-01', hue: '169' })
			)
		);
		expect(early).toMatchObject({ status: 400 });
		const hue = await tagsActions.create!(
			event(
				'/tags?/create',
				'/(app)/tags',
				{},
				formOf({ name: 'X', startDate: '2026-10-12', open: 'on', hue: '30' })
			)
		);
		expect(hue).toMatchObject({ status: 400 });
		expect(tagSummaries(db, TODAY)).toHaveLength(0);
	});

	it('zet een tag uit op de transactie en weer aan op de tagpagina', async () => {
		const tagId = createTag(db, LISSABON);
		const id = tx();
		expect(transactionTagChips(db, id)!.chips).toMatchObject([{ id: tagId, on: true }]);

		await txActions.tag!(
			event(
				`/transacties/${id}?/tag`,
				'/(app)/transacties/[id]',
				{ id },
				formOf({ tagId, on: '0' })
			)
		);
		expect(transactionTagChips(db, id)!.chips).toMatchObject([
			{ id: tagId, on: false, manual: true }
		]);
		expect(total(tagId)).toBe(0);

		await tagActions.toggle!(
			event(
				`/tags/${tagId}?/toggle`,
				'/(app)/tags/[id]',
				{ id: tagId },
				formOf({ transactionId: id, on: '1' })
			)
		);
		expect(total(tagId)).toBe(2500);
	});

	it('een retour volgt de tags van zijn uitgave', () => {
		createTag(db, LISSABON);
		const jas = tx({ amountCents: -6000, categoryId: cat('Kleding') });
		const retour = tx({
			amountCents: 2000,
			date: '2026-10-24',
			categoryId: cat('Kleding'),
			correct: { transactionId: jas }
		});
		expect(transactionTagChips(db, retour)).toMatchObject({
			chips: [],
			follows: [{ name: 'Lissabon' }]
		});
		expect(
			db.select().from(transactionTags).where(eq(transactionTags.transactionId, retour)).all()
		).toHaveLength(0);
	});
});
