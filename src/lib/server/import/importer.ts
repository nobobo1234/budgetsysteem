import { createHash } from 'node:crypto';
import { and, eq, isNull, like, sql } from 'drizzle-orm';
import { matchRule, sortRules } from '../../rules.ts';
import { normalizeCounterparty } from '../../text.ts';
import { keywordCategory } from '../../quickentry/resolve.ts';
import { recordChange } from '../audit.ts';
import type { Conn, DB } from '../db/index.ts';
import { accounts, categories, importBatches, rules, transactions } from '../db/schema.ts';
import { INTERNAL_TRANSFER } from '../db/seed.ts';
import { mccCategory, parseCardPayment } from './card.ts';
import { ImportError, type ImportRecord } from './types.ts';

export interface UncategorizedGroup {
	/** Voorstel voor het regelpatroon: de genormaliseerde tegenpartij */
	pattern: string;
	/** Hoe de tegenpartij in het bestand staat */
	example: string;
	count: number;
	totalCents: number;
	suggestedCategoryId: string | null;
}

export interface ImportSummary {
	batchId: string;
	newCount: number;
	duplicateCount: number;
	periodStart: string | null;
	periodEnd: string | null;
	uncategorized: UncategorizedGroup[];
}

const MAX_RECORDS = 100_000;

function dedupeHash(r: ImportRecord, occurrence: number): string {
	return createHash('sha256')
		.update(
			[r.accountIban, r.date, r.amountCents, r.counterIban ?? '', r.description, occurrence].join(
				'\u001f'
			)
		)
		.digest('hex');
}

/** Een bankreferentie die in hetzelfde bestand bij verschillende boekingen hoort, is niet uniek. */
function unreliableReferences(records: ImportRecord[]): Set<string> {
	const seen = new Map<string, string>();
	const bad = new Set<string>();
	for (const r of records) {
		if (!r.bankReference) continue;
		const fingerprint = `${r.date}|${r.amountCents}|${r.counterIban}|${r.description}`;
		const prev = seen.get(r.bankReference);
		if (prev === undefined) seen.set(r.bankReference, fingerprint);
		else if (prev !== fingerprint) bad.add(r.bankReference);
	}
	return bad;
}

/**
 * Importeert boekingen als één database-transactie: bij een fout rolt alles terug.
 * Ontdubbelt op bankreferentie, en zonder (betrouwbare) referentie op een hash van
 * rekening, datum, bedrag, tegen-IBAN, omschrijving en het hoeveelste exemplaar in het bestand.
 */
export function importRecords(
	db: DB,
	records: ImportRecord[],
	format: 'camt053' | 'csv'
): ImportSummary {
	if (records.length === 0) throw new ImportError('Het bestand bevat geen boekingen.');
	if (records.length > MAX_RECORDS) throw new ImportError('Te veel boekingen in één bestand.');

	return db.transaction((tx) => {
		// Eigen rekeningen bij de IBANs uit het bestand zoeken of aanmaken
		const accountIds = new Map<string, string>();
		for (const iban of new Set(records.map((r) => r.accountIban))) {
			let account = tx.select().from(accounts).where(eq(accounts.iban, iban)).get();
			if (!account) {
				const unassigned = tx
					.select()
					.from(accounts)
					.where(and(eq(accounts.kind, 'sns'), isNull(accounts.iban)))
					.get();
				if (unassigned) {
					tx.update(accounts).set({ iban }).where(eq(accounts.id, unassigned.id)).run();
					account = { ...unassigned, iban };
				} else {
					const n =
						tx
							.select({ n: sql<number>`count(*)` })
							.from(accounts)
							.get()?.n ?? 0;
					account = tx
						.insert(accounts)
						.values({ name: `SNS ${iban.slice(-4)}`, kind: 'sns', iban, alias: `sns${n + 1}` })
						.returning()
						.get();
				}
			}
			accountIds.set(iban, account.id);
		}

		const ownIbans = new Set(
			tx
				.select({ iban: accounts.iban })
				.from(accounts)
				.all()
				.map((a) => a.iban)
				.filter((i): i is string => i !== null)
		);
		const internalId =
			tx
				.select({ id: categories.id })
				.from(categories)
				.where(eq(categories.name, INTERNAL_TRANSFER))
				.get()?.id ?? null;
		const sortedRules = sortRules(tx.select().from(rules).all());

		const batch = tx
			.insert(importBatches)
			.values({ format, newCount: 0, duplicateCount: 0 })
			.returning({ id: importBatches.id })
			.get();

		const bad = unreliableReferences(records);
		const occurrences = new Map<string, number>();
		let newCount = 0;
		let duplicateCount = 0;
		let periodStart: string | null = null;
		let periodEnd: string | null = null;

		for (const r of records) {
			const reference = r.bankReference && !bad.has(r.bankReference) ? r.bankReference : null;
			let hash: string | null = null;
			if (!reference) {
				const key = `${r.accountIban}|${r.date}|${r.amountCents}|${r.counterIban}|${r.description}`;
				const nth = (occurrences.get(key) ?? 0) + 1;
				occurrences.set(key, nth);
				hash = dedupeHash(r, nth);
			}

			const categoryId =
				r.counterIban && ownIbans.has(r.counterIban)
					? internalId
					: (matchRule(sortedRules, r)?.categoryId ?? null);

			const result = tx
				.insert(transactions)
				.values({
					amountCents: r.amountCents,
					date: r.date,
					counterparty: r.counterparty,
					counterIban: r.counterIban,
					description: r.description,
					categoryId,
					accountId: accountIds.get(r.accountIban)!,
					source: 'import',
					bankReference: reference,
					dedupeHash: hash,
					importBatchId: batch.id
				})
				.onConflictDoNothing()
				.run();

			if (result.changes === 1) {
				newCount++;
				if (!periodStart || r.date < periodStart) periodStart = r.date;
				if (!periodEnd || r.date > periodEnd) periodEnd = r.date;
			} else duplicateCount++;
		}

		tx.update(importBatches)
			.set({ newCount, duplicateCount, periodStart, periodEnd })
			.where(eq(importBatches.id, batch.id))
			.run();
		recordChange(tx, 'import', 'import_batches', batch.id, null, { newCount, duplicateCount });

		return {
			batchId: batch.id,
			newCount,
			duplicateCount,
			periodStart,
			periodEnd,
			uncategorized: uncategorizedGroups(tx)
		};
	});
}

/** Tegenpartijen zonder categorie, de grootste eerst, met een voorstel voor een categorie. */
export function uncategorizedGroups(db: Conn, limit = 50): UncategorizedGroup[] {
	const rows = db
		.select({
			counterparty: transactions.counterparty,
			description: transactions.description,
			amountCents: transactions.amountCents
		})
		.from(transactions)
		.where(and(isNull(transactions.categoryId), eq(transactions.status, 'bevestigd')))
		.all();

	const byName = new Map<string, UncategorizedGroup>();
	// Per groep hoe vaak elke MCC voorkomt (alleen bij pinbetalingen)
	const mccs = new Map<string, Map<string, number>>();
	for (const row of rows) {
		const pattern = normalizeCounterparty(row.counterparty);
		if (!pattern) continue;
		const group = byName.get(pattern) ?? {
			pattern,
			example: row.counterparty,
			count: 0,
			totalCents: 0,
			suggestedCategoryId: null
		};
		group.count++;
		group.totalCents += row.amountCents;
		byName.set(pattern, group);

		const mcc = row.description.includes('MCC:') ? parseCardPayment(row.description)?.mcc : null;
		if (mcc) {
			const counts = mccs.get(pattern) ?? new Map<string, number>();
			counts.set(mcc, (counts.get(mcc) ?? 0) + 1);
			mccs.set(pattern, counts);
		}
	}

	const cats = db.select({ id: categories.id, name: categories.name }).from(categories).all();
	return [...byName.values()]
		.sort((a, b) => b.count - a.count || Math.abs(b.totalCents) - Math.abs(a.totalCents))
		.slice(0, limit)
		.map((g) => {
			// De MCC van de bank eerst, dan trefwoorden in de naam. Alleen een voorstel: er wordt niets
			// geboekt, en een regel gaat altijd voor (deze transacties hebben juist geen passende regel).
			const mcc = mostFrequent(mccs.get(g.pattern));
			const name =
				(mcc ? mccCategory(mcc) : null) ??
				keywordCategory(g.pattern, g.totalCents >= 0 ? 'in' : 'uit');
			return { ...g, suggestedCategoryId: cats.find((c) => c.name === name)?.id ?? null };
		});
}

function mostFrequent(counts: Map<string, number> | undefined): string | null {
	let best: string | null = null;
	let bestCount = 0;
	for (const [key, n] of counts ?? []) {
		if (n > bestCount) {
			best = key;
			bestCount = n;
		}
	}
	return best;
}

/** Geïmporteerde pinbetalingen zonder tegenpartij waarvan de winkel in de omschrijving staat. */
function cardCounterpartyRepairs(db: Conn): { id: string; before: string; merchant: string }[] {
	return db
		.select({
			id: transactions.id,
			counterparty: transactions.counterparty,
			description: transactions.description
		})
		.from(transactions)
		.where(
			and(
				eq(transactions.source, 'import'),
				sql`trim(${transactions.counterparty}) = ''`,
				like(transactions.description, '%MCC:%')
			)
		)
		.all()
		.flatMap((t) => {
			const merchant = parseCardPayment(t.description)?.merchant.slice(0, 140);
			return merchant ? [{ id: t.id, before: t.counterparty, merchant }] : [];
		});
}

/** Hoeveel transacties `fillCardCounterparties` zou bijwerken. */
export function countCardCounterpartyRepairs(db: Conn): number {
	return cardCounterpartyRepairs(db).length;
}

/**
 * Reparatie voor imports van vóór de herkenning van pinbetalingen: geïmporteerde pinbetalingen
 * zonder tegenpartij krijgen de winkel uit de omschrijving. Idempotent; omschrijving,
 * bankreferentie en ontdubbelhash blijven ongewijzigd. Elke wijziging komt in het audit-log,
 * zodat hij terug te volgen en ongedaan te maken is. Daarna worden de regels opnieuw toegepast.
 */
export function fillCardCounterparties(db: DB): { updated: number; categorized: number } {
	const updated = db.transaction((tx) => {
		const repairs = cardCounterpartyRepairs(tx);
		for (const r of repairs) {
			tx.update(transactions)
				.set({ counterparty: r.merchant, updatedAt: new Date().toISOString() })
				.where(eq(transactions.id, r.id))
				.run();
			recordChange(
				tx,
				'tegenpartij_uit_pinbetaling',
				'transactions',
				r.id,
				{ counterparty: r.before },
				{ counterparty: r.merchant }
			);
		}
		return repairs.length;
	});
	return { updated, categorized: updated > 0 ? applyRulesToUncategorized(db) : 0 };
}

/** Past alle regels toe op transacties zonder categorie. Geeft het aantal bijgewerkte terug. */
export function applyRulesToUncategorized(db: DB): number {
	const sortedRules = sortRules(db.select().from(rules).all());
	if (sortedRules.length === 0) return 0;
	return db.transaction((tx) => {
		const open = tx
			.select({
				id: transactions.id,
				counterparty: transactions.counterparty,
				counterIban: transactions.counterIban,
				description: transactions.description
			})
			.from(transactions)
			.where(isNull(transactions.categoryId))
			.all();
		let updated = 0;
		for (const t of open) {
			const rule = matchRule(sortedRules, t);
			if (!rule) continue;
			tx.update(transactions)
				.set({ categoryId: rule.categoryId, updatedAt: new Date().toISOString() })
				.where(eq(transactions.id, t.id))
				.run();
			updated++;
		}
		return updated;
	});
}
