import { and, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { addDays } from '../../dates.ts';
import {
	decideMatch,
	differenceCents,
	MERGE_WINDOW_DAYS,
	type BankEntry,
	type MatchDecision
} from '../../koppellijst.ts';
import type { MatchLabel } from '../../match.ts';
import { recordChange } from '../audit.ts';
import { correctedCents } from '../corrections.ts';
import type { Conn, DB } from '../db/index.ts';
import {
	auditLog,
	categories,
	owed,
	owedPayments,
	receiptItems,
	receipts,
	reservations,
	transactionSplits,
	transactions
} from '../db/schema.ts';
import { ValidationError } from '../errors.ts';
import { ADVANCED, MY_SHARE, settlePayment, syncShareSplits, unlinkPayment } from '../owed.ts';
import { applySharedSplit, hasSharePosts } from '../shares.ts';

// Koppellijst bij een bankimport (spec: Import en Bonnetjes en koppelen → Koppellijst). Een
// nieuwe boeking van de bank wordt tegen je eigen invoer gehouden: handmatig, van een bon, of een
// verwachte post die je met één tik bevestigde. Bij een duidelijke voorsprong voegt de import ze
// samen; anders komt de boeking op te controleren met de koppellijst. Samenvoegen houdt de rij
// van je invoer, zodat categorie, notitie, voorgeschoten delen, posten, retouren en een
// gekoppelde bon blijven; bedrag, datum en bankreferentie komen van de bank.

type Row = typeof transactions.$inferSelect;

/** Wat de bank over een boeking zegt; overschrijft je invoer bij samenvoegen. */
export interface BankFields {
	amountCents: number;
	date: string;
	counterparty: string;
	counterIban: string | null;
	description: string;
	accountId: string;
	bankReference: string | null;
	dedupeHash: string | null;
	importBatchId: string | null;
	origAmountCents: number | null;
	origCurrency: string | null;
	endToEndId: string | null;
	/** Categorie van een regel; alleen gebruikt als je invoer er geen heeft */
	category: Pick<Row, 'categoryId' | 'categorySource' | 'categoryRuleId'> | null;
}

/** Een kandidaat in de koppellijst, zonder IBAN. */
export interface OwnCandidate {
	id: string;
	amountCents: number;
	date: string;
	counterparty: string;
	source: 'handmatig' | 'bon' | 'verwacht';
	categoryName: string | null;
	categoryGroup: string | null;
	note: string;
	score: number;
	label: MatchLabel;
	/** Wat de bank meer (positief) of minder boekte dan je invoerde */
	differenceCents: number;
}

/** Eigen invoer die nog niet aan een bankboeking hangt. */
const unlinkedOwn = and(
	or(
		inArray(transactions.source, ['handmatig', 'bon']),
		and(eq(transactions.source, 'verwacht'), eq(transactions.status, 'bevestigd'))
	),
	ne(transactions.status, 'verwacht'),
	isNull(transactions.bankReference),
	isNull(transactions.dedupeHash),
	ne(transactions.amountCents, 0)
);

/** Is er eigen invoer om tegen te houden? Scheelt een zoekvraag per boeking bij de eerste import. */
export function hasUnlinkedOwn(db: Conn): boolean {
	return (
		db.select({ id: transactions.id }).from(transactions).where(unlinkedOwn).limit(1).get() !==
		undefined
	);
}

/**
 * Kan het bedrag van deze invoer naar dat van de bank? Een retour met een ander bedrag moet je
 * eerst losmaken; meer terug dan het nieuwe bedrag, of een voorgeschoten deel dat groter wordt
 * dan de uitgave, past niet.
 */
function canTakeAmount(
	db: Conn,
	own: Pick<Row, 'id' | 'amountCents' | 'correctionOf'>,
	cents: number
) {
	if (own.amountCents === cents) return true;
	if (own.correctionOf) return false;
	if (correctedCents(db, own.id) > Math.abs(cents)) return false;
	const advanced = db
		.select({ amountCents: transactionSplits.amountCents })
		.from(transactionSplits)
		.where(and(eq(transactionSplits.transactionId, own.id), eq(transactionSplits.note, ADVANCED)))
		.get();
	return !advanced || Math.abs(advanced.amountCents) <= Math.abs(cents);
}

function ownRows(db: Conn, bank: BankEntry) {
	return db
		.select({
			id: transactions.id,
			amountCents: transactions.amountCents,
			date: transactions.date,
			counterparty: transactions.counterparty,
			source: transactions.source,
			correctionOf: transactions.correctionOf,
			note: transactions.note,
			categoryName: categories.name,
			categoryGroup: categories.group
		})
		.from(transactions)
		.leftJoin(categories, eq(categories.id, transactions.categoryId))
		.where(
			and(
				unlinkedOwn,
				gte(transactions.date, addDays(bank.date, -MERGE_WINDOW_DAYS)),
				lte(transactions.date, addDays(bank.date, MERGE_WINDOW_DAYS)),
				bank.amountCents < 0
					? sql`${transactions.amountCents} < 0`
					: sql`${transactions.amountCents} > 0`
			)
		)
		.orderBy(transactions.date, transactions.createdAt)
		.limit(200)
		.all()
		.filter((r) => canTakeAmount(db, r, bank.amountCents))
		.map((r) => ({ ...r, name: r.counterparty }));
}

/** De koppellijst voor een bankboeking, en of hij meteen samengevoegd kan worden. */
export function findOwnMatch(db: Conn, bank: BankEntry, opts: { auto?: boolean } = {}) {
	return decideMatch(bank, ownRows(db, bank), opts);
}

/** Zet de verdeling recht na een ander bedrag; het verschil (fooi) is van jou. */
function adjustSplits(db: Conn, id: string, diff: number) {
	const splits = db
		.select()
		.from(transactionSplits)
		.where(eq(transactionSplits.transactionId, id))
		.all();
	if (splits.length === 0) return;
	if (hasSharePosts(db, id)) return applySharedSplit(db, id);
	if (splits.some((s) => s.note === MY_SHARE || s.note === ADVANCED))
		return syncShareSplits(db, id);
	// Verdeling over categorieën: het verschil gaat naar het grootste deel
	const largest = splits.reduce((a, b) =>
		Math.abs(b.amountCents) > Math.abs(a.amountCents) ? b : a
	);
	db.update(transactionSplits)
		.set({ amountCents: largest.amountCents + diff })
		.where(eq(transactionSplits.id, largest.id))
		.run();
}

/**
 * Voegt een bankboeking samen met je eigen invoer. De bank is leidend voor bedrag, datum,
 * tegenpartij, rekening en bankreferentie; categorie, notitie, verdeling, posten, retouren en
 * een gekoppelde bon blijven. Staat in het audit-log met wat je invoerde en het verschil.
 * Geeft het verschil in centen terug.
 */
export function mergeIntoOwn(
	db: Conn,
	ownId: string,
	bank: BankFields,
	how: 'automatisch' | 'gekozen',
	replaced?: string
): number {
	const before = db.select().from(transactions).where(eq(transactions.id, ownId)).get();
	if (!before) throw new ValidationError('Deze transactie bestaat niet meer');
	if (before.bankReference || before.dedupeHash || before.source === 'import')
		throw new ValidationError('Deze transactie hoort al bij een bankboeking');
	if (Math.sign(before.amountCents) !== Math.sign(bank.amountCents))
		throw new ValidationError('Deze transactie gaat de andere kant op');
	if (!canTakeAmount(db, before, bank.amountCents))
		throw new ValidationError('Het bedrag van deze transactie kan niet naar dat van de bank');

	const diff = differenceCents(bank.amountCents, before.amountCents);
	const orig =
		bank.origCurrency !== null
			? { origAmountCents: bank.origAmountCents, origCurrency: bank.origCurrency }
			: {};
	db.update(transactions)
		.set({
			amountCents: bank.amountCents,
			date: bank.date,
			// Een lege naam van de bank (sommige pinbetalingen) vervangt je eigen naam niet
			counterparty: bank.counterparty.trim() ? bank.counterparty : before.counterparty,
			counterIban: bank.counterIban,
			description: bank.description,
			accountId: bank.accountId,
			source: 'import',
			bankReference: bank.bankReference,
			dedupeHash: bank.dedupeHash,
			importBatchId: bank.importBatchId,
			endToEndId: bank.endToEndId,
			status: 'bevestigd',
			...orig,
			...(before.categoryId === null && bank.category?.categoryId ? bank.category : {}),
			updatedAt: new Date().toISOString()
		})
		.where(eq(transactions.id, ownId))
		.run();

	if (diff !== 0) {
		adjustSplits(db, ownId, bank.amountCents - before.amountCents);
		// Een gekoppelde betaling met een ander bedrag wordt opnieuw over de posten verdeeld
		const links = db
			.select({ personId: owedPayments.personId, owedId: owedPayments.owedId })
			.from(owedPayments)
			.where(eq(owedPayments.transactionId, ownId))
			.all();
		if (links.length > 0) {
			const first = links.find((l) => l.owedId)?.owedId ?? null;
			if (!settlePayment(db, ownId, { personId: links[0]!.personId, owedId: first }))
				unlinkPayment(db, ownId);
		}
	}

	// Zonder IBAN: dat is een persoonsgegeven van een ander
	recordChange(
		db,
		'samengevoegd',
		'transactions',
		ownId,
		{
			amountCents: before.amountCents,
			date: before.date,
			counterparty: before.counterparty,
			source: before.source,
			status: before.status,
			accountId: before.accountId
		},
		{
			amountCents: bank.amountCents,
			date: bank.date,
			source: 'import',
			importBatchId: bank.importBatchId,
			differenceCents: diff,
			how,
			...(replaced && { replaced })
		}
	);
	return diff;
}

/**
 * Samenvoegen tijdens de import, in een savepoint: past het toch niet, dan blijft alles zoals het
 * was en komt de boeking op te controleren.
 */
export function tryMergeIntoOwn(db: Conn, ownId: string, bank: BankFields): number | null {
	try {
		return db.transaction((sp) => mergeIntoOwn(sp, ownId, bank, 'automatisch'));
	} catch (e) {
		if (e instanceof ValidationError) return null;
		throw e;
	}
}

function toCandidates(
	decision: MatchDecision<ReturnType<typeof ownRows>[number]>,
	bankCents: number
): OwnCandidate[] {
	return decision.candidates.map(({ target: t, score, label }) => ({
		id: t.id,
		amountCents: t.amountCents,
		date: t.date,
		counterparty: t.counterparty,
		source: t.source as OwnCandidate['source'],
		categoryName: t.categoryName,
		categoryGroup: t.categoryGroup,
		note: t.note,
		score,
		label,
		differenceCents: differenceCents(bankCents, t.amountCents)
	}));
}

/**
 * De koppellijst van een geïmporteerde boeking op te controleren: je eigen invoer die erbij kan
 * horen. `null` als er niets is dat erop lijkt.
 */
export function ownMatchesFor(
	db: Conn,
	id: string
): { candidates: OwnCandidate[]; preselect: string | null } | null {
	const row = db.select().from(transactions).where(eq(transactions.id, id)).get();
	if (
		!row ||
		row.source !== 'import' ||
		row.status !== 'te_controleren' ||
		row.amountCents === 0 ||
		row.correctionOf
	)
		return null;
	const decision = findOwnMatch(
		db,
		{ amountCents: row.amountCents, date: row.date, name: row.counterparty, iban: row.counterIban },
		{ auto: false }
	);
	if (decision.kind === 'nieuw') return null;
	return {
		candidates: toCandidates(decision, row.amountCents),
		preselect: decision.kind === 'controleren' ? decision.preselect : null
	};
}

/** Hangt er al iets aan deze boeking dat bij samenvoegen zoek zou raken? */
function hasLinks(db: Conn, id: string): boolean {
	const one = <T>(rows: T[]) => rows.length > 0;
	return (
		one(
			db
				.select({ id: transactionSplits.id })
				.from(transactionSplits)
				.where(eq(transactionSplits.transactionId, id))
				.limit(1)
				.all()
		) ||
		one(
			db
				.select({ id: owedPayments.id })
				.from(owedPayments)
				.where(eq(owedPayments.transactionId, id))
				.limit(1)
				.all()
		) ||
		one(
			db.select({ id: owed.id }).from(owed).where(eq(owed.sourceTransactionId, id)).limit(1).all()
		) ||
		one(
			db
				.select({ id: transactions.id })
				.from(transactions)
				.where(eq(transactions.correctionOf, id))
				.limit(1)
				.all()
		)
	);
}

/**
 * Vanuit de koppellijst in de review-inbox: de geïmporteerde boeking hoort bij je eigen invoer.
 * De invoer krijgt de gegevens van de bank en de losse boeking verdwijnt, in één transactie.
 */
export function mergeImported(
	db: DB,
	importedId: string,
	ownId: string
): { differenceCents: number } {
	return db.transaction((tx) => {
		const bank = tx.select().from(transactions).where(eq(transactions.id, importedId)).get();
		if (!bank || bank.source !== 'import' || bank.status !== 'te_controleren')
			throw new ValidationError('Deze boeking staat niet meer te controleren');
		const matches = ownMatchesFor(tx, importedId);
		if (!matches?.candidates.some((c) => c.id === ownId))
			throw new ValidationError('Deze transactie past niet (meer) bij deze boeking');
		if (hasLinks(tx, importedId))
			throw new ValidationError('Deze boeking is al gekoppeld; maak dat eerst los');

		// Een bon, screenshot of reservering die al aan de bankboeking hing, gaat mee naar je invoer
		tx.update(receipts)
			.set({ transactionId: ownId })
			.where(eq(receipts.transactionId, importedId))
			.run();
		tx.update(receiptItems)
			.set({ transactionId: ownId })
			.where(eq(receiptItems.transactionId, importedId))
			.run();
		tx.update(reservations)
			.set({ transactionId: ownId })
			.where(eq(reservations.transactionId, importedId))
			.run();
		// Eerst weg, dan pas de bankreferentie op je invoer (die is uniek)
		tx.delete(transactions).where(eq(transactions.id, importedId)).run();
		const differenceCents = mergeIntoOwn(
			tx,
			ownId,
			{
				...bank,
				category: bank.categoryId
					? {
							categoryId: bank.categoryId,
							categorySource: bank.categorySource,
							categoryRuleId: bank.categoryRuleId
						}
					: null
			},
			'gekozen',
			importedId
		);
		return { differenceCents };
	});
}

const mergedSchema = z.object({
	before: z.object({
		amountCents: z.number().int(),
		date: z.string(),
		source: z.enum(['handmatig', 'bon', 'verwacht'])
	}),
	after: z.object({
		differenceCents: z.number().int(),
		how: z.enum(['automatisch', 'gekozen'])
	})
});

/** Voor de detailpagina: was dit je eigen invoer, en wat boekte de bank anders? */
export function mergeInfo(db: Conn, id: string) {
	const row = db
		.select({ at: auditLog.at, before: auditLog.before, after: auditLog.after })
		.from(auditLog)
		.where(
			and(
				eq(auditLog.action, 'samengevoegd'),
				eq(auditLog.entity, 'transactions'),
				eq(auditLog.entityId, id)
			)
		)
		.orderBy(desc(auditLog.at))
		.get();
	const parsed = row ? mergedSchema.safeParse(row) : null;
	if (!parsed?.success) return null;
	return {
		enteredCents: parsed.data.before.amountCents,
		enteredDate: parsed.data.before.date,
		source: parsed.data.before.source,
		differenceCents: parsed.data.after.differenceCents,
		how: parsed.data.after.how
	};
}
