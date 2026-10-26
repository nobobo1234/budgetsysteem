import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { recordChange } from '../audit.ts';
import type { Conn, DB } from '../db/index.ts';
import { accounts, receiptItems, receipts, transactions } from '../db/schema.ts';
import { ValidationError } from '../errors.ts';
import { dateInRange } from '../validation.ts';
import { worst, type FieldStatus } from './checks.ts';
import { isItemComplete, planListItems, type ItemPlan } from './outcome.ts';
import {
	defaultAccountId,
	insertBonTransaction,
	loadReceipt,
	transactionCandidates,
	type LoadedReceipt,
	type ReceiptCandidate
} from './process.ts';
import { LIST_FIELDS, readItemConfidence, type StoredItemConfidence } from './stored.ts';

// Een screenshot van een bankapp met meerdere transacties (spec: Verwerking stap 6). De lezer
// zet de transacties in `receipt_items`; hier staan de koppellijst per transactie en het
// bevestigen in één keer. Een transactie die al in je cijfers staat (een geïmporteerde boeking
// of eigen invoer) wordt gekoppeld in plaats van dubbel geboekt; de rest wordt een nieuwe
// transactie met bron `bon`, die een latere bankimport via de koppellijst samenvoegt.

export interface ListItem {
	id: string;
	position: number;
	date: string | null;
	counterparty: string | null;
	/** Met teken (negatief is afgeschreven), in centen van `currency`. */
	amountCents: number | null;
	currency: string | null;
	confidence: StoredItemConfidence;
	/** Slechtste uitkomst van de vier velden. */
	outcome: FieldStatus;
	complete: boolean;
	/** Na bevestigen: de transactie die bij deze regel hoort; leeg als hij uitgevinkt was. */
	transactionId: string | null;
}

export interface ListItemWithMatch extends ListItem {
	candidates: ReceiptCandidate[];
	plan: ItemPlan;
}

function toItem(r: typeof receiptItems.$inferSelect): ListItem {
	const confidence = readItemConfidence(r.confidence);
	const item = {
		date: r.date,
		counterparty: r.counterparty,
		amountCents: r.amountCents,
		currency: r.currency
	};
	return {
		id: r.id,
		position: r.position,
		...item,
		confidence,
		outcome: worst(LIST_FIELDS.map((f) => confidence[f].status)),
		complete: isItemComplete(item),
		transactionId: r.transactionId
	};
}

export function loadListItems(db: Conn, receiptId: string): ListItem[] {
	return db
		.select()
		.from(receiptItems)
		.where(eq(receiptItems.receiptId, receiptId))
		.orderBy(asc(receiptItems.position))
		.all()
		.map(toItem);
}

/** Aantal transacties per screenshot, voor de lijst met bonnen. */
export function listItemCounts(db: Conn, receiptIds: string[]): Map<string, number> {
	if (receiptIds.length === 0) return new Map();
	const rows = db
		.select({ receiptId: receiptItems.receiptId, n: sql<number>`count(*)` })
		.from(receiptItems)
		.where(inArray(receiptItems.receiptId, receiptIds))
		.groupBy(receiptItems.receiptId)
		.all();
	return new Map(rows.map((r) => [r.receiptId, r.n]));
}

function candidatesFor(db: Conn, item: ListItem) {
	if (!item.complete) return { candidates: [], preselect: null };
	return transactionCandidates(
		db,
		{ amountCents: Math.abs(item.amountCents!), date: item.date!, name: item.counterparty! },
		{ currency: item.currency, incoming: item.amountCents! > 0 }
	);
}

/** De transacties van een screenshot met per regel de koppellijst en het voorstel. */
export function listWithMatches(db: Conn, receiptId: string): ListItemWithMatch[] {
	const items = loadListItems(db, receiptId);
	const ranked = items.map((item) => candidatesFor(db, item));
	const plans = planListItems(items.map((item, i) => ({ ...item, ranked: ranked[i]! })));
	return items.map((item, i) => ({
		...item,
		candidates: ranked[i]!.candidates,
		plan: plans[i]!
	}));
}

export type ListTarget = { kind: 'nieuw' } | { kind: 'koppelen'; transactionId: string };

export interface ListChoice {
	itemId: string;
	target: ListTarget;
}

function requireList(db: Conn, id: string): LoadedReceipt {
	const r = loadReceipt(db, id);
	if (!r) throw new ValidationError('Deze bon bestaat niet meer');
	if (r.status === 'wordt_gelezen') throw new ValidationError('Deze bon wordt nog gelezen');
	if (r.kind !== 'lijst') throw new ValidationError('Dit is geen lijst met transacties');
	if (r.handledAt !== null) throw new ValidationError('Deze lijst is al bevestigd');
	return r;
}

/**
 * Bevestigt een screenshot in één keer, in één database-transactie: elke aangevinkte regel wordt
 * gekoppeld aan een bestaande transactie uit zijn koppellijst, of een nieuwe transactie met bron
 * `bon` op `accountId`. Uitgevinkte regels blijven zonder transactie. Bij twijfel weigert hij
 * alles: een regel die niet (meer) past, een dubbele koppeling of een onvolledige regel.
 */
export function confirmList(
	db: DB,
	receiptId: string,
	choices: readonly ListChoice[],
	accountId: string | null,
	now = new Date()
): { created: number; linked: number } {
	return db.transaction((tx) => {
		requireList(tx, receiptId);
		if (choices.length === 0)
			throw new ValidationError('Vink minstens één transactie aan, of gooi het screenshot weg');
		const items = new Map(listWithMatches(tx, receiptId).map((i) => [i.id, i]));
		const used = new Set<string>();
		const seen = new Set<string>();
		for (const { itemId, target } of choices) {
			const item = items.get(itemId);
			if (!item || seen.has(itemId))
				throw new ValidationError('Deze regel hoort niet bij de lijst');
			seen.add(itemId);
			if (!item.complete || !dateInRange(item.date!))
				throw new ValidationError('Een aangevinkte regel is niet volledig gelezen');
			if (target.kind === 'koppelen') {
				if (!item.candidates.some((c) => c.id === target.transactionId))
					throw new ValidationError('Een koppeling past niet (meer); laad de pagina opnieuw');
				if (used.has(target.transactionId))
					throw new ValidationError('Twee regels horen bij dezelfde transactie; kies er één');
				used.add(target.transactionId);
			}
		}
		const needsAccount = choices.some((c) => c.target.kind === 'nieuw');
		if (
			needsAccount &&
			(!accountId ||
				!tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).get())
		)
			throw new ValidationError('Kies een rekening voor de nieuwe transacties');

		let created = 0;
		let linked = 0;
		for (const { itemId, target } of choices) {
			const item = items.get(itemId)!;
			let transactionId: string;
			if (target.kind === 'koppelen') {
				transactionId = target.transactionId;
				linked++;
			} else {
				// Je bevestigt elke regel zelf; alleen zonder eurobedrag blijft hij op te controleren
				transactionId = insertBonTransaction(tx, {
					amountCents: item.amountCents!,
					currency: item.currency!,
					date: item.date!,
					counterparty: item.counterparty!,
					accountId: accountId!,
					status: 'bevestigd'
				});
				created++;
			}
			tx.update(receiptItems)
				.set({ transactionId })
				.where(and(eq(receiptItems.id, itemId), eq(receiptItems.receiptId, receiptId)))
				.run();
		}
		tx.update(receipts)
			.set({ handledAt: now.toISOString() })
			.where(eq(receipts.id, receiptId))
			.run();
		recordChange(tx, 'verwerkt', 'receipts', receiptId, null, { created, linked });
		return { created, linked };
	});
}

/** Rekening voor nieuwe transacties uit een screenshot: Revolut zodra er vreemde valuta in staat. */
export function defaultListAccount(db: Conn, items: readonly ListItem[]): string | null {
	const foreign = items.find((i) => i.currency !== null && i.currency !== 'EUR');
	return defaultAccountId(db, foreign?.currency ?? 'EUR');
}

/** De transacties die bij een bevestigde lijst horen, zonder IBAN. */
export function linkedTransactions(db: Conn, items: readonly ListItem[]) {
	const ids = items.flatMap((i) => (i.transactionId ? [i.transactionId] : []));
	if (ids.length === 0) return new Map();
	const rows = db
		.select({
			id: transactions.id,
			counterparty: transactions.counterparty,
			date: transactions.date,
			amountCents: transactions.amountCents,
			origAmountCents: transactions.origAmountCents,
			origCurrency: transactions.origCurrency,
			source: transactions.source,
			status: transactions.status
		})
		.from(transactions)
		.where(inArray(transactions.id, ids))
		.all();
	return new Map(rows.map((r) => [r.id, r]));
}
