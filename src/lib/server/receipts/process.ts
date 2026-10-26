import { and, asc, desc, eq, gte, isNull, lte, ne, sql } from 'drizzle-orm';
import { rm } from 'node:fs/promises';
import { addDays } from '../../dates.ts';
import { rankMatches, type MatchLabel, type MatchQuery } from '../../match.ts';
import { matchRule, sortRules } from '../../rules.ts';
import { recordChange } from '../audit.ts';
import type { Conn, DB } from '../db/index.ts';
import { accounts, categories, receiptItems, receipts, rules, transactions } from '../db/schema.ts';
import { ValidationError } from '../errors.ts';
import { enqueue, runJobsSoon } from '../jobs.ts';
import { log } from '../log.ts';
import { recordCorrection, type CorrectableField } from '../telemetry/receipts.ts';
import { telemetryDb } from '../telemetry/index.ts';
import { deleteTransaction, updateTransaction } from '../transactions.ts';
import { dateInRange } from '../validation.ts';
import type { FieldStatus } from './checks.ts';
import {
	isComplete,
	matchQueryFor,
	planReceipt,
	receiptStage,
	type ReceiptPlan,
	type ReceiptStage
} from './outcome.ts';
import type { ReadFailure } from './reader.ts';
import { READ_RECEIPT_JOB, receiptPath, type ReadReceiptPayload } from './store.ts';
import { syncAutoTags } from '../tags.ts';
import {
	emptyConfidence,
	emptyFields,
	readStored,
	type RawOutput,
	type StoredConfidence,
	type StoredFields,
	type StoredListItem
} from './stored.ts';

// Een gelezen bon verwerken (spec: Bonnetjes en koppelen): de koppellijst tegen bestaande
// transacties, automatisch verwerken volgens `planReceipt`, en wat jij op het bonscherm of in de
// review-inbox doet. Een nieuwe transactie uit een bon krijgt bron `bon`.

export type ReceiptRow = typeof receipts.$inferSelect;
export type ReceiptStatus = ReceiptRow['status'];

/** Zoveel dagen rond de bondatum zoekt de koppellijst; de datumscore is 0 vanaf 5 dagen. */
const WINDOW_DAYS = 7;
const MAX_TARGETS = 200;

export interface ReceiptCandidate {
	id: string;
	counterparty: string;
	date: string;
	amountCents: number;
	origAmountCents: number | null;
	origCurrency: string | null;
	source: 'import' | 'handmatig' | 'bon' | 'verwacht';
	status: 'bevestigd' | 'verwacht' | 'te_controleren';
	accountAlias: string;
	categoryName: string | null;
	categoryGroup: string | null;
	score: number;
	label: MatchLabel;
}

/**
 * De koppellijst voor een bon: uitgaven rond de bondatum, gesorteerd op score, hoogstens vijf.
 * Een bon in vreemde valuta vergelijkt met het oorspronkelijke bedrag van een transactie in
 * dezelfde valuta. Verwachte posten doen niet mee: een bon is altijd een echte betaling.
 */
export function receiptCandidates(
	db: Conn,
	fields: StoredFields
): { candidates: ReceiptCandidate[]; preselect: string | null } {
	const query = matchQueryFor(fields);
	if (!query) return { candidates: [], preselect: null };
	return transactionCandidates(db, query, { currency: fields.currency, incoming: false });
}

/**
 * De koppellijst tegen bestaande transacties, voor een bon of een transactie op een screenshot:
 * rond de datum, met hetzelfde teken (uitgaven of inkomsten), gesorteerd op score.
 */
export function transactionCandidates(
	db: Conn,
	query: MatchQuery,
	{ currency, incoming }: { currency: string | null; incoming: boolean }
): { candidates: ReceiptCandidate[]; preselect: string | null } {
	const rows = db
		.select({
			id: transactions.id,
			counterparty: transactions.counterparty,
			date: transactions.date,
			amountCents: transactions.amountCents,
			origAmountCents: transactions.origAmountCents,
			origCurrency: transactions.origCurrency,
			source: transactions.source,
			status: transactions.status,
			accountAlias: accounts.alias,
			categoryName: categories.name,
			categoryGroup: categories.group
		})
		.from(transactions)
		.innerJoin(accounts, eq(accounts.id, transactions.accountId))
		.leftJoin(categories, eq(categories.id, transactions.categoryId))
		.where(
			and(
				gte(transactions.date, addDays(query.date, -WINDOW_DAYS)),
				lte(transactions.date, addDays(query.date, WINDOW_DAYS)),
				ne(transactions.status, 'verwacht'),
				incoming ? gte(transactions.amountCents, 0) : lte(transactions.amountCents, 0)
			)
		)
		// Dichtst bij de bondatum eerst, zodat bij gelijke score de dichtstbijzijnde wint
		.orderBy(
			sql`abs(julianday(${transactions.date}) - julianday(${query.date}))`,
			asc(transactions.createdAt)
		)
		.limit(MAX_TARGETS)
		.all();
	const foreign = currency !== null && currency !== 'EUR';
	const targets = rows.map((r) => ({
		...r,
		name: r.counterparty,
		amountCents:
			foreign && r.origCurrency === currency && r.origAmountCents !== null
				? Math.abs(r.origAmountCents)
				: Math.abs(r.amountCents),
		row: r
	}));
	const ranked = rankMatches(query, targets);
	return {
		preselect: ranked.preselect,
		candidates: ranked.candidates.map((c) => ({ ...c.target.row, score: c.score, label: c.label }))
	};
}

/** Rekening voor een nieuwe transactie: SNS voor euro's, Revolut bij vreemde valuta. */
export function defaultAccountId(db: Conn, currency: string | null): string | null {
	const kind = currency !== null && currency !== 'EUR' ? 'revolut' : 'sns';
	const all = db
		.select({ id: accounts.id, kind: accounts.kind })
		.from(accounts)
		.orderBy(asc(accounts.createdAt))
		.all();
	return (all.find((a) => a.kind === kind) ?? all[0])?.id ?? null;
}

/**
 * Een nieuwe transactie uit een bon, met de categorie via je regels. Bij vreemde valuta is het
 * eurobedrag nog onbekend: dan staat hij op te controleren met het oorspronkelijke bedrag, net
 * als `$20` in de snelinvoer.
 */
function createReceiptTransaction(
	db: Conn,
	fields: StoredFields,
	accountId: string,
	status: 'bevestigd' | 'te_controleren'
): string {
	if (!isComplete(fields)) throw new ValidationError('Vul eerst winkel, datum en bedrag in');
	if (!dateInRange(fields.date!)) throw new ValidationError('Datum ligt te ver weg');
	const account = db
		.select({ id: accounts.id })
		.from(accounts)
		.where(eq(accounts.id, accountId))
		.get();
	if (!account) throw new ValidationError('Onbekende rekening');
	return insertBonTransaction(db, {
		amountCents: -fields.totalCents!,
		currency: fields.currency!,
		date: fields.date!,
		counterparty: fields.store!,
		accountId,
		status
	});
}

/**
 * Een transactie met bron `bon` (van een bon of een screenshot), met de categorie via je
 * regels. `amountCents` heeft het teken en de valuta van wat er gelezen is; bij vreemde valuta
 * blijft het eurobedrag 0 en staat hij op te controleren.
 */
export function insertBonTransaction(
	db: Conn,
	t: {
		amountCents: number;
		currency: string;
		date: string;
		counterparty: string;
		accountId: string;
		status: 'bevestigd' | 'te_controleren';
	}
): string {
	const foreign = t.currency !== 'EUR';
	const counterparty = t.counterparty.trim().slice(0, 100);
	const rule = matchRule(sortRules(db.select().from(rules).all()), {
		counterparty,
		counterIban: null,
		description: ''
	});
	const row = db
		.insert(transactions)
		.values({
			amountCents: foreign ? 0 : t.amountCents,
			date: t.date,
			counterparty,
			categoryId: rule?.categoryId ?? null,
			categorySource: rule ? 'regel' : null,
			categoryRuleId: rule?.id ?? null,
			accountId: t.accountId,
			source: 'bon',
			origAmountCents: foreign ? t.amountCents : null,
			origCurrency: foreign ? t.currency : null,
			status: foreign ? 'te_controleren' : t.status
		})
		.returning()
		.get();
	recordChange(db, 'aangemaakt', 'transactions', row.id, null, row);
	syncAutoTags(db, [row.id]);
	return row.id;
}

function applyPlan(
	db: Conn,
	receiptId: string,
	plan: ReceiptPlan,
	fields: StoredFields,
	now: Date
) {
	if (plan.action === 'inbox') return;
	const handledAt = plan.handled ? now.toISOString() : null;
	let transactionId: string;
	if (plan.action === 'koppelen') {
		transactionId = plan.transactionId;
	} else {
		const accountId = defaultAccountId(db, fields.currency);
		if (!accountId) return;
		transactionId = createReceiptTransaction(db, fields, accountId, plan.status);
	}
	db.update(receipts).set({ transactionId, handledAt }).where(eq(receipts.id, receiptId)).run();
}

export type ReadingResult =
	| {
			ok: true;
			outcome: FieldStatus;
			fields: StoredFields;
			confidence: StoredConfidence;
			/** Alleen bij een screenshot met transacties; die boekt nooit vanzelf. */
			list?: StoredListItem[] | null;
			raw: RawOutput;
	  }
	| { ok: false; reason: ReadFailure | 'api'; raw: RawOutput | null };

export interface SavedReading {
	status: ReceiptStatus;
	plan: ReceiptPlan | null;
	fields: StoredFields;
	stage: ReceiptStage;
	/** De transactie die nu bij de bon hoort (gekoppeld of nieuw). */
	transactionId: string | null;
}

/**
 * Slaat het resultaat van het lezen op en verwerkt de bon als dat zonder twijfel kan, in één
 * database-transactie. `null` als de bon intussen weg is of al gelezen (bijvoorbeeld opnieuw
 * ingepland): dan verandert er niets.
 */
export function saveReading(
	db: DB,
	receiptId: string,
	result: ReadingResult,
	now = new Date()
): SavedReading | null {
	return db.transaction((tx) => {
		const receipt = tx.select().from(receipts).where(eq(receipts.id, receiptId)).get();
		if (!receipt || receipt.status !== 'wordt_gelezen') return null;
		// Opnieuw gelezen: wat er van een eerdere lezing als lijst stond, telt niet meer
		tx.delete(receiptItems).where(eq(receiptItems.receiptId, receiptId)).run();
		if (!result.ok) {
			const fields = emptyFields();
			tx.update(receipts)
				.set({
					kind: 'bon',
					status: 'fout',
					failure: result.reason,
					rawAiOutput: result.raw,
					checkedFields: fields,
					fieldConfidence: emptyConfidence(),
					readAt: now.toISOString(),
					transactionId: null,
					handledAt: null
				})
				.where(eq(receipts.id, receiptId))
				.run();
			return { status: 'fout', plan: null, fields, stage: 'fout', transactionId: null };
		}
		const list = result.list ?? null;
		tx.update(receipts)
			.set({
				kind: list ? 'lijst' : 'bon',
				status: result.outcome,
				failure: null,
				rawAiOutput: result.raw,
				checkedFields: result.fields,
				fieldConfidence: result.confidence,
				readAt: now.toISOString(),
				transactionId: null,
				handledAt: null
			})
			.where(eq(receipts.id, receiptId))
			.run();
		let plan: ReceiptPlan;
		if (list) {
			// Een lijst boekt nooit stil: hij wacht tot je hem bevestigt
			list.forEach((item, position) => {
				tx.insert(receiptItems)
					.values({
						receiptId,
						position,
						date: item.date,
						counterparty: item.counterparty,
						amountCents: item.amountCents,
						currency: item.currency,
						confidence: item.confidence
					})
					.run();
			});
			plan = { action: 'inbox', reason: 'lijst' };
		} else {
			plan = planReceipt(result.outcome, result.fields, receiptCandidates(tx, result.fields));
			applyPlan(tx, receiptId, plan, result.fields, now);
		}
		const after = tx
			.select({ transactionId: receipts.transactionId, handledAt: receipts.handledAt })
			.from(receipts)
			.where(eq(receipts.id, receiptId))
			.get()!;
		return {
			status: result.outcome,
			plan,
			fields: result.fields,
			stage: receiptStage({ status: result.outcome, kind: list ? 'lijst' : 'bon', ...after }),
			transactionId: after.transactionId
		};
	});
}

/** Na de laatste mislukte poging (API onbereikbaar): de bon staat op fout en in de inbox. */
export function markReadFailed(db: DB, receiptId: string, now = new Date()): boolean {
	return (
		saveReading(db, receiptId, { ok: false, reason: 'api', raw: null }, now)?.status === 'fout'
	);
}

export interface LoadedReceipt {
	id: string;
	status: ReceiptStatus;
	stage: ReceiptStage;
	kind: ReceiptRow['kind'];
	source: ReceiptRow['source'];
	mediaType: ReceiptRow['mediaType'];
	fileId: string;
	failure: string | null;
	fields: StoredFields;
	confidence: StoredConfidence;
	transactionId: string | null;
	createdAt: string;
	readAt: string | null;
	handledAt: string | null;
}

function toLoaded(r: ReceiptRow): LoadedReceipt {
	const { fields, confidence } = readStored(r.checkedFields, r.fieldConfidence);
	return {
		id: r.id,
		status: r.status,
		stage: receiptStage(r),
		kind: r.kind,
		source: r.source,
		mediaType: r.mediaType,
		fileId: r.fileId,
		failure: r.failure,
		fields,
		confidence,
		transactionId: r.transactionId,
		createdAt: r.createdAt,
		readAt: r.readAt,
		handledAt: r.handledAt
	};
}

export function loadReceipt(db: Conn, id: string): LoadedReceipt | null {
	const row = db.select().from(receipts).where(eq(receipts.id, id)).get();
	return row ? toLoaded(row) : null;
}

/** De laatste bonnen, nieuwste eerst, voor het scherm Bonnen. */
export function recentReceipts(db: Conn, limit = 50): LoadedReceipt[] {
	return db
		.select()
		.from(receipts)
		.orderBy(desc(receipts.createdAt))
		.limit(limit)
		.all()
		.map(toLoaded);
}

/** Bonnen die op jou wachten: niet afgehandeld en klaar met lezen (spec: review-inbox). */
export function pendingReceipts(db: Conn): LoadedReceipt[] {
	return db
		.select()
		.from(receipts)
		.where(and(isNull(receipts.handledAt), ne(receipts.status, 'wordt_gelezen')))
		.orderBy(asc(receipts.createdAt))
		.all()
		.map(toLoaded);
}

function requireReceipt(db: Conn, id: string): LoadedReceipt {
	const r = loadReceipt(db, id);
	if (!r) throw new ValidationError('Deze bon bestaat niet meer');
	if (r.status === 'wordt_gelezen') throw new ValidationError('Deze bon wordt nog gelezen');
	return r;
}

/** Koppelen, nakijken en velden aanpassen horen bij een bon; een lijst bevestig je in één keer. */
function requireBon(db: Conn, id: string): LoadedReceipt {
	const r = requireReceipt(db, id);
	if (r.kind === 'lijst') throw new ValidationError('Dit screenshot bevestig je als lijst');
	return r;
}

/** De transactie is uit deze bon ontstaan en hoort bij geen andere bon. */
function ownTransaction(db: Conn, receipt: LoadedReceipt): string | null {
	if (!receipt.transactionId) return null;
	const t = db
		.select({ source: transactions.source })
		.from(transactions)
		.where(eq(transactions.id, receipt.transactionId))
		.get();
	if (t?.source !== 'bon') return null;
	const others = db
		.select({ id: receipts.id })
		.from(receipts)
		.where(and(eq(receipts.transactionId, receipt.transactionId), ne(receipts.id, receipt.id)))
		.get();
	return others ? null : receipt.transactionId;
}

export type SettleChoice =
	{ kind: 'koppelen'; transactionId: string } | { kind: 'nieuw'; accountId: string };

/**
 * Verwerken vanaf het bonscherm of de inbox: koppelen aan een bestaande transactie of een nieuwe
 * maken, en daarmee afgehandeld. Hoorde de bon bij een transactie die uit deze bon ontstond en
 * kies je nu iets anders, dan verdwijnt die transactie, zodat niets dubbel telt.
 */
export function settleReceipt(db: DB, id: string, choice: SettleChoice, now = new Date()): string {
	const receipt = requireBon(db, id);
	if (!isComplete(receipt.fields))
		throw new ValidationError('Vul eerst winkel, datum en bedrag in');
	// Alles controleren voordat een eigen transactie verdwijnt
	if (choice.kind === 'nieuw' && !dateInRange(receipt.fields.date!))
		throw new ValidationError('Datum ligt te ver weg');
	if (choice.kind === 'koppelen') {
		const target = db
			.select({ status: transactions.status })
			.from(transactions)
			.where(eq(transactions.id, choice.transactionId))
			.get();
		if (!target || target.status === 'verwacht')
			throw new ValidationError('Deze transactie kan ik niet koppelen');
	} else if (
		!db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, choice.accountId)).get()
	) {
		throw new ValidationError('Onbekende rekening');
	}

	const own = ownTransaction(db, receipt);
	const same = choice.kind === 'koppelen' && choice.transactionId === receipt.transactionId;
	if (own && !same) deleteTransaction(db, own);

	return db.transaction((tx) => {
		let transactionId: string;
		if (choice.kind === 'koppelen') transactionId = choice.transactionId;
		else
			transactionId = createReceiptTransaction(tx, receipt.fields, choice.accountId, 'bevestigd');
		tx.update(receipts)
			.set({ transactionId, handledAt: now.toISOString() })
			.where(eq(receipts.id, id))
			.run();
		recordChange(
			tx,
			'verwerkt',
			'receipts',
			id,
			{ transactionId: receipt.transactionId },
			{ transactionId }
		);
		return transactionId;
	});
}

/**
 * "Klopt": een verwerkte bon met twijfel is nagekeken. Een transactie die uit deze bon ontstond
 * en op te controleren staat, wordt bevestigd (behalve als het eurobedrag nog ontbreekt).
 */
export function confirmReceipt(db: DB, id: string, now = new Date()): void {
	const receipt = requireBon(db, id);
	if (!receipt.transactionId) throw new ValidationError('Kies eerst waar deze bon bij hoort');
	if (receipt.handledAt) throw new ValidationError('Deze bon is al nagekeken');
	db.transaction((tx) => {
		tx.update(receipts).set({ handledAt: now.toISOString() }).where(eq(receipts.id, id)).run();
		const own = ownTransaction(tx, receipt);
		if (own) {
			const before = tx.select().from(transactions).where(eq(transactions.id, own)).get();
			if (before && before.status === 'te_controleren' && before.amountCents !== 0) {
				const after = tx
					.update(transactions)
					.set({ status: 'bevestigd', updatedAt: now.toISOString() })
					.where(eq(transactions.id, own))
					.returning()
					.get();
				recordChange(tx, 'gewijzigd', 'transactions', own, before, after);
			}
		}
		recordChange(tx, 'nagekeken', 'receipts', id, null, null);
	});
}

export interface FieldPatch {
	store: string;
	date: string;
	totalCents: number;
	currency: string;
}

const CORRECTABLE: [keyof FieldPatch, CorrectableField][] = [
	['store', 'winkel'],
	['date', 'datum'],
	['totalCents', 'totaal'],
	['currency', 'valuta']
];

/**
 * Velden aanpassen. Een veld dat je zelf invult is daarna zeker. Was er al een waarde van Haiku,
 * dan telt het als correctie in de telemetrie (en als "zeker maar fout" als hij zeker heette).
 * Hoort er een transactie bij die uit deze bon ontstond, dan verandert die mee.
 */
export function correctReceipt(db: DB, id: string, patch: FieldPatch): CorrectableField[] {
	const receipt = requireBon(db, id);
	if (!dateInRange(patch.date)) throw new ValidationError('Datum ligt te ver weg');
	const fields: StoredFields = { ...receipt.fields };
	const confidence: StoredConfidence = structuredClone(receipt.confidence);
	const corrected: CorrectableField[] = [];
	let sure = false;
	let changed = false;
	for (const [key, name] of CORRECTABLE) {
		const before = fields[key];
		const next = patch[key];
		if (before === next) continue;
		changed = true;
		const conf = confidence[name];
		if (before !== null && !conf.corrected && conf.model !== null) {
			corrected.push(name);
			if (conf.status === 'zeker') sure = true;
		}
		(fields as Record<string, unknown>)[key] = next;
		confidence[name] = { ...conf, status: 'zeker', corrected: true };
	}
	if (!changed) return [];
	db.update(receipts)
		.set({ checkedFields: fields, fieldConfidence: confidence })
		.where(eq(receipts.id, id))
		.run();
	recordChange(db, 'gecorrigeerd', 'receipts', id, null, { fields: CORRECTABLE.map((c) => c[1]) });

	const own = ownTransaction(db, receipt);
	if (own && fields.currency === 'EUR' && receipt.fields.currency === 'EUR') {
		updateTransaction(db, own, {
			amountCents: -patch.totalCents,
			date: patch.date,
			counterparty: patch.store
		});
	}
	try {
		recordCorrection(telemetryDb(), id, corrected, sure);
	} catch (e) {
		log.warn({ err: { name: e instanceof Error ? e.name : 'Onbekend' } }, 'telemetrie bon mislukt');
	}
	return corrected;
}

/** Opnieuw laten lezen, zolang er nog niets mee gedaan is (bijvoorbeeld na een fout). */
export function rereadReceipt(db: DB, id: string, now = new Date()): void {
	const receipt = requireReceipt(db, id);
	if (receipt.transactionId || receipt.handledAt)
		throw new ValidationError('Deze bon is al verwerkt');
	db.transaction((tx) => {
		tx.update(receipts)
			.set({
				status: 'wordt_gelezen',
				failure: null,
				checkedFields: null,
				fieldConfidence: null,
				readAt: null
			})
			.where(eq(receipts.id, id))
			.run();
		enqueue(tx, READ_RECEIPT_JOB, now, { receiptId: id } satisfies ReadReceiptPayload);
	});
	runJobsSoon();
}

/**
 * Weggooien: de bon en het bestand verdwijnen. Een transactie die er al bij hoort blijft staan;
 * die is een echte uitgave.
 */
export async function deleteReceipt(db: DB, id: string): Promise<boolean> {
	const receipt = loadReceipt(db, id);
	if (!receipt) return false;
	db.transaction((tx) => {
		tx.delete(receipts).where(eq(receipts.id, id)).run();
		recordChange(tx, 'verwijderd', 'receipts', id, null, null);
	});
	await rm(receiptPath(receipt.fileId, receipt.mediaType), { force: true });
	return true;
}
