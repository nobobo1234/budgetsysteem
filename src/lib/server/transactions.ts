import { and, desc, eq, gte, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { advancePast } from '../recurring.ts';
import { recordChange } from './audit.ts';
import type { Conn, DB } from './db/index.ts';
import {
	accounts,
	categories,
	owedPayments,
	recurring,
	reservations,
	transactionSplits,
	transactions
} from './db/schema.ts';
import { ValidationError } from './errors.ts';
import {
	applyShare,
	dropSourcePosts,
	MY_SHARE,
	recomputeStatus,
	settlePayment,
	shareFromNames,
	unlinkPayment
} from './owed.ts';
import { dateInRange, type NewTransaction, type TransactionPatch } from './validation.ts';

export { ValidationError };

function categoryExists(db: Conn, id: string): boolean {
	return (
		db.select({ id: categories.id }).from(categories).where(eq(categories.id, id)).get() !==
		undefined
	);
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
		let row = tx
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

		// Alleen jouw deel telt in de categorie; de rest is voorgeschoten (Te krijgen)
		if (input.share)
			applyShare(tx, row.id, shareFromNames(tx, input.share.people, input.share.with));

		// Ontvangen of terugbetaald. Is de gekozen post intussen weg (offline ingevoerd), dan
		// niet raden: de transactie blijft staan en komt bij te controleren.
		if (input.settle && !settlePayment(tx, row.id, input.settle)) {
			row = tx
				.update(transactions)
				.set({ status: 'te_controleren' })
				.where(eq(transactions.id, row.id))
				.returning()
				.get();
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
				.where(and(eq(transactionSplits.transactionId, id), eq(transactionSplits.note, MY_SHARE)))
				.run();
		}
		// Een gekoppelde betaling met een ander bedrag wordt opnieuw over de posten verdeeld
		if (patch.amountCents !== undefined && patch.amountCents !== before.amountCents) {
			const links = tx
				.select({ personId: owedPayments.personId, owedId: owedPayments.owedId })
				.from(owedPayments)
				.where(eq(owedPayments.transactionId, id))
				.all();
			if (links.length > 0) {
				const first = links.find((l) => l.owedId)?.owedId ?? null;
				if (!settlePayment(tx, id, { personId: links[0]!.personId, owedId: first }))
					unlinkPayment(tx, id);
			}
		}
		recordChange(tx, 'gewijzigd', 'transactions', id, before, after);
		return true;
	});
}

type RecurringRow = typeof recurring.$inferSelect;
type Transaction = typeof transactions.$inferSelect;

/** Wat er aan een vaste last verandert als een van zijn posten verdwijnt. */
function afterRemoval(db: Conn, r: RecurringRow, t: Transaction): Partial<RecurringRow> {
	const patch: Partial<RecurringRow> = advancePast(r, t.date);
	if (t.status !== 'bevestigd') return patch;
	const newer = db
		.select({ id: transactions.id })
		.from(transactions)
		.where(
			and(
				eq(transactions.recurringId, r.id),
				eq(transactions.status, 'bevestigd'),
				ne(transactions.id, t.id),
				gte(transactions.date, t.date)
			)
		)
		.get();
	if (newer) return patch;
	// Dit was de laatste afschrijving: wat hij aan de vaste last veranderde, gaat terug
	const cents = -t.amountCents;
	if (r.signal && r.signalToCents === cents) {
		if (r.signal === 'prijsverhoging' && r.signalFromCents !== null)
			patch.medianCents = r.signalFromCents;
		patch.signal = null;
		patch.signalFromCents = null;
		patch.signalToCents = null;
	}
	const previous = db
		.select({ amountCents: transactions.amountCents })
		.from(transactions)
		.where(
			and(
				eq(transactions.recurringId, r.id),
				eq(transactions.status, 'bevestigd'),
				ne(transactions.id, t.id)
			)
		)
		.orderBy(desc(transactions.date))
		.get();
	if (previous) patch.lastCents = -previous.amountCents;
	else if (r.signalFromCents !== null && patch.signal === null) patch.lastCents = r.signalFromCents;
	return patch;
}

export function deleteTransaction(db: DB, id: string): boolean {
	return db.transaction((tx) => {
		const before = tx.select().from(transactions).where(eq(transactions.id, id)).get();
		if (!before) return false;
		dropSourcePosts(tx, id);
		// Was dit een betaling, dan gaan de posten die hij dekte weer open
		const covered = unlinkPayment(tx, id);
		// Een afschrijving van een uitgesmeerde vaste last: de reservering staat weer opzij
		tx.update(reservations)
			.set({ drawnCents: 0, transactionId: null })
			.where(eq(reservations.transactionId, id))
			.run();
		if (before.recurringId) {
			const r = tx.select().from(recurring).where(eq(recurring.id, before.recurringId)).get();
			// Een post weggooien is "deze keer niet": de vaste last schuift door. Een bevestigde
			// afschrijving telt daarna niet meer als laatste bedrag of als prijsverhoging.
			if (r)
				tx.update(recurring)
					.set(afterRemoval(tx, r, before))
					.where(eq(recurring.id, r.id))
					.run();
		}
		tx.delete(transactions).where(eq(transactions.id, id)).run();
		recomputeStatus(tx, covered);
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
