import { and, asc, eq, inArray, isNotNull, isNull, ne, notExists, sql } from 'drizzle-orm';
import { addDays, shiftMonth, toIsoDate } from '../dates.ts';
import { daysBetween, REMIND_AFTER_DAYS } from '../owed.ts';
import { isActive, receiveDate, shareCents } from '../shares.ts';
import { recordChange } from './audit.ts';
import { correctionCandidates } from './corrections.ts';
import type { Conn, DB } from './db/index.ts';
import {
	accounts,
	auditLog,
	categories,
	owed,
	owedPayments,
	people,
	receipts,
	recurring,
	recurringShares,
	transactions
} from './db/schema.ts';
import { ValidationError } from './errors.ts';
import { owedReminders, type OpenPost } from './owed.ts';
import { receiptStage } from './receipts/outcome.ts';
import { readStored, type ReceiptField } from './receipts/stored.ts';
import { awaitingConfirmation, type Awaiting } from './recurring.ts';
import { dueReceipts, type DueReceipt } from './shares.ts';

// Review-inbox "te controleren" (spec: Dagelijks gebruik, en elke plek die iets naar de
// review-inbox stuurt). Eén verzameling uit de bronnen die er nu zijn, per soort een groep met
// zijn eigen actie. Een nieuwe bron is een functie die zijn items geeft, een veld in
// `ReviewInbox` en een groep op de pagina; `inboxCount` telt elk veld vanzelf mee.

/** Een post komt hooguit één keer terug nadat je hem liet staan (bij te laat en herinnering). */
export type LeaveKind = 'te_laat' | 'herinnering' | 'tegoed';

/** Een overboeking zoveel dagen voor de volgende ontvangstdag is vooruitbetaald, niet dubbel. */
export const EARLY_DAYS = 10;

/** Zoveel boekingen krijgen een voorstel uit de koppellijst; de rest koppel je op de detailpagina. */
const MATCH_LIMIT = 30;

export interface ReviewTransaction {
	id: string;
	amountCents: number;
	date: string;
	counterparty: string;
	categoryName: string | null;
	categoryGroup: string | null;
	accountAlias: string;
	status: 'te_controleren';
	origAmountCents: number | null;
	origCurrency: string | null;
	/**
	 * `bedrag`: het eurobedrag ontbreekt; `koppelen`: hoort waarschijnlijk bij een eerdere
	 * boeking (storno, terugboeking of retour); anders gewoon nakijken.
	 */
	reason: 'bedrag' | 'koppelen' | 'controleren';
	/** De beste kandidaat uit de koppellijst, zonder IBAN */
	match: { counterparty: string; date: string; amountCents: number } | null;
}

export interface ReviewCredit {
	personId: string;
	personName: string;
	creditCents: number;
	/** Laatste overboeking die tegoed werd */
	date: string;
	/**
	 * `dubbel`: meer ontvangen dan er openstond terwijl het aandeel loopt; `vertrokken`: het
	 * aandeel is afgelopen; `teveel`: zonder gedeelde last, zoals een te hoge Tikkie.
	 */
	reason: 'dubbel' | 'vertrokken' | 'teveel';
}

export type ReviewReminder = OpenPost & { daysOpen: number };

/**
 * Een bon die op je wacht (spec: Bonnetjes en koppelen): onzeker of niet te lezen, gelezen maar
 * zonder duidelijke koppeling (kiezen), of verwerkt met twijfel (nakijken). Alleen de
 * gecontroleerde velden, nooit de ruwe uitvoer van Haiku.
 */
export interface ReviewReceipt {
	id: string;
	stage: 'nakijken' | 'kiezen' | 'onzeker' | 'fout';
	source: 'app' | 'deelmenu';
	store: string | null;
	date: string | null;
	totalCents: number | null;
	currency: string | null;
	/** Velden waarover Haiku twijfelde of die de controles niet haalden. */
	doubt: ReceiptField[];
	/** De transactie die er al bij hoort (bij nakijken), zonder IBAN */
	transaction: { counterparty: string; date: string; amountCents: number } | null;
	createdAt: string;
}

export interface ReviewInbox {
	/** Bonnen: onzeker, niet te lezen, zelf te koppelen of na te kijken */
	receipts: ReviewReceipt[];
	/** Verwachte vaste lasten, een week na de verwachte dag: gemist of opgezegd? */
	missed: Awaiting[];
	/** Boekingen op te controleren: storno's, ontbrekend eurobedrag, losgemaakte terugboekingen */
	transactions: ReviewTransaction[];
	/** Aandelen in een gedeelde vaste last die een week na de ontvangstdag niet binnen zijn */
	late: DueReceipt[];
	/** Tegoed dat niet als vooruitbetaling te verklaren is: dubbel betaald of na vertrek */
	credit: ReviewCredit[];
	/** Posten te krijgen die 14 dagen of langer openstaan */
	reminders: ReviewReminder[];
}

const keyOf = (kind: LeaveKind, id: string) => `${kind}:${id}`;

function leftKeys(db: Conn): Set<string> {
	return new Set(
		db
			.select({ key: auditLog.entityId })
			.from(auditLog)
			.where(and(eq(auditLog.entity, 'review'), eq(auditLog.action, 'laten_staan')))
			.all()
			.flatMap((r) => (r.key ? [r.key] : []))
	);
}

function reviewTransactions(db: Conn): ReviewTransaction[] {
	const rows = db
		.select({
			id: transactions.id,
			amountCents: transactions.amountCents,
			date: transactions.date,
			counterparty: transactions.counterparty,
			categoryName: categories.name,
			categoryGroup: categories.group,
			accountAlias: accounts.alias,
			origAmountCents: transactions.origAmountCents,
			origCurrency: transactions.origCurrency
		})
		.from(transactions)
		.innerJoin(accounts, eq(accounts.id, transactions.accountId))
		.leftJoin(categories, eq(categories.id, transactions.categoryId))
		.where(
			and(
				eq(transactions.status, 'te_controleren'),
				// Hoort hij bij een bon die nog nagekeken wordt, dan staat hij daar
				notExists(
					db
						.select({ id: receipts.id })
						.from(receipts)
						.where(and(eq(receipts.transactionId, transactions.id), isNull(receipts.handledAt)))
				)
			)
		)
		.orderBy(asc(transactions.date), asc(transactions.createdAt))
		.all();
	return rows.map((r, i) => {
		const base = { ...r, status: 'te_controleren' as const, match: null };
		if (r.amountCents === 0) return { ...base, reason: 'bedrag' as const };
		const { candidates, preselect } =
			i < MATCH_LIMIT ? correctionCandidates(db, r.id) : { candidates: [], preselect: null };
		const best = candidates.find((c) => c.id === preselect) ?? candidates[0];
		if (!best) return { ...base, reason: 'controleren' as const };
		return {
			...base,
			reason: 'koppelen' as const,
			match: { counterparty: best.counterparty, date: best.date, amountCents: best.amountCents }
		};
	});
}

/**
 * Tegoed per persoon dat aandacht vraagt (spec: Gedeelde vaste lasten, Dubbel betaald en
 * Huisgenoot vertrekt). Een overboeking kort voor de volgende ontvangstdag, voordat die post er
 * is, is gewoon vooruitbetaald en gaat stil naar die post ("op de 28e voor de wifi van de 1e").
 */
function reviewCredit(db: Conn, today: string, left: Set<string>): ReviewCredit[] {
	const rows = db
		.select({
			transactionId: owedPayments.transactionId,
			personId: owedPayments.personId,
			personName: people.name,
			amountCents: owedPayments.amountCents,
			date: transactions.date
		})
		.from(owedPayments)
		.innerJoin(transactions, eq(transactions.id, owedPayments.transactionId))
		.innerJoin(people, eq(people.id, owedPayments.personId))
		.where(and(isNull(owedPayments.owedId), sql`${transactions.amountCents} > 0`))
		.orderBy(asc(transactions.date))
		.all();
	if (rows.length === 0) return [];

	const personIds = [...new Set(rows.map((r) => r.personId))];
	const shares = db
		.select({ s: recurringShares, median: recurring.medianCents })
		.from(recurringShares)
		.innerJoin(recurring, eq(recurring.id, recurringShares.recurringId))
		.where(and(inArray(recurringShares.personId, personIds), eq(recurring.status, 'actief')))
		.all();
	const posted = new Set(
		db
			.select({ shareId: owed.shareId, month: owed.month })
			.from(owed)
			.where(and(isNotNull(owed.shareId), inArray(owed.personId, personIds)))
			.all()
			.map((p) => `${p.shareId}|${p.month}`)
	);

	const paidAhead = new Map<string, number>();
	/**
	 * Vooruitbetaald: past, samen met wat eerder al vooruitbetaald was, binnen de aandelen van de
	 * eerstvolgende ontvangstdag zonder post.
	 */
	const early = (personId: string, date: string, cents: number) => {
		const month = date.slice(0, 7);
		const due = shares
			.filter(({ s }) => s.personId === personId)
			.flatMap(({ s, median }) =>
				[month, shiftMonth(month, 1)]
					.filter((m) => isActive(s, m) && !posted.has(`${s.id}|${m}`))
					.map((m) => ({ date: receiveDate(m, s.receiveDay), cents: shareCents(s, median) }))
			)
			.filter((d) => d.date >= date)
			.sort((a, b) => a.date.localeCompare(b.date));
		const next = due[0];
		if (!next || daysBetween(date, next.date) > EARLY_DAYS) return false;
		const sameDay = due.filter((d) => d.date === next.date).reduce((s, d) => s + d.cents, 0);
		const ahead = (paidAhead.get(personId) ?? 0) + cents;
		if (ahead > sameDay) return false;
		paidAhead.set(personId, ahead);
		return true;
	};

	const month = today.slice(0, 7);
	const byPerson = new Map<string, ReviewCredit & { flagged: boolean }>();
	for (const r of rows) {
		const entry = byPerson.get(r.personId) ?? {
			personId: r.personId,
			personName: r.personName,
			creditCents: 0,
			date: r.date,
			reason: 'teveel' as const,
			flagged: false
		};
		entry.creditCents += r.amountCents;
		entry.date = r.date;
		if (!left.has(keyOf('tegoed', r.transactionId)) && !early(r.personId, r.date, r.amountCents))
			entry.flagged = true;
		byPerson.set(r.personId, entry);
	}
	return [...byPerson.values()]
		.filter((e) => e.flagged)
		.map(({ flagged: _flagged, ...e }) => {
			const mine = shares.filter(({ s }) => s.personId === e.personId);
			const running = mine.some(({ s }) => isActive(s, month) || isActive(s, shiftMonth(month, 1)));
			const hadShare =
				mine.length > 0 ||
				db
					.select({ id: recurringShares.id })
					.from(recurringShares)
					.where(eq(recurringShares.personId, e.personId))
					.get() !== undefined;
			return {
				...e,
				reason: running
					? ('dubbel' as const)
					: hadShare
						? ('vertrokken' as const)
						: ('teveel' as const)
			};
		});
}

const DOUBT_FIELDS: ReceiptField[] = ['winkel', 'datum', 'totaal', 'valuta'];

function reviewReceipts(db: Conn): ReviewReceipt[] {
	const rows = db
		.select({
			r: receipts,
			txCounterparty: transactions.counterparty,
			txDate: transactions.date,
			txAmount: transactions.amountCents
		})
		.from(receipts)
		.leftJoin(transactions, eq(transactions.id, receipts.transactionId))
		.where(and(isNull(receipts.handledAt), ne(receipts.status, 'wordt_gelezen')))
		.orderBy(asc(receipts.createdAt))
		.all();
	return rows.flatMap(({ r, txCounterparty, txDate, txAmount }) => {
		const stage = receiptStage(r);
		if (stage === 'klaar' || stage === 'wordt_gelezen') return [];
		const { fields, confidence } = readStored(r.checkedFields, r.fieldConfidence);
		return [
			{
				id: r.id,
				stage,
				source: r.source,
				store: fields.store,
				date: fields.date,
				totalCents: fields.totalCents,
				currency: fields.currency,
				doubt: stage === 'fout' ? [] : DOUBT_FIELDS.filter((f) => confidence[f].status !== 'zeker'),
				transaction:
					txCounterparty !== null && txDate !== null && txAmount !== null
						? { counterparty: txCounterparty, date: txDate, amountCents: txAmount }
						: null,
				createdAt: r.createdAt
			}
		];
	});
}

/** Alles wat op controle wacht, per soort. */
export function reviewInbox(db: DB, today = toIsoDate(new Date())): ReviewInbox {
	const left = leftKeys(db);
	const due = dueReceipts(db, today);
	const shareIds = new Set(due.map((d) => d.id));
	return {
		receipts: reviewReceipts(db),
		missed: awaitingConfirmation(db, today).filter((e) => e.missed),
		transactions: reviewTransactions(db),
		late: due.filter((d) => d.late && !left.has(keyOf('te_laat', d.id))),
		credit: reviewCredit(db, today, left),
		// Een maandaandeel dat te laat is staat al bij te laat
		reminders: owedReminders(db, today)
			.filter((p) => !shareIds.has(p.id) && !left.has(keyOf('herinnering', p.id)))
			.map((p) => ({ ...p, daysOpen: daysBetween(p.date, today) }))
	};
}

/** Aantal voor het signaalkaartje op het startscherm. */
export function inboxCount(inbox: ReviewInbox): number {
	return Object.values(inbox).reduce((n, items: unknown[]) => n + items.length, 0);
}

/**
 * Laten staan: de post verdwijnt uit de review-inbox en blijft verder zoals hij was. Bij tegoed
 * gaat het om de overboekingen die nu tegoed zijn; een nieuwe overboeking meldt zich weer. Staat
 * in het audit-log, dat ook bijhoudt wat je liet staan.
 */
export function leaveInInbox(
	db: DB,
	kind: LeaveKind,
	id: string,
	today = toIsoDate(new Date())
): void {
	db.transaction((tx) => {
		const left = leftKeys(tx);
		let ids: string[];
		if (kind === 'tegoed') {
			ids = tx
				.select({ id: owedPayments.transactionId })
				.from(owedPayments)
				.innerJoin(transactions, eq(transactions.id, owedPayments.transactionId))
				.where(
					and(
						eq(owedPayments.personId, id),
						isNull(owedPayments.owedId),
						sql`${transactions.amountCents} > 0`
					)
				)
				.all()
				.map((r) => r.id)
				.filter((t) => !left.has(keyOf('tegoed', t)));
		} else {
			const post = tx.select().from(owed).where(eq(owed.id, id)).get();
			const open = post && (post.status === 'open' || post.status === 'deels');
			const fits =
				kind === 'te_laat'
					? post?.shareId != null
					: post?.direction === 'te_krijgen' && post.date <= addDays(today, -REMIND_AFTER_DAYS);
			ids = open && fits && !left.has(keyOf(kind, id)) ? [id] : [];
		}
		if (ids.length === 0) throw new ValidationError('Deze post staat niet meer te controleren');
		for (const t of ids) recordChange(tx, 'laten_staan', 'review', keyOf(kind, t), null, null);
	});
}
