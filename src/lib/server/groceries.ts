import { and, eq, inArray, sql } from 'drizzle-orm';
import { shiftMonth } from '../dates.ts';
import {
	GROCERIES,
	groceryMonth,
	type GroceryLine,
	type GroceryMonth,
	type GroceryPurchase
} from '../groceries.ts';
import type { DB } from './db/index.ts';
import { categories, receiptLines, receipts } from './db/schema.ts';

// Boodschappen per productgroep (spec: Analyses → Boodschappen per productgroep): de uitgaven in
// de categorie Boodschappen, met per uitgave de regels van de bon die erbij hoort. Draait als
// SQL op de eigen server; bonregels gaan nooit los naar AI.

/** Zoveel maanden terug voor het gemiddelde. */
const HISTORY = 3;

export function groceriesCategoryId(db: DB): string | null {
	return (
		db.select({ id: categories.id }).from(categories).where(eq(categories.name, GROCERIES)).get()
			?.id ?? null
	);
}

/**
 * Uitgaven in Boodschappen van `from` tot en met `to` (maanden), per transactie. Gedeelde
 * uitgaven tellen via hun verdeling en een terugboeking telt bij de boeking die hij verrekent,
 * net als op Budget (`spendingByCategory`). Alleen een bon in euro telt mee voor de regels.
 */
export function groceryPurchases(
	db: DB,
	categoryId: string,
	from: string,
	to: string
): GroceryPurchase[] {
	const start = `${from}-01`;
	const end = `${to}-31`;
	const rows = db.all<{ id: string; date: string; counterparty: string; spent: number }>(sql`
		WITH booked AS (
			SELECT t.id AS root, t.id, t.category_id, t.amount_cents
			FROM transactions t
			WHERE t.date BETWEEN ${start} AND ${end}
				AND t.correction_of IS NULL
				AND t.status != 'verwacht'
			UNION ALL
			SELECT o.id AS root, t.id, t.category_id, t.amount_cents
			FROM transactions o
			JOIN transactions t ON t.correction_of = o.id
			WHERE o.date BETWEEN ${start} AND ${end} AND t.status != 'verwacht'
		),
		parts AS (
			SELECT b.root, b.category_id, b.amount_cents AS amount
			FROM booked b
			WHERE NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = b.id)
			UNION ALL
			SELECT b.root, s.category_id, s.amount_cents AS amount
			FROM transaction_splits s
			JOIN booked b ON b.id = s.transaction_id
		)
		SELECT p.root AS id, rt.date AS date, rt.counterparty AS counterparty, -SUM(p.amount) AS spent
		FROM parts p
		JOIN transactions rt ON rt.id = p.root
		WHERE p.category_id = ${categoryId}
		GROUP BY p.root
	`);
	const linesOf = linesByTransaction(
		db,
		rows.filter((r) => r.spent > 0).map((r) => r.id)
	);
	return rows.map((r) => ({
		id: r.id,
		month: r.date.slice(0, 7),
		spentCents: r.spent,
		lines: (linesOf.get(r.id) ?? []).map((l) => ({
			...l,
			date: r.date,
			counterparty: r.counterparty
		}))
	}));
}

type StoredLine = Omit<GroceryLine, 'date' | 'counterparty'>;

/**
 * De regels per transactie. Horen er twee bonnen bij dezelfde transactie (twee keer dezelfde bon
 * gestuurd), dan telt alleen de nieuwste. Een bon in vreemde valuta telt niet: zijn regels staan
 * niet in euro.
 */
function linesByTransaction(db: DB, ids: string[]): Map<string, StoredLine[]> {
	const out = new Map<string, StoredLine[]>();
	if (ids.length === 0) return out;
	const rows: {
		transactionId: string | null;
		receiptId: string;
		createdAt: string;
		id: string;
		description: string;
		kind: StoredLine['kind'];
		cents: number;
		group: StoredLine['group'];
		position: number;
	}[] = [];
	// In stukken, zodat het aantal parameters binnen de grens van SQLite blijft
	for (let i = 0; i < ids.length; i += 500) {
		rows.push(
			...db
				.select({
					transactionId: receipts.transactionId,
					receiptId: receipts.id,
					createdAt: receipts.createdAt,
					id: receiptLines.id,
					description: receiptLines.description,
					kind: receiptLines.kind,
					cents: receiptLines.amountCents,
					group: receiptLines.productGroup,
					position: receiptLines.position
				})
				.from(receiptLines)
				.innerJoin(receipts, eq(receipts.id, receiptLines.receiptId))
				.where(
					and(
						eq(receipts.kind, 'bon'),
						inArray(receipts.transactionId, ids.slice(i, i + 500)),
						sql`NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = ${receipts.transactionId}
							AND t.orig_currency IS NOT NULL)`
					)
				)
				.all()
		);
	}
	// Per transactie de nieuwste bon
	const newest = new Map<string, { receiptId: string; createdAt: string }>();
	for (const r of rows) {
		const seen = newest.get(r.transactionId!);
		if (
			!seen ||
			r.createdAt > seen.createdAt ||
			(r.createdAt === seen.createdAt && r.receiptId > seen.receiptId)
		)
			newest.set(r.transactionId!, { receiptId: r.receiptId, createdAt: r.createdAt });
	}
	for (const r of rows.toSorted((a, b) => a.position - b.position)) {
		if (newest.get(r.transactionId!)?.receiptId !== r.receiptId) continue;
		const list = out.get(r.transactionId!) ?? [];
		list.push({
			id: r.id,
			receiptId: r.receiptId,
			description: r.description,
			kind: r.kind,
			cents: r.cents,
			group: r.group
		});
		out.set(r.transactionId!, list);
	}
	return out;
}

export interface GroceryOverview extends GroceryMonth {
	/** Er is geen categorie Boodschappen (hernoemd of weg). */
	missingCategory: boolean;
}

/** Het overzicht van een maand, met de drie maanden ervoor voor het gemiddelde. */
export function groceryOverview(db: DB, month: string): GroceryOverview {
	const categoryId = groceriesCategoryId(db);
	const purchases = categoryId
		? groceryPurchases(db, categoryId, shiftMonth(month, -HISTORY), month)
		: [];
	return { ...groceryMonth(purchases, month), missingCategory: categoryId === null };
}
