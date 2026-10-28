import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
	addYears,
	DEFAULT_LIFETIME_YEARS,
	fullyRefunded,
	isProposal,
	nextEnd,
	WARRANTY_MIN_CENTS
} from '../warranty.ts';
import { recordChange } from './audit.ts';
import type { Conn, DB } from './db/index.ts';
import { categories, receipts, transactions, warranties } from './db/schema.ts';
import { ValidationError } from './errors.ts';

// Garantie (spec: Garantie). Een voorstel volgt live uit de transacties: een bevestigde uitgave
// vanaf de drempel (jouw deel) in een categorie met "garantie bijhouden", zonder rij in
// `warranties`. Bevestigen maakt een actieve garantie, afwijzen een rij `afgewezen`, zodat hij
// niet terugkomt. Zo haalt een retour of een andere categorie het voorstel vanzelf weg.
// Productnamen zijn je eigen tekst: alleen als gewone tekst tonen, nooit in een logregel.

export interface WarrantyProposal {
	transactionId: string;
	date: string;
	counterparty: string;
	amountCents: number;
	/** Jouw deel in categorieën met garantie, positief */
	shareCents: number;
	categoryName: string | null;
	categoryGroup: string | null;
}

interface ProposalRow {
	id: string;
	date: string;
	counterparty: string;
	amountCents: number;
	status: 'bevestigd' | 'verwacht' | 'te_controleren';
	categoryName: string | null;
	categoryGroup: string | null;
	shareCents: number;
	refundedCents: number;
}

/**
 * Jouw deel in categorieën met garantie: bij een verdeling (voorgeschoten) de regels in zo'n
 * categorie, anders de hele uitgave als de categorie garantie bijhoudt. Net als bij Budget.
 */
const shareSql = sql`CASE
	WHEN EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id)
	THEN COALESCE((
		SELECT -SUM(s.amount_cents) FROM transaction_splits s
		JOIN categories sc ON sc.id = s.category_id
		WHERE s.transaction_id = t.id AND sc.tracks_warranty = 1
	), 0)
	WHEN c.tracks_warranty = 1 THEN -t.amount_cents
	ELSE 0
END`;

const refundedSql = sql`COALESCE((
	SELECT SUM(ABS(r.amount_cents)) FROM transactions r WHERE r.correction_of = t.id
), 0)`;

/** Voorstellen voor de review-inbox, nieuwste eerst. */
export function warrantyProposals(
	db: Conn,
	today: string,
	minCents = WARRANTY_MIN_CENTS
): WarrantyProposal[] {
	const rows = db.all<ProposalRow>(sql`
		SELECT t.id, t.date, t.counterparty, t.amount_cents AS amountCents, t.status,
			c.name AS categoryName, c."group" AS categoryGroup,
			${shareSql} AS shareCents, ${refundedSql} AS refundedCents
		FROM transactions t
		LEFT JOIN categories c ON c.id = t.category_id
		WHERE t.amount_cents <= ${-minCents}
			AND t.correction_of IS NULL
			AND t.status = 'bevestigd'
			AND t.date >= ${addYears(today, -1)}
			AND NOT EXISTS (SELECT 1 FROM warranties w WHERE w.transaction_id = t.id)
		ORDER BY t.date DESC, t.created_at DESC
	`);
	return rows
		.filter((r) => isProposal({ ...r, decided: false }, today, minCents))
		.map((r) => ({
			transactionId: r.id,
			date: r.date,
			counterparty: r.counterparty,
			amountCents: r.amountCents,
			shareCents: r.shareCents,
			categoryName: r.categoryName,
			categoryGroup: r.categoryGroup
		}));
}

export interface RefundedWarranty {
	id: string;
	product: string;
	counterparty: string;
	amountCents: number;
	date: string;
}

/** Sleutel in het audit-log voor "laten staan" bij een retour op een actieve garantie. */
export const leftKey = (id: string) => `garantie:${id}`;

/**
 * Actieve garanties waarvan de uitgave helemaal terugkwam (retour of storno): is het product weg?
 * Wat je liet staan, komt niet terug.
 */
export function refundedWarranties(db: Conn): RefundedWarranty[] {
	const rows = db.all<RefundedWarranty & { refundedCents: number }>(sql`
		SELECT w.id, w.product, t.counterparty, t.amount_cents AS amountCents, t.date,
			${refundedSql} AS refundedCents
		FROM warranties w
		JOIN transactions t ON t.id = w.transaction_id
		WHERE w.status = 'actief'
			AND NOT EXISTS (
				SELECT 1 FROM audit_log a
				WHERE a.entity = 'review' AND a.action = 'laten_staan'
					AND a.entity_id = 'garantie:' || w.id
			)
		ORDER BY t.date DESC
	`);
	return rows.filter(fullyRefunded).map(({ refundedCents: _r, ...w }) => w);
}

/** Laten staan: het product is er nog, ook al kwam het geld terug. */
export function keepRefunded(db: DB, id: string): void {
	db.transaction((tx) => {
		if (!refundedWarranties(tx).some((w) => w.id === id))
			throw new ValidationError('Deze garantie staat niet meer te controleren');
		recordChange(tx, 'laten_staan', 'review', leftKey(id), null, null);
	});
}

// --- Aanmaken, wijzigen, afdanken -------------------------------------------------------------

export interface WarrantyFields {
	product: string;
	deliveryDate: string;
	factoryUntil: string | null;
	lifetimeYears: number;
}

export interface NewWarranty extends Partial<Omit<WarrantyFields, 'product'>> {
	transactionId: string;
	product: string;
	/** Vanaf de bonpagina; anders de bon die bij de transactie hoort, als die er is */
	receiptId?: string | null;
}

function expense(db: Conn, transactionId: string) {
	const tx = db.select().from(transactions).where(eq(transactions.id, transactionId)).get();
	if (!tx) throw new ValidationError('Deze transactie bestaat niet meer');
	if (tx.amountCents >= 0 || tx.correctionOf)
		throw new ValidationError('Garantie hoort bij een uitgave');
	if (tx.status === 'verwacht') throw new ValidationError('Deze uitgave is nog niet bevestigd');
	return tx;
}

/** Een kassabon bij deze transactie: het bewijs voor de garantie. */
function receiptOf(db: Conn, transactionId: string): string | null {
	return (
		db
			.select({ id: receipts.id })
			.from(receipts)
			.where(and(eq(receipts.transactionId, transactionId), eq(receipts.kind, 'bon')))
			.orderBy(asc(receipts.createdAt))
			.get()?.id ?? null
	);
}

/** Garantie bijhouden: vanuit een voorstel, een transactie of een bon. */
export function createWarranty(db: DB, input: NewWarranty): string {
	return db.transaction((tx) => {
		const t = expense(tx, input.transactionId);
		if (input.receiptId) {
			const r = tx
				.select({ transactionId: receipts.transactionId, kind: receipts.kind })
				.from(receipts)
				.where(eq(receipts.id, input.receiptId))
				.get();
			if (!r || r.kind !== 'bon' || r.transactionId !== t.id)
				throw new ValidationError('Deze bon hoort niet bij de transactie');
		}
		// Een eerder afgewezen voorstel is met deze keuze ingehaald
		tx.delete(warranties)
			.where(and(eq(warranties.transactionId, t.id), eq(warranties.status, 'afgewezen')))
			.run();
		const row = tx
			.insert(warranties)
			.values({
				product: input.product,
				transactionId: t.id,
				receiptId: input.receiptId ?? receiptOf(tx, t.id),
				purchaseDate: t.date,
				deliveryDate: input.deliveryDate ?? t.date,
				factoryUntil: input.factoryUntil ?? null,
				lifetimeYears: input.lifetimeYears ?? DEFAULT_LIFETIME_YEARS,
				status: 'actief'
			})
			.returning()
			.get();
		recordChange(tx, 'aangemaakt', 'warranties', row.id, null, row);
		return row.id;
	});
}

/** Een voorstel afwijzen: komt niet terug. */
export function rejectProposal(db: DB, transactionId: string, today: string): void {
	db.transaction((tx) => {
		if (!warrantyProposals(tx, today).some((p) => p.transactionId === transactionId))
			throw new ValidationError('Dit voorstel staat er niet meer');
		const t = expense(tx, transactionId);
		const row = tx
			.insert(warranties)
			.values({
				transactionId,
				purchaseDate: t.date,
				deliveryDate: t.date,
				lifetimeYears: DEFAULT_LIFETIME_YEARS,
				status: 'afgewezen'
			})
			.returning()
			.get();
		recordChange(tx, 'afgewezen', 'warranties', row.id, null, row);
	});
}

function activeRow(db: Conn, id: string) {
	const row = db.select().from(warranties).where(eq(warranties.id, id)).get();
	if (!row || row.status === 'afgewezen') return null;
	return row;
}

export function updateWarranty(db: DB, id: string, patch: WarrantyFields): boolean {
	return db.transaction((tx) => {
		const before = activeRow(tx, id);
		if (!before) return false;
		if (before.status === 'afgedankt')
			throw new ValidationError('Een afgedankt product wijzig je niet meer');
		const after = tx
			.update(warranties)
			.set({ ...patch, updatedAt: new Date().toISOString() })
			.where(eq(warranties.id, id))
			.returning()
			.get();
		recordChange(tx, 'gewijzigd', 'warranties', id, before, after);
		return true;
	});
}

/** Afdanken: geen meldingen meer, en de bon mag weg. */
export function discardWarranty(db: DB, id: string, now = new Date()): boolean {
	return db.transaction((tx) => {
		const before = activeRow(tx, id);
		if (!before) return false;
		if (before.status === 'afgedankt') return true;
		const after = tx
			.update(warranties)
			.set({ status: 'afgedankt', discardedAt: now.toISOString(), updatedAt: now.toISOString() })
			.where(eq(warranties.id, id))
			.returning()
			.get();
		recordChange(tx, 'afgedankt', 'warranties', id, before, after);
		return true;
	});
}

// --- Bewijs bewaren --------------------------------------------------------------------------

/**
 * Een transactie of bon bij een actieve garantie is het bewijs: die gooi je pas weg nadat je het
 * product afdankt (spec: Garantie → Bewijs).
 */
export function assertNoActiveWarranty(
	db: Conn,
	target: { transactionId: string } | { receiptId: string }
): void {
	let active: { product: string } | undefined;
	if ('transactionId' in target) {
		active = db
			.select({ product: warranties.product })
			.from(warranties)
			.where(
				and(eq(warranties.transactionId, target.transactionId), eq(warranties.status, 'actief'))
			)
			.get();
	} else {
		const r = db
			.select({ transactionId: receipts.transactionId })
			.from(receipts)
			.where(eq(receipts.id, target.receiptId))
			.get();
		active = db
			.select({ product: warranties.product })
			.from(warranties)
			.where(
				and(
					eq(warranties.status, 'actief'),
					r?.transactionId
						? sql`(${warranties.receiptId} = ${target.receiptId} OR ${warranties.transactionId} = ${r.transactionId})`
						: eq(warranties.receiptId, target.receiptId)
				)
			)
			.get();
	}
	if (active)
		throw new ValidationError(
			`Dit is het bewijs voor de garantie op ${active.product}; dank het product eerst af`
		);
}

/** Bij het samenvoegen van een bankboeking met je eigen invoer gaat de garantie mee. */
export function moveWarranties(db: Conn, fromId: string, toId: string): void {
	db.update(warranties)
		.set({ transactionId: toId })
		.where(eq(warranties.transactionId, fromId))
		.run();
}

// --- Lezen -----------------------------------------------------------------------------------

const listColumns = {
	id: warranties.id,
	product: warranties.product,
	transactionId: warranties.transactionId,
	receiptId: warranties.receiptId,
	purchaseDate: warranties.purchaseDate,
	deliveryDate: warranties.deliveryDate,
	factoryUntil: warranties.factoryUntil,
	lifetimeYears: warranties.lifetimeYears,
	status: warranties.status,
	note: warranties.note,
	discardedAt: warranties.discardedAt,
	counterparty: transactions.counterparty,
	amountCents: transactions.amountCents,
	categoryGroup: categories.group
};

export type WarrantyRow = {
	id: string;
	product: string;
	transactionId: string;
	receiptId: string | null;
	purchaseDate: string;
	deliveryDate: string;
	factoryUntil: string | null;
	lifetimeYears: number;
	status: 'actief' | 'afgedankt';
	note: string;
	discardedAt: string | null;
	counterparty: string;
	amountCents: number;
	categoryGroup: string | null;
};

function selectRows(db: Conn) {
	return db
		.select(listColumns)
		.from(warranties)
		.innerJoin(transactions, eq(transactions.id, warranties.transactionId))
		.leftJoin(categories, eq(categories.id, transactions.categoryId));
}

/**
 * Garantie (spec: Schermen): eerst wat binnenkort afloopt, dan de rest (nieuwste aankoop eerst),
 * en de afgedankte apart.
 */
export function listWarranties(db: Conn, today: string) {
	const rows = selectRows(db)
		.where(ne(warranties.status, 'afgewezen'))
		.orderBy(desc(warranties.purchaseDate), desc(warranties.createdAt))
		.all() as WarrantyRow[];
	const active = rows
		.filter((r) => r.status === 'actief')
		.map((r) => ({ ...r, soon: nextEnd(r, today) }));
	return {
		soon: active
			.filter((r) => r.soon)
			.sort((a, b) => a.soon!.endDate.localeCompare(b.soon!.endDate)),
		rest: active.filter((r) => !r.soon),
		discarded: rows.filter((r) => r.status === 'afgedankt')
	};
}

export function warrantyDetail(db: Conn, id: string) {
	const row = selectRows(db)
		.where(and(eq(warranties.id, id), ne(warranties.status, 'afgewezen')))
		.get() as WarrantyRow | undefined;
	if (!row) return null;
	// De bon die je erbij koos, of anders een bon die later aan de transactie gekoppeld is
	return { ...row, receiptId: row.receiptId ?? receiptOf(db, row.transactionId) };
}

/** Op de transactie of bon: welke producten erbij horen. */
export function warrantiesOf(db: Conn, transactionIds: readonly string[]) {
	if (transactionIds.length === 0) return [];
	return db
		.select({ id: warranties.id, product: warranties.product, status: warranties.status })
		.from(warranties)
		.where(
			and(
				inArray(warranties.transactionId, [...transactionIds]),
				ne(warranties.status, 'afgewezen')
			)
		)
		.orderBy(asc(warranties.createdAt))
		.all() as { id: string; product: string; status: 'actief' | 'afgedankt' }[];
}

/** Actieve garanties met hun datums en winkel, voor de meldingen. */
export function activeWarranties(db: Conn): WarrantyRow[] {
	return selectRows(db).where(eq(warranties.status, 'actief')).all() as WarrantyRow[];
}

/** Voor de tegel op Meer. */
export function warrantyTile(db: Conn, today: string) {
	const active = activeWarranties(db);
	return {
		active: active.length,
		soon: active.filter((w) => nextEnd(w, today)).length
	};
}
