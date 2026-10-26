import { and, asc, desc, eq, gt, gte, inArray, lt, lte, notExists, or, sql } from 'drizzle-orm';
import {
	autoTagChanges,
	covers,
	TAG_HUES,
	tagSpend,
	tagState,
	type TagChip,
	type TagLine,
	type TagPeriod
} from '../tags.ts';
import { recordChange } from './audit.ts';
import type { Conn, DB } from './db/index.ts';
import { accounts, categories, tags, transactionTags, transactions } from './db/schema.ts';
import { ValidationError } from './errors.ts';
import { ADVANCED } from './owed.ts';

// Tags (spec: Dagelijks gebruik → Tags). Een tag hangt zich vanzelf aan elke transactie met een
// datum in zijn periode (`automatisch`); wat je op de transactie zelf aan- of uitzet is
// `handmatig` en blijft staan. Elke plek die een transactie aanmaakt of een datum verandert,
// roept `syncAutoTags` aan in dezelfde database-transactie.

const CHUNK = 500;

function chunks<T>(items: readonly T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
	return out;
}

function periods(db: Conn): TagPeriod[] {
	return db
		.select({ id: tags.id, startDate: tags.startDate, endDate: tags.endDate })
		.from(tags)
		.all();
}

/**
 * Automatisch toewijzen voor deze transacties, na invoer, een bon, een import of een nieuwe
 * datum: tags waarvan de periode de datum dekt komen erbij, automatische tags die er niet meer
 * bij horen gaan eraf. Wat je zelf aan- of uitzette blijft staan.
 */
export function syncAutoTags(db: Conn, transactionIds: readonly string[]): void {
	if (transactionIds.length === 0) return;
	const all = periods(db);
	// Zonder tags zijn er ook geen koppelingen (verwijderen cascadeert)
	if (all.length === 0) return;
	for (const ids of chunks([...new Set(transactionIds)])) {
		const rows = db
			.select({ id: transactions.id, date: transactions.date })
			.from(transactions)
			.where(inArray(transactions.id, ids))
			.all();
		const links = Map.groupBy(
			db
				.select({
					transactionId: transactionTags.transactionId,
					tagId: transactionTags.tagId,
					source: transactionTags.source,
					active: transactionTags.active
				})
				.from(transactionTags)
				.where(inArray(transactionTags.transactionId, ids))
				.all(),
			(l) => l.transactionId
		);
		const add: (typeof transactionTags.$inferInsert)[] = [];
		for (const r of rows) {
			const changes = autoTagChanges(r.date, all, links.get(r.id) ?? []);
			for (const tagId of changes.add)
				add.push({ transactionId: r.id, tagId, source: 'automatisch' });
			for (const tagId of changes.remove)
				db.delete(transactionTags)
					.where(
						and(
							eq(transactionTags.transactionId, r.id),
							eq(transactionTags.tagId, tagId),
							eq(transactionTags.source, 'automatisch')
						)
					)
					.run();
		}
		if (add.length > 0) db.insert(transactionTags).values(add).onConflictDoNothing().run();
	}
}

/** Na het aanmaken of wijzigen van een tag: de automatische koppelingen volgen de periode. */
function applyPeriod(db: Conn, tag: TagPeriod): void {
	const outside = or(
		lt(transactions.date, tag.startDate),
		tag.endDate === null ? undefined : gt(transactions.date, tag.endDate)
	);
	db.delete(transactionTags)
		.where(
			and(
				eq(transactionTags.tagId, tag.id),
				eq(transactionTags.source, 'automatisch'),
				inArray(
					transactionTags.transactionId,
					db.select({ id: transactions.id }).from(transactions).where(outside)
				)
			)
		)
		.run();
	const inside = db
		.select({ id: transactions.id })
		.from(transactions)
		.where(
			and(
				gte(transactions.date, tag.startDate),
				tag.endDate === null ? undefined : lte(transactions.date, tag.endDate),
				notExists(
					db
						.select({ id: transactionTags.id })
						.from(transactionTags)
						.where(
							and(
								eq(transactionTags.transactionId, transactions.id),
								eq(transactionTags.tagId, tag.id)
							)
						)
				)
			)
		)
		.all();
	for (const part of chunks(inside))
		db.insert(transactionTags)
			.values(
				part.map((r) => ({ transactionId: r.id, tagId: tag.id, source: 'automatisch' as const }))
			)
			.onConflictDoNothing()
			.run();
}

export interface TagInput {
	name: string;
	startDate: string;
	/** Leeg: de tag loopt door */
	endDate: string | null;
	hue: number;
}

function checkInput(input: TagInput): void {
	if (input.endDate !== null && input.endDate < input.startDate)
		throw new ValidationError('De einddatum ligt voor de begindatum');
	if (!(TAG_HUES as readonly number[]).includes(input.hue))
		throw new ValidationError('Kies een van de kleuren');
}

export function createTag(db: DB, input: TagInput): string {
	checkInput(input);
	return db.transaction((tx) => {
		const row = tx.insert(tags).values(input).returning().get();
		applyPeriod(tx, row);
		recordChange(tx, 'aangemaakt', 'tags', row.id, null, row);
		return row.id;
	});
}

export function updateTag(db: DB, id: string, input: TagInput): boolean {
	checkInput(input);
	return db.transaction((tx) => {
		const before = tx.select().from(tags).where(eq(tags.id, id)).get();
		if (!before) return false;
		const after = tx
			.update(tags)
			.set({ ...input, updatedAt: new Date().toISOString() })
			.where(eq(tags.id, id))
			.returning()
			.get();
		if (after.startDate !== before.startDate || after.endDate !== before.endDate)
			applyPeriod(tx, after);
		recordChange(tx, 'gewijzigd', 'tags', id, before, after);
		return true;
	});
}

/** Haalt de tag en zijn koppelingen weg; de transacties blijven. */
export function deleteTag(db: DB, id: string): boolean {
	return db.transaction((tx) => {
		const before = tx.select().from(tags).where(eq(tags.id, id)).get();
		if (!before) return false;
		tx.delete(tags).where(eq(tags.id, id)).run();
		recordChange(tx, 'verwijderd', 'tags', id, before, null);
		return true;
	});
}

/**
 * Een tag op een transactie aan- of uitzetten. Dat is je eigen keuze: hij blijft staan als de
 * periode of de datum verandert, en uitgezet zet het automatisch toewijzen hem niet terug.
 */
export function setTransactionTag(db: DB, transactionId: string, tagId: string, on: boolean): void {
	db.transaction((tx) => {
		const t = tx
			.select({ id: transactions.id })
			.from(transactions)
			.where(eq(transactions.id, transactionId))
			.get();
		const tag = tx.select({ id: tags.id }).from(tags).where(eq(tags.id, tagId)).get();
		if (!t || !tag) throw new ValidationError('Deze tag of transactie bestaat niet meer');
		const where = and(
			eq(transactionTags.transactionId, transactionId),
			eq(transactionTags.tagId, tagId)
		);
		const before = tx
			.select({ source: transactionTags.source, active: transactionTags.active })
			.from(transactionTags)
			.where(where)
			.get();
		const after = { source: 'handmatig' as const, active: on };
		tx.insert(transactionTags)
			.values({ transactionId, tagId, ...after })
			.onConflictDoUpdate({
				target: [transactionTags.transactionId, transactionTags.tagId],
				set: after
			})
			.run();
		recordChange(
			tx,
			on ? 'tag_aan' : 'tag_uit',
			'transaction_tags',
			`${transactionId}:${tagId}`,
			before ?? null,
			after
		);
	});
}

/**
 * De tags op de detailpagina van een transactie: die rond de datum en die erop staan, als
 * chips; de overige om er alsnog een aan te zetten. Een retour volgt de tags van zijn uitgave.
 */
export function transactionTagChips(db: DB, transactionId: string) {
	const t = db
		.select({ date: transactions.date, correctionOf: transactions.correctionOf })
		.from(transactions)
		.where(eq(transactions.id, transactionId))
		.get();
	if (!t) return null;
	const all = db
		.select({
			id: tags.id,
			name: tags.name,
			hue: tags.hue,
			startDate: tags.startDate,
			endDate: tags.endDate
		})
		.from(tags)
		.orderBy(desc(tags.startDate), asc(tags.name))
		.all();
	if (all.length === 0) return { chips: [], others: [], follows: [] };
	const linkOf = (id: string) =>
		new Map(
			db
				.select({
					tagId: transactionTags.tagId,
					source: transactionTags.source,
					active: transactionTags.active
				})
				.from(transactionTags)
				.where(eq(transactionTags.transactionId, id))
				.all()
				.map((l) => [l.tagId, l])
		);
	if (t.correctionOf) {
		const original = linkOf(t.correctionOf);
		return {
			chips: [],
			others: [],
			follows: all
				.filter((tag) => original.get(tag.id)?.active)
				.map((tag) => ({ id: tag.id, name: tag.name, hue: tag.hue }))
		};
	}
	const links = linkOf(transactionId);
	const chips: TagChip[] = [];
	const others: { id: string; name: string; hue: number }[] = [];
	for (const tag of all) {
		const link = links.get(tag.id);
		if (link || covers(tag, t.date))
			chips.push({
				id: tag.id,
				name: tag.name,
				hue: tag.hue,
				on: link?.active ?? true,
				manual: link?.source === 'handmatig'
			});
		else others.push({ id: tag.id, name: tag.name, hue: tag.hue });
	}
	return { chips, others, follows: [] };
}

type LineRow = {
	tag_id: string;
	category_id: string | null;
	category_name: string | null;
	category_group: string | null;
	counts_for_budget: number | null;
	amount: number;
	advanced: number;
};

/**
 * Regels die meetellen, per tag: de getagde transacties (zonder verwachte posten), plus de
 * retouren en storno's op die transacties, ook als die zelf buiten de periode vallen. Een
 * gedeelde uitgave telt via zijn verdeling. Een eigen tag op een retour telt niet apart.
 */
function tagLines(db: DB, tagId?: string): Map<string, TagLine[]> {
	const only = tagId === undefined ? sql`` : sql`AND tt.tag_id = ${tagId}`;
	const rows = db.all<LineRow>(sql`
		WITH tagged AS (
			SELECT tt.tag_id, t.id
			FROM transaction_tags tt
			JOIN transactions t ON t.id = tt.transaction_id
			WHERE tt.active = 1 AND t.correction_of IS NULL AND t.status != 'verwacht' ${only}
		),
		booked AS (
			SELECT tag_id, id FROM tagged
			UNION ALL
			SELECT g.tag_id, c.id
			FROM tagged g
			JOIN transactions c ON c.correction_of = g.id
			WHERE c.status != 'verwacht'
		)
		SELECT x.tag_id, x.category_id, c.name AS category_name, c."group" AS category_group,
			c.counts_for_budget, x.amount, x.advanced
		FROM (
			SELECT b.tag_id, t.category_id, t.amount_cents AS amount, 0 AS advanced
			FROM booked b
			JOIN transactions t ON t.id = b.id
			WHERE NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = b.id)
			UNION ALL
			SELECT b.tag_id, s.category_id, s.amount_cents AS amount, s.note = ${ADVANCED} AS advanced
			FROM transaction_splits s
			JOIN booked b ON b.id = s.transaction_id
		) x
		LEFT JOIN categories c ON c.id = x.category_id
	`);
	const out = new Map<string, TagLine[]>();
	for (const r of rows) {
		const list = out.get(r.tag_id) ?? [];
		list.push({
			categoryId: r.category_id,
			categoryName: r.category_name,
			categoryGroup: r.category_group,
			countsForBudget: r.counts_for_budget === null ? null : r.counts_for_budget === 1,
			amountCents: r.amount,
			advanced: r.advanced === 1
		});
		out.set(r.tag_id, list);
	}
	return out;
}

const STATE_ORDER = { loopt: 0, komt: 1, voorbij: 2 } as const;

/** Alle tags met hun totaal: lopende eerst, dan komende, dan de afgelopen van nieuw naar oud. */
export function tagSummaries(db: DB, today: string) {
	const lines = tagLines(db);
	const counts = new Map(
		db
			.select({ tagId: transactionTags.tagId, n: sql<number>`count(*)` })
			.from(transactionTags)
			.innerJoin(transactions, eq(transactions.id, transactionTags.transactionId))
			.where(and(eq(transactionTags.active, true), sql`${transactions.correctionOf} IS NULL`))
			.groupBy(transactionTags.tagId)
			.all()
			.map((r) => [r.tagId, r.n])
	);
	return db
		.select()
		.from(tags)
		.all()
		.map((t) => ({
			...t,
			state: tagState(t, today),
			count: counts.get(t.id) ?? 0,
			...tagSpend(lines.get(t.id) ?? [])
		}))
		.sort(
			(a, b) =>
				STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
				(a.state === 'komt'
					? a.startDate.localeCompare(b.startDate)
					: b.startDate.localeCompare(a.startDate)) ||
				a.name.localeCompare(b.name, 'nl')
		);
}

export type TagSummary = ReturnType<typeof tagSummaries>[number];

/** Voor de tegel op Meer: hoeveel tags er zijn, en de lopende met zijn totaal. */
export function tagsTile(db: DB, today: string) {
	const all = tagSummaries(db, today);
	const current = all.find((t) => t.state === 'loopt') ?? null;
	return {
		count: all.length,
		current: current ? { name: current.name, totalCents: current.totalCents } : null
	};
}

/**
 * Eén tag met zijn transacties: wat meetelt (met de retouren onder hun uitgave), wat niet
 * meetelt (buiten budget of nog verwacht) en wat je uitzette.
 */
export function tagDetail(db: DB, id: string, today: string) {
	const tag = db.select().from(tags).where(eq(tags.id, id)).get();
	if (!tag) return null;
	const spend = tagSpend(tagLines(db, id).get(id) ?? []);
	const fields = {
		id: transactions.id,
		amountCents: transactions.amountCents,
		date: transactions.date,
		counterparty: transactions.counterparty,
		categoryName: categories.name,
		categoryGroup: categories.group,
		countsForBudget: categories.countsForBudget,
		accountAlias: accounts.alias,
		status: transactions.status,
		origAmountCents: transactions.origAmountCents,
		origCurrency: transactions.origCurrency,
		correctionOf: transactions.correctionOf
	};
	const linked = db
		.select({ ...fields, active: transactionTags.active })
		.from(transactionTags)
		.innerJoin(transactions, eq(transactions.id, transactionTags.transactionId))
		.leftJoin(categories, eq(categories.id, transactions.categoryId))
		.innerJoin(accounts, eq(accounts.id, transactions.accountId))
		.where(and(eq(transactionTags.tagId, id), sql`${transactions.correctionOf} IS NULL`))
		.orderBy(desc(transactions.date), desc(transactions.createdAt))
		.all();
	const on = linked.filter((r) => r.active);
	const corrections =
		on.length === 0
			? []
			: chunks(on.map((r) => r.id)).flatMap((ids) =>
					db
						.select(fields)
						.from(transactions)
						.leftJoin(categories, eq(categories.id, transactions.categoryId))
						.innerJoin(accounts, eq(accounts.id, transactions.accountId))
						.where(inArray(transactions.correctionOf, ids))
						.orderBy(asc(transactions.date))
						.all()
				);
	const correctionsOf = Map.groupBy(corrections, (c) => c.correctionOf!);
	// Jouw deel van een gedeelde uitgave: alles behalve het voorgeschoten deel
	const mine = new Map(
		on.length === 0
			? []
			: db
					.all<{ transaction_id: string; mine: number }>(
						sql`SELECT transaction_id, SUM(amount_cents) AS mine FROM transaction_splits
							WHERE note != ${ADVANCED} AND transaction_id IN (
								SELECT transaction_id FROM transaction_tags WHERE tag_id = ${id} AND active = 1
							)
							GROUP BY transaction_id`
					)
					.map((r) => [r.transaction_id, r.mine])
	);
	const counts = (r: (typeof linked)[number]) =>
		r.status !== 'verwacht' && r.countsForBudget !== false;
	const item = (r: (typeof linked)[number]) => ({
		...r,
		mineCents: mine.get(r.id) ?? null,
		corrections: correctionsOf.get(r.id) ?? []
	});
	return {
		tag: { ...tag, state: tagState(tag, today) },
		...spend,
		items: on.filter(counts).map(item),
		notCounted: on.filter((r) => !counts(r)).map(item),
		off: linked.filter((r) => !r.active).map(item)
	};
}

/**
 * Een bankboeking gaat op in je eigen invoer (koppellijst): wat je op de boeking zelf aan- of
 * uitzette gaat mee, tenzij je op je invoer voor die tag al iets koos.
 */
export function moveManualTags(db: Conn, fromId: string, toId: string): void {
	const manual = db
		.select({ tagId: transactionTags.tagId, active: transactionTags.active })
		.from(transactionTags)
		.where(and(eq(transactionTags.transactionId, fromId), eq(transactionTags.source, 'handmatig')))
		.all();
	for (const m of manual)
		db.insert(transactionTags)
			.values({ transactionId: toId, tagId: m.tagId, source: 'handmatig', active: m.active })
			.onConflictDoUpdate({
				target: [transactionTags.transactionId, transactionTags.tagId],
				set: { source: 'handmatig', active: m.active },
				setWhere: eq(transactionTags.source, 'automatisch')
			})
			.run();
}
