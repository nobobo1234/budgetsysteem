import { and, asc, desc, eq, exists, inArray, like, or } from 'drizzle-orm';
import {
	checkedInMonth,
	checkResults,
	expectedBalance,
	type BalanceAnchor,
	type BalanceEntry,
	type CheckResult
} from '../balance.ts';
import { recordChange } from './audit.ts';
import type { Conn, DB } from './db/index.ts';
import { accounts, balanceAnchors, balanceChecks, transactions } from './db/schema.ts';

// Saldocheck (spec: Dagelijks gebruik): per rekening een startsaldo als anker, eens per maand het
// echte saldo, en het verschil met wat de app verwacht. De rekenregels staan in `src/lib/balance.ts`.

/** Hoeveel eerdere checks per rekening het scherm toont. */
const HISTORY = 6;

function entriesFor(db: Conn, accountId: string): BalanceEntry[] {
	return db
		.select({
			accountId: transactions.accountId,
			date: transactions.date,
			amountCents: transactions.amountCents,
			status: transactions.status
		})
		.from(transactions)
		.where(eq(transactions.accountId, accountId))
		.all();
}

export interface AccountBalance {
	account: { id: string; name: string; kind: 'sns' | 'revolut' | 'anders' };
	anchor: (BalanceAnchor & { source: 'import' | 'handmatig' }) | null;
	/** Verwacht saldo vandaag; `null` zonder anker */
	expectedTodayCents: number | null;
	checks: CheckResult[];
	checkedThisMonth: boolean;
	/** Posten van deze rekening die je nog moet controleren: hun bedrag kan nog veranderen */
	reviewCount: number;
}

/** Per rekening het anker, het verwachte saldo van vandaag en de laatste checks met hun verschil. */
export function balanceOverview(db: DB, today: string): AccountBalance[] {
	const anchors = new Map(
		db
			.select()
			.from(balanceAnchors)
			.all()
			.map((a) => [a.accountId, a])
	);
	const month = today.slice(0, 7);
	return db
		.select({ id: accounts.id, name: accounts.name, kind: accounts.kind })
		.from(accounts)
		.orderBy(asc(accounts.createdAt))
		.all()
		.map((account) => {
			const row = anchors.get(account.id);
			const anchor = row
				? {
						accountId: account.id,
						date: row.date,
						amountCents: row.amountCents,
						source: row.source
					}
				: null;
			const checks = db
				.select({ date: balanceChecks.date, amountCents: balanceChecks.amountCents })
				.from(balanceChecks)
				.where(eq(balanceChecks.accountId, account.id))
				.orderBy(desc(balanceChecks.date))
				.all();
			const entries = entriesFor(db, account.id);
			return {
				account,
				anchor,
				expectedTodayCents: anchor ? expectedBalance(anchor, entries, today) : null,
				checks: anchor ? checkResults(anchor, entries, checks).slice(0, HISTORY) : [],
				checkedThisMonth: checkedInMonth(checks, month),
				reviewCount: entries.filter((e) => e.status === 'te_controleren').length
			};
		});
}

/**
 * Rekeningen waarvan het saldo deze maand nog niet gecontroleerd is. Alleen rekeningen die in
 * gebruik zijn: met een startsaldo of met boekingen. Aanhaakpunt voor de herinnering op het
 * startscherm en voor een pushmelding.
 */
export function balanceCheckDue(db: Conn, today: string): { id: string; name: string }[] {
	const month = today.slice(0, 7);
	const inUse = db
		.select({ id: accounts.id, name: accounts.name })
		.from(accounts)
		.where(
			or(
				exists(
					db
						.select({ id: balanceAnchors.id })
						.from(balanceAnchors)
						.where(eq(balanceAnchors.accountId, accounts.id))
				),
				exists(
					db
						.select({ id: transactions.id })
						.from(transactions)
						.where(eq(transactions.accountId, accounts.id))
				)
			)
		)
		.orderBy(asc(accounts.createdAt))
		.all();
	if (inUse.length === 0) return [];
	const checked = new Set(
		db
			.select({ accountId: balanceChecks.accountId })
			.from(balanceChecks)
			.where(
				and(
					inArray(
						balanceChecks.accountId,
						inUse.map((a) => a.id)
					),
					like(balanceChecks.date, `${month}-%`)
				)
			)
			.all()
			.map((c) => c.accountId)
	);
	return inUse.filter((a) => !checked.has(a.id));
}

function accountExists(db: Conn, id: string): boolean {
	return (
		db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, id)).get() !== undefined
	);
}

export interface BalanceInput {
	accountId: string;
	date: string;
	amountCents: number;
}

/** Legt het echte saldo vast; dezelfde rekening en datum nog eens overschrijft het. */
export function saveBalanceCheck(db: DB, input: BalanceInput): boolean {
	if (!accountExists(db, input.accountId)) return false;
	db.transaction((tx) => {
		const before =
			tx
				.select()
				.from(balanceChecks)
				.where(
					and(eq(balanceChecks.accountId, input.accountId), eq(balanceChecks.date, input.date))
				)
				.get() ?? null;
		const after = tx
			.insert(balanceChecks)
			.values(input)
			.onConflictDoUpdate({
				target: [balanceChecks.accountId, balanceChecks.date],
				set: { amountCents: input.amountCents, updatedAt: new Date().toISOString() }
			})
			.returning()
			.get();
		recordChange(
			tx,
			before ? 'gewijzigd' : 'aangemaakt',
			'balance_checks',
			after.id,
			before,
			after
		);
	});
	return true;
}

/** Zet het startsaldo van een rekening met de hand; vervangt een anker uit de import. */
export function setBalanceAnchor(db: DB, input: BalanceInput): boolean {
	if (!accountExists(db, input.accountId)) return false;
	db.transaction((tx) => {
		const before =
			tx.select().from(balanceAnchors).where(eq(balanceAnchors.accountId, input.accountId)).get() ??
			null;
		const after = tx
			.insert(balanceAnchors)
			.values({ ...input, source: 'handmatig' })
			.onConflictDoUpdate({
				target: balanceAnchors.accountId,
				set: {
					date: input.date,
					amountCents: input.amountCents,
					source: 'handmatig',
					importBatchId: null,
					updatedAt: new Date().toISOString()
				}
			})
			.returning()
			.get();
		recordChange(
			tx,
			before ? 'gewijzigd' : 'aangemaakt',
			'balance_anchors',
			after.id,
			before,
			after
		);
	});
	return true;
}

/**
 * Startsaldo uit een import, alleen als de rekening er nog geen heeft. Een latere import verschuift
 * het anker niet: zo blijft een dubbele of vergeten boeking van vóór die import zichtbaar als verschil.
 */
export function anchorFromImport(
	tx: Conn,
	input: BalanceInput & { importBatchId: string }
): boolean {
	const exists = tx
		.select({ id: balanceAnchors.id })
		.from(balanceAnchors)
		.where(eq(balanceAnchors.accountId, input.accountId))
		.get();
	if (exists) return false;
	const after = tx
		.insert(balanceAnchors)
		.values({ ...input, source: 'import' })
		.returning()
		.get();
	recordChange(tx, 'aangemaakt', 'balance_anchors', after.id, null, after);
	return true;
}
