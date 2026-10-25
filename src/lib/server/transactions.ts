import { and, desc, eq, gte, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { splitShare } from '../quickentry/parser.ts';
import { recordChange } from './audit.ts';
import type { Conn, DB } from './db/index.ts';
import { accounts, categories, owed, transactionSplits, transactions } from './db/schema.ts';
import { dateInRange, type NewTransaction, type TransactionPatch } from './validation.ts';

export class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ValidationError';
	}
}

const REFUND_CATEGORY = 'Terugbetaling';

function categoryExists(db: Conn, id: string): boolean {
	return (
		db.select({ id: categories.id }).from(categories).where(eq(categories.id, id)).get() !==
		undefined
	);
}

/** Verdeelt een bedrag zo gelijk mogelijk over `n` delen; samen exact het totaal. */
function divide(total: number, n: number): number[] {
	const base = Math.floor(total / n);
	const rest = total - base * n;
	return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}

/**
 * Slaat een handmatige transactie op. Idempotent op het ID van de client: dezelfde post
 * twee keer versturen (offline wachtrij) levert één transactie op.
 */
export function createTransaction(
	db: DB,
	input: NewTransaction,
	today?: string
): { id: string; created: boolean } {
	if (!dateInRange(input.date, today)) throw new ValidationError('Datum ligt te ver weg');
	if (input.categoryId && !categoryExists(db, input.categoryId)) {
		throw new ValidationError('Onbekende categorie');
	}
	const account = db
		.select({ id: accounts.id })
		.from(accounts)
		.where(eq(accounts.id, input.accountId))
		.get();
	if (!account) throw new ValidationError('Onbekende rekening');

	return db.transaction((tx) => {
		const existing = tx
			.select({ id: transactions.id })
			.from(transactions)
			.where(eq(transactions.id, input.id))
			.get();
		if (existing) return { id: existing.id, created: false };

		const status = input.amountCents === 0 ? 'te_controleren' : 'bevestigd';
		const row = tx
			.insert(transactions)
			.values({
				id: input.id,
				amountCents: input.amountCents,
				date: input.date,
				counterparty: input.counterparty,
				description: input.description,
				categoryId: input.categoryId,
				categorySource: input.categoryId ? 'handmatig' : null,
				accountId: input.accountId,
				source: 'handmatig',
				origAmountCents: input.origAmountCents,
				origCurrency: input.origCurrency,
				status,
				note: input.note
			})
			.returning()
			.get();

		if (input.share) {
			// Alleen jouw deel telt in de categorie; de rest is voorgeschoten (Te krijgen)
			const total = -input.amountCents;
			const { mine, others } = splitShare(total, input.share.people);
			const refund = tx
				.select({ id: categories.id })
				.from(categories)
				.where(eq(categories.name, REFUND_CATEGORY))
				.get();
			tx.insert(transactionSplits)
				.values([
					{
						transactionId: row.id,
						categoryId: input.categoryId,
						amountCents: -mine,
						note: 'Mijn deel'
					},
					{
						transactionId: row.id,
						categoryId: refund?.id ?? null,
						amountCents: -others,
						note: 'Voorgeschoten'
					}
				])
				.run();

			const people =
				input.share.with.length > 0 ? input.share.with : [`${input.share.people - 1} anderen`];
			const amounts = input.share.with.length > 0 ? divide(others, people.length) : [others];
			tx.insert(owed)
				.values(
					people.map((person, i) => ({
						person,
						amountCents: amounts[i]!,
						direction: 'te_krijgen' as const,
						sourceTransactionId: row.id
					}))
				)
				.run();
		}

		recordChange(tx, 'aangemaakt', 'transactions', row.id, null, row);
		return { id: row.id, created: true };
	});
}

export function updateTransaction(
	db: DB,
	id: string,
	patch: TransactionPatch,
	today?: string
): boolean {
	if (patch.date && !dateInRange(patch.date, today))
		throw new ValidationError('Datum ligt te ver weg');
	if (patch.categoryId && !categoryExists(db, patch.categoryId)) {
		throw new ValidationError('Onbekende categorie');
	}
	return db.transaction((tx) => {
		const before = tx.select().from(transactions).where(eq(transactions.id, id)).get();
		if (!before) return false;
		const hasSplits =
			tx
				.select({ id: transactionSplits.id })
				.from(transactionSplits)
				.where(eq(transactionSplits.transactionId, id))
				.get() !== undefined;
		if (hasSplits && patch.amountCents !== undefined && patch.amountCents !== before.amountCents) {
			throw new ValidationError('Het bedrag van een gedeelde uitgave pas je aan via de verdeling');
		}
		const status =
			before.status === 'te_controleren' && patch.amountCents !== undefined
				? 'bevestigd'
				: before.status;
		// Een zelf gekozen categorie is handmatig: regels blijven er voortaan af. Kies je geen
		// categorie, dan mogen regels hem weer invullen.
		const category =
			patch.categoryId !== undefined && patch.categoryId !== before.categoryId
				? {
						categorySource: patch.categoryId ? ('handmatig' as const) : null,
						categoryRuleId: null
					}
				: {};
		const after = tx
			.update(transactions)
			.set({ ...patch, ...category, status, updatedAt: new Date().toISOString() })
			.where(eq(transactions.id, id))
			.returning()
			.get();
		if (hasSplits && patch.categoryId !== undefined) {
			tx.update(transactionSplits)
				.set({ categoryId: patch.categoryId })
				.where(
					and(eq(transactionSplits.transactionId, id), eq(transactionSplits.note, 'Mijn deel'))
				)
				.run();
		}
		recordChange(tx, 'gewijzigd', 'transactions', id, before, after);
		return true;
	});
}

export function deleteTransaction(db: DB, id: string): boolean {
	return db.transaction((tx) => {
		const before = tx.select().from(transactions).where(eq(transactions.id, id)).get();
		if (!before) return false;
		// Openstaande posten van deze uitgave vervallen; (deels) betaalde blijven als historie
		tx.delete(owed)
			.where(and(eq(owed.sourceTransactionId, id), eq(owed.status, 'open')))
			.run();
		tx.delete(transactions).where(eq(transactions.id, id)).run();
		recordChange(tx, 'verwijderd', 'transactions', id, before, null);
		return true;
	});
}

export interface ListFilter {
	q?: string;
	month?: string;
	categoryId?: string | 'geen';
	status?: 'bevestigd' | 'verwacht' | 'te_controleren';
	accountId?: string;
	/** Datums `YYYY-MM-DD`, beide inclusief */
	from?: string;
	to?: string;
	limit?: number;
	offset?: number;
}

function likePattern(q: string): string {
	return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function filterWhere(filter: ListFilter): SQL | undefined {
	const where: SQL[] = [];
	const q = filter.q?.trim().slice(0, 100);
	if (q) {
		const p = likePattern(q);
		where.push(
			or(
				sql`${transactions.counterparty} LIKE ${p} ESCAPE '\\'`,
				sql`${transactions.description} LIKE ${p} ESCAPE '\\'`,
				sql`${transactions.note} LIKE ${p} ESCAPE '\\'`
			)!
		);
	}
	if (filter.month) {
		where.push(
			gte(transactions.date, `${filter.month}-01`),
			lte(transactions.date, `${filter.month}-31`)
		);
	}
	if (filter.categoryId === 'geen') where.push(isNull(transactions.categoryId));
	else if (filter.categoryId) where.push(eq(transactions.categoryId, filter.categoryId));
	if (filter.status) where.push(eq(transactions.status, filter.status));
	if (filter.accountId) where.push(eq(transactions.accountId, filter.accountId));
	if (filter.from) where.push(gte(transactions.date, filter.from));
	if (filter.to) where.push(lte(transactions.date, filter.to));
	return and(...where);
}

export function listTransactions(db: DB, filter: ListFilter = {}) {
	return db
		.select({
			id: transactions.id,
			amountCents: transactions.amountCents,
			date: transactions.date,
			counterparty: transactions.counterparty,
			description: transactions.description,
			categoryId: transactions.categoryId,
			categoryName: categories.name,
			categoryGroup: categories.group,
			accountAlias: accounts.alias,
			source: transactions.source,
			status: transactions.status,
			origAmountCents: transactions.origAmountCents,
			origCurrency: transactions.origCurrency,
			note: transactions.note
		})
		.from(transactions)
		.leftJoin(categories, eq(categories.id, transactions.categoryId))
		.innerJoin(accounts, eq(accounts.id, transactions.accountId))
		.where(filterWhere(filter))
		.orderBy(desc(transactions.date), desc(transactions.createdAt))
		.limit(Math.min(filter.limit ?? 50, 200))
		.offset(Math.max(0, filter.offset ?? 0))
		.all();
}

export type TransactionRow = ReturnType<typeof listTransactions>[number];

/** Aantal en totalen voor alles wat het filter vindt, over alle pagina's heen. */
export function summarizeTransactions(db: DB, filter: Omit<ListFilter, 'limit' | 'offset'> = {}) {
	const row = db
		.select({
			count: sql<number>`count(*)`,
			inCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} > 0 then ${transactions.amountCents} end), 0)`,
			outCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} < 0 then ${transactions.amountCents} end), 0)`
		})
		.from(transactions)
		.where(filterWhere(filter))
		.get();
	return { count: row?.count ?? 0, inCents: row?.inCents ?? 0, outCents: row?.outCents ?? 0 };
}

/** Maanden (`YYYY-MM`) waarin transacties staan, de nieuwste eerst. */
export function transactionMonths(db: DB): string[] {
	return db
		.selectDistinct({ month: sql<string>`substr(${transactions.date}, 1, 7)` })
		.from(transactions)
		.orderBy(desc(sql`substr(${transactions.date}, 1, 7)`))
		.all()
		.map((r) => r.month);
}

/** Bekende tegenpartijen, de vaakst gebruikte eerst. Voor het koppelen van snelinvoer. */
export function knownCounterparties(db: DB, limit = 300): string[] {
	return db
		.select({ name: transactions.counterparty, n: sql<number>`count(*)` })
		.from(transactions)
		.where(sql`${transactions.counterparty} != ''`)
		.groupBy(transactions.counterparty)
		.orderBy(desc(sql`count(*)`), desc(sql`max(${transactions.date})`))
		.limit(limit)
		.all()
		.map((r) => r.name);
}

export function reviewCount(db: DB): number {
	return (
		db
			.select({ n: sql<number>`count(*)` })
			.from(transactions)
			.where(eq(transactions.status, 'te_controleren'))
			.get()?.n ?? 0
	);
}
