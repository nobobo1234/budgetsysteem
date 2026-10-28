import { asc, eq, inArray, min, ne, sql } from 'drizzle-orm';
import {
	categorySeries,
	categoryTotals,
	cells,
	monthTotals,
	topCounterparties,
	type Cell,
	type Part,
	type Reserved
} from '../analyses.ts';
import { daysInMonth, formatMonth } from '../dates.ts';
import { coverage, coveragePercent, distribute, type Bucket } from '../groceries.ts';
import { PRODUCT_GROUP_LABEL } from '../productGroups.ts';
import { answerSentence, queryLines, type Answer, type AnswerRow } from '../semantic/answer.ts';
import { MAX_ROWS, type Query, type Sort } from '../semantic/format.ts';
import {
	resolveQuery,
	type Catalog,
	type Resolution,
	type ResolvedQuery
} from '../semantic/resolve.ts';
import { tagSpend, type TagLine } from '../tags.ts';
import { displayName, modelName, normalize } from '../text.ts';
import { NO_CATEGORY, reservedByMonth, spendingParts } from './analyses.ts';
import { monthOverview } from './budgets.ts';
import type { DB } from './db/index.ts';
import { accounts, categories, tags, transactions } from './db/schema.ts';
import { groceriesCategoryId, groceryPurchases } from './groceries.ts';
import { owedOverview } from './owed.ts';
import { incomeRows, isIncomeCategory, type IncomeRow } from './startLimits.ts';
import { tagLines } from './tags.ts';

// De semantische laag op de server (spec: Vragen en samenvattingen met AI → Semantische laag):
// code vertaalt het vraagformaat naar queries met parameters, via dezelfde functies als Budget en
// Analyses (`spendingParts`, `cells`, `monthOverview`, `tagSpend`, `groceryPurchases`,
// `incomeRows`). Er komt geen tweede rekenwijze bij en geen vrije SQL: wat `resolveQuery` niet
// kent, is al geweigerd voordat hier iets draait.

const CHUNK = 500;

/** Namen van tegenpartijen zoals in een antwoord: netjes en ingekort (spec: Namen van tegenpartijen). */
export const shownName = (raw: string) => modelName(displayName(raw)) || 'Zonder naam';

/** De catalogus: wat er bestaat aan categorieën, tags, rekeningen en tegenpartijen. */
export function catalog(db: DB): Catalog {
	const cats = db
		.select({
			id: categories.id,
			name: categories.name,
			group: categories.group,
			countsForBudget: categories.countsForBudget
		})
		.from(categories)
		.where(eq(categories.archived, false))
		.orderBy(asc(categories.sortOrder), asc(categories.name))
		.all();
	const seen = new Map<string, string>();
	for (const r of db
		.selectDistinct({ counterparty: transactions.counterparty })
		.from(transactions)
		.where(ne(transactions.status, 'verwacht'))
		.all()) {
		const name = modelName(displayName(r.counterparty));
		if (name && !seen.has(normalize(name))) seen.set(normalize(name), name);
	}
	return {
		categories: cats.map((c) => ({ ...c, income: isIncomeCategory(c) })),
		tags: db.select({ id: tags.id, name: tags.name }).from(tags).orderBy(asc(tags.name)).all(),
		accounts: db
			.select({ id: accounts.id, name: accounts.name, alias: accounts.alias })
			.from(accounts)
			.orderBy(asc(accounts.name))
			.all(),
		counterparties: [...seen.values()].sort((a, b) => a.localeCompare(b, 'nl'))
	};
}

/** De eerste geboekte dag, voor de periode `alles`. */
export function earliestDate(db: DB, today: string): string {
	return (
		db
			.select({ first: min(transactions.date) })
			.from(transactions)
			.where(ne(transactions.status, 'verwacht'))
			.get()?.first ?? today
	);
}

function accountsOf(db: DB, ids: readonly string[]): Map<string, string> {
	const out = new Map<string, string>();
	for (let i = 0; i < ids.length; i += CHUNK) {
		for (const r of db
			.select({ id: transactions.id, accountId: transactions.accountId })
			.from(transactions)
			.where(inArray(transactions.id, ids.slice(i, i + CHUNK)))
			.all())
			out.set(r.id, r.accountId);
	}
	return out;
}

/** Transacties met een tag, plus de terugboekingen daarop (zoals op de pagina van de tag). */
function taggedIds(db: DB, tagId: string): Set<string> {
	const rows = db.all<{ id: string }>(sql`
		SELECT t.id FROM transaction_tags tt JOIN transactions t ON t.id = tt.transaction_id
		WHERE tt.active = 1 AND tt.tag_id = ${tagId} AND t.correction_of IS NULL
		UNION
		SELECT c.id FROM transaction_tags tt JOIN transactions c ON c.correction_of = tt.transaction_id
		WHERE tt.active = 1 AND tt.tag_id = ${tagId}
	`);
	return new Set(rows.map((r) => r.id));
}

const categoryIds = (r: ResolvedQuery) =>
	r.categories ? new Set<string | null>(r.categories.map((c) => c.id)) : null;

/** Geboekte delen zoals op Budget, met de filters van de vraag erop. */
function filteredParts(db: DB, r: ResolvedQuery): Part[] {
	let parts = spendingParts(db, r.period.from, r.period.to);
	const ids = categoryIds(r);
	if (ids) parts = parts.filter((p) => ids.has(p.categoryId));
	if (r.counterparty) {
		const wanted = normalize(r.counterparty);
		parts = parts.filter((p) => normalize(shownName(p.counterparty)) === wanted);
	}
	if (r.account) {
		const of = accountsOf(db, [...new Set(parts.map((p) => p.id))]);
		parts = parts.filter((p) => of.get(p.id) === r.account!.id);
	}
	if (r.tag) {
		const tagged = taggedIds(db, r.tag.id);
		parts = parts.filter((p) => tagged.has(p.id));
	}
	return parts;
}

/**
 * Reserveringen van de maanden waarvan de eerste in de periode valt: een reservering telt vanaf
 * de eerste van de maand, zoals op Budget.
 */
function reservedIn(db: DB, r: ResolvedQuery): Reserved[] {
	const months = r.period.months.filter((m) => `${m}-01` >= r.period.from);
	if (months.length === 0) return [];
	const ids = categoryIds(r);
	return reservedByMonth(db, months[0]!, months.at(-1)!).filter(
		(x) => months.includes(x.month) && (!ids || ids.has(x.categoryId))
	);
}

interface Computed {
	value: number;
	rows: AnswerRow[] | null;
	assumptions: string[];
	/** Hoeveel volle maanden in een gemiddelde zitten */
	monthsUsed?: number;
}

const NOTE_BUDGET =
	'alleen categorieën die meetellen voor het budget, plus uitgaven zonder categorie';
const NOTE_PARTS =
	'bij een verdeling telt alleen jouw deel; een terugboeking telt in de maand van de boeking die hij verrekent';
const NOTE_RESERVED = 'reserveringen voor vaste lasten tellen als uitgave, zoals op Budget';
const NOTE_NET = 'per saldo: een retour verlaagt het bedrag; reserveringen tellen hier niet mee';
const NOTE_INCOME = 'zonder interne overboekingen, terugboekingen en wat anderen je terugbetaalden';

function spendingNotes(r: ResolvedQuery, perTransaction: boolean): string[] {
	const notes = r.categories ? [] : [NOTE_BUDGET];
	notes.push(NOTE_PARTS, perTransaction ? NOTE_NET : NOTE_RESERVED);
	return notes;
}

function categoryName(cat: Catalog, id: string | null): string {
	return id === null ? NO_CATEGORY : (cat.categories.find((c) => c.id === id)?.name ?? NO_CATEGORY);
}

function monthRows(months: readonly string[], value: (m: string) => number): AnswerRow[] {
	return months.map((m) => ({ key: m, label: formatMonth(m), value: value(m) }));
}

function sumBy<T>(items: readonly T[], key: (t: T) => string, value: (t: T) => number) {
	const out = new Map<string, number>();
	for (const t of items) out.set(key(t), (out.get(key(t)) ?? 0) + value(t));
	return out;
}

/** Uitgegeven, vaste lasten en aantal: de delen van Budget met de filters van de vraag. */
function fromParts(db: DB, r: ResolvedQuery, cat: Catalog): Computed {
	const { maat, groeperen } = r.query;
	const parts = filteredParts(db, r);
	// Per transactie (tegenpartij, rekening, tag) telt per saldo, zonder reserveringen
	const perTransaction = r.counterparty !== null || r.account !== null || r.tag !== null;
	const list: Cell[] = perTransaction ? [] : cells(parts, reservedIn(db, r));
	const months = r.period.months;

	if (maat === 'aantal') {
		const spent = parts.filter((p) => p.cents > 0);
		const count = (ps: readonly Part[]) => new Set(ps.map((p) => p.id)).size;
		const by = (key: (p: Part) => string) =>
			[...Map.groupBy(spent, key)].map(([k, ps]) => ({ key: k, ps }));
		let rows: AnswerRow[] | null = null;
		if (groeperen === 'maand')
			rows = monthRows(months, (m) => count(spent.filter((p) => p.date.startsWith(m))));
		else if (groeperen === 'categorie')
			rows = by((p) => p.categoryId ?? '').map(({ key, ps }) => ({
				key,
				label: categoryName(cat, key || null),
				value: count(ps)
			}));
		else if (groeperen === 'tegenpartij')
			rows = by((p) => normalize(shownName(p.counterparty))).map(({ key, ps }) => ({
				key,
				label: shownName(ps[0]!.counterparty),
				value: count(ps)
			}));
		return {
			value: count(spent),
			rows,
			assumptions: [
				'aantal = transacties met een uitgave; een verdeelde transactie telt één keer',
				...(r.categories ? [] : [NOTE_BUDGET])
			]
		};
	}

	const fixed = maat === 'vaste_lasten';
	const assumptions = spendingNotes(r, perTransaction);
	if (fixed)
		assumptions.unshift(
			'vaste lasten = afschrijvingen van een vaste last (gekoppeld of met dezelfde sleutel) plus reserveringen'
		);
	const cellValue = (c: Cell) => (fixed ? c.fixedCents : c.spentCents);
	const partValue = (p: Part) => (fixed ? (p.fixed ? p.cents : 0) : p.cents);
	const value = perTransaction
		? parts.reduce((s, p) => s + partValue(p), 0)
		: list.reduce((s, c) => s + cellValue(c), 0);

	let rows: AnswerRow[] | null = null;
	if (groeperen === 'maand') {
		if (perTransaction) {
			const by = sumBy(parts, (p) => p.date.slice(0, 7), partValue);
			rows = monthRows(months, (m) => by.get(m) ?? 0);
		} else {
			const totals = monthTotals(list, months);
			rows = totals.map((t) => ({
				key: t.month,
				label: formatMonth(t.month),
				value: fixed ? t.fixedCents : t.spentCents
			}));
		}
	} else if (groeperen === 'categorie') {
		const sums = perTransaction
			? [...sumBy(parts, (p) => p.categoryId ?? '', partValue)].map(([k, cents]) => ({
					categoryId: k || null,
					cents
				}))
			: fixed
				? [
						...sumBy(
							list,
							(c) => c.categoryId ?? '',
							(c) => c.fixedCents
						)
					].map(([k, cents]) => ({
						categoryId: k || null,
						cents
					}))
				: categoryTotals(list);
		rows = sums
			.filter((s) => s.cents !== 0)
			.map((s) => ({
				key: s.categoryId ?? '',
				label: categoryName(cat, s.categoryId),
				value: s.cents
			}));
	} else if (groeperen === 'tegenpartij') {
		// Zoals de topuitgaven op Analyses: filialen samen via de nette naam, alleen wie per saldo
		// geld kreeg
		rows = topCounterparties(parts, Number.MAX_SAFE_INTEGER).map((c) => ({
			key: normalize(modelName(c.name)),
			label: modelName(c.name) || 'Zonder naam',
			value: c.cents
		}));
		assumptions.push('per tegenpartij: filialen tellen samen, een retour verlaagt het bedrag');
	}
	return { value, rows, assumptions };
}

/** Uitgegeven met een tag: zoals op de pagina van de tag (`tagSpend`). */
function fromTags(db: DB, r: ResolvedQuery, cat: Catalog): Computed {
	const { from, to } = r.period;
	const ids = categoryIds(r);
	const all = tagLines(db);
	const linesOf = (tagId: string) =>
		(all.get(tagId) ?? []).filter(
			(l) => l.date >= from && l.date <= to && (!ids || ids.has(l.categoryId))
		);
	const assumptions = [
		'zoals op de pagina van de tag: alleen categorieën die meetellen, zonder het voorgeschoten deel van een gedeelde uitgave',
		NOTE_PARTS
	];
	if (r.query.groeperen === 'tag') {
		const rows = cat.tags
			.map((t) => ({ key: t.id, label: t.name, value: tagSpend(linesOf(t.id)).totalCents }))
			.filter((row) => row.value !== 0);
		assumptions.push('een transactie met twee tags telt bij allebei');
		return { value: rows.reduce((s, x) => s + x.value, 0), rows, assumptions };
	}
	const lines: (TagLine & { date: string })[] = linesOf(r.tag!.id);
	const spend = tagSpend(lines);
	let rows: AnswerRow[] | null = null;
	if (r.query.groeperen === 'maand') {
		const by = Map.groupBy(lines, (l) => l.date.slice(0, 7));
		rows = monthRows(r.period.months, (m) => tagSpend(by.get(m) ?? []).totalCents);
	} else if (r.query.groeperen === 'categorie')
		rows = spend.byCategory.map((c) => ({
			key: c.categoryId ?? '',
			label: c.categoryId === null ? NO_CATEGORY : c.name,
			value: c.cents
		}));
	return { value: spend.totalCents, rows, assumptions };
}

const BUCKET_LABEL = (bucket: Bucket) =>
	bucket === 'zonder_groep'
		? 'Nog geen groep'
		: bucket === 'overige_regels'
			? 'Statiegeld en overig'
			: PRODUCT_GROUP_LABEL[bucket];

/** Boodschappen per productgroep, uit bonregels (zoals op Boodschappen), met de dekking. */
function fromGroceries(db: DB, r: ResolvedQuery): Computed {
	const months = r.period.months;
	const id = groceriesCategoryId(db);
	const purchases = id
		? groceryPurchases(db, id, months[0]!, months.at(-1)!).filter((p) => months.includes(p.month))
		: [];
	const share = coverage(purchases).share;
	const assumptions = [
		share === null
			? 'geen boodschappen in deze periode'
			: `${coveragePercent(share)}% van je boodschappen in deze periode heeft een bon met regels; alleen die tellen hier`,
		'per hele maand, zoals op Boodschappen'
	];
	const lines = purchases.flatMap((p) => p.lines);
	const group = r.productGroup;
	if (group) {
		assumptions.push('kortingen en bonus tellen niet per groep');
		const of = (ls: typeof lines) => distribute(ls).buckets.get(group) ?? 0;
		const rows =
			r.query.groeperen === 'maand'
				? monthRows(months, (m) => of(lines.filter((l) => l.date.startsWith(m))))
				: null;
		return { value: of(lines), rows, assumptions };
	}
	const d = distribute(lines);
	const rows: AnswerRow[] = [...d.buckets]
		.filter(([, cents]) => cents !== 0)
		.map(([bucket, cents]) => ({ key: bucket, label: BUCKET_LABEL(bucket), value: cents }));
	if (d.discountCents !== 0)
		rows.push({ key: 'korting', label: 'Korting en bonus', value: d.discountCents });
	assumptions.push('kortingen en bonus staan als één regel');
	return { value: d.totalCents, rows, assumptions };
}

/** Gemiddeld per maand, zoals op Trend: volle maanden vanaf de eerste maand met uitgaven. */
function average(db: DB, r: ResolvedQuery, cat: Catalog): Computed {
	const months = r.period.fullMonths;
	const first = months[0]!;
	const last = months.at(-1)!;
	const all = cells(
		spendingParts(db, `${first}-01`, `${last}-${daysInMonth(last)}`),
		reservedByMonth(db, first, last)
	);
	const start = monthTotals(all, months).findIndex((t) => t.spentCents > 0);
	const used = start < 0 ? [] : months.slice(start);
	const avg = (values: readonly number[]) =>
		used.length === 0 ? 0 : Math.round(values.reduce((s, v) => s + v, 0) / used.length);
	const ids = categoryIds(r);
	const list = ids ? all.filter((c) => ids.has(c.categoryId)) : all;
	const value = avg(monthTotals(list, used).map((t) => t.spentCents));
	const rows =
		r.query.groeperen === 'categorie'
			? categoryTotals(list.filter((c) => used.includes(c.month))).map((c) => ({
					key: c.categoryId ?? '',
					label: categoryName(cat, c.categoryId),
					value: avg(categorySeries(list, used, c.categoryId))
				}))
			: null;
	return {
		value,
		rows,
		monthsUsed: used.length,
		assumptions: [
			'gemiddelde over de volle maanden, vanaf de eerste maand met uitgaven; de lopende maand telt niet mee',
			...spendingNotes(r, false)
		]
	};
}

/** Limieten per maand, zoals op Budget. */
function limits(db: DB, r: ResolvedQuery, today: string): Computed {
	const ids = categoryIds(r);
	const perMonth = r.period.months.map((m) => ({
		month: m,
		lines: monthOverview(db, m, today).lines.filter((l) => !ids || ids.has(l.categoryId))
	}));
	const value = perMonth.reduce((s, m) => s + m.lines.reduce((t, l) => t + l.limitCents, 0), 0);
	let rows: AnswerRow[] | null = null;
	if (r.query.groeperen === 'maand')
		rows = perMonth.map((m) => ({
			key: m.month,
			label: formatMonth(m.month),
			value: m.lines.reduce((t, l) => t + l.limitCents, 0)
		}));
	else if (r.query.groeperen === 'categorie') {
		const lines = perMonth.flatMap((m) => m.lines);
		rows = [
			...sumBy(
				lines,
				(l) => l.categoryId,
				(l) => l.limitCents
			)
		]
			.filter(([, cents]) => cents !== 0)
			.map(([id, cents]) => ({
				key: id,
				label: lines.find((l) => l.categoryId === id)!.name,
				value: cents
			}));
	}
	return {
		value,
		rows,
		assumptions: [
			r.period.months.length > 1 ? 'de limieten van elke maand opgeteld' : 'de limieten van Budget'
		]
	};
}

/** Nog vrij in één maand: zoals op Budget, of per categorie de limiet min wat er uitging. */
function remaining(db: DB, r: ResolvedQuery, today: string): Computed {
	const overview = monthOverview(db, r.period.months[0]!, today);
	const ids = categoryIds(r);
	const lines = overview.lines.filter((l) => !ids || ids.has(l.categoryId));
	const withLimit = lines.filter((l) => l.limitCents > 0);
	const rows =
		r.query.groeperen === 'categorie'
			? withLimit.map((l) => ({
					key: l.categoryId,
					label: l.name,
					value: l.limitCents - l.spentCents
				}))
			: null;
	const assumptions: string[] = [];
	const noLimit = lines.filter((l) => l.limitCents === 0).map((l) => l.name);
	if (ids && noLimit.length > 0)
		assumptions.push(`zonder limiet, telt niet mee: ${noLimit.join(', ')}`);
	if (!ids) {
		assumptions.push(
			'nog vrij zoals op Budget: de limieten min alle uitgaven, ook in categorieën zonder limiet en zonder categorie'
		);
		return { value: overview.freeCents, rows, assumptions };
	}
	assumptions.push('per categorie de limiet min wat er uitging, met reserveringen');
	return {
		value: withLimit.reduce((s, l) => s + l.limitCents - l.spentCents, 0),
		rows,
		assumptions
	};
}

/** Inkomsten zoals bij de startlimieten (`incomeRows`), met de filters van de vraag. */
function income(db: DB, r: ResolvedQuery, cat: Catalog): Computed {
	let rows: IncomeRow[] = incomeRows(db, r.period.from, r.period.to);
	const ids = categoryIds(r);
	if (ids) rows = rows.filter((x) => ids.has(x.categoryId));
	if (r.counterparty) {
		const wanted = normalize(r.counterparty);
		rows = rows.filter((x) => normalize(shownName(x.counterparty)) === wanted);
	}
	if (r.account) rows = rows.filter((x) => x.accountId === r.account!.id);
	const value = rows.reduce((s, x) => s + x.cents, 0);
	let out: AnswerRow[] | null = null;
	const { groeperen } = r.query;
	if (groeperen === 'maand') {
		const by = sumBy(
			rows,
			(x) => x.date.slice(0, 7),
			(x) => x.cents
		);
		out = monthRows(r.period.months, (m) => by.get(m) ?? 0);
	} else if (groeperen === 'categorie')
		out = [
			...sumBy(
				rows,
				(x) => x.categoryId ?? '',
				(x) => x.cents
			)
		].map(([k, cents]) => ({
			key: k,
			label: categoryName(cat, k || null),
			value: cents
		}));
	else if (groeperen === 'tegenpartij')
		out = [...Map.groupBy(rows, (x) => normalize(shownName(x.counterparty)))].map(([k, xs]) => ({
			key: k,
			label: shownName(xs[0]!.counterparty),
			value: xs.reduce((s, x) => s + x.cents, 0)
		}));
	return { value, rows: out, assumptions: [`inkomsten ${NOTE_INCOME}`] };
}

/** Netto: inkomsten min uitgaven zoals op Budget. */
function net(db: DB, r: ResolvedQuery, cat: Catalog): Computed {
	const inc = income(db, { ...r, query: { ...r.query, groeperen: 'maand' } }, cat);
	const spent = fromParts(
		db,
		{ ...r, query: { ...r.query, maat: 'uitgegeven', groeperen: 'maand' } },
		cat
	);
	const spentBy = new Map(spent.rows!.map((x) => [x.key, x.value]));
	const rows =
		r.query.groeperen === 'maand'
			? inc.rows!.map((x) => ({ ...x, value: x.value - (spentBy.get(x.key) ?? 0) }))
			: null;
	return {
		value: inc.value - spent.value,
		rows,
		assumptions: [...inc.assumptions, ...spendingNotes(r, false)]
	};
}

function compute(db: DB, r: ResolvedQuery, cat: Catalog, today: string): Computed {
	switch (r.query.maat) {
		case 'uitgegeven':
			if (r.productGroup !== null || r.query.groeperen === 'productgroep')
				return fromGroceries(db, r);
			if (r.tag !== null || r.query.groeperen === 'tag') return fromTags(db, r, cat);
			return fromParts(db, r, cat);
		case 'aantal':
		case 'vaste_lasten':
			return fromParts(db, r, cat);
		case 'gemiddeld_per_maand':
			return average(db, r, cat);
		case 'limiet':
			return limits(db, r, today);
		case 'resterend':
			return remaining(db, r, today);
		case 'inkomsten':
			return income(db, r, cat);
		case 'netto':
			return net(db, r, cat);
		case 'te_krijgen':
			return {
				value: owedOverview(db, today).toReceiveCents,
				rows: null,
				assumptions: ['wat anderen je nu nog moeten, los van de periode']
			};
	}
}

function sortRows(rows: AnswerRow[], sort: Sort): AnswerRow[] {
	const byName = (a: AnswerRow, b: AnswerRow) => a.label.localeCompare(b.label, 'nl');
	switch (sort) {
		case 'bedrag_aflopend':
			return rows.toSorted((a, b) => b.value - a.value || byName(a, b));
		case 'bedrag_oplopend':
			return rows.toSorted((a, b) => a.value - b.value || byName(a, b));
		case 'naam':
			return rows.toSorted(byName);
		case 'periode':
			return rows.toSorted((a, b) => a.key.localeCompare(b.key) || byName(a, b));
	}
}

export type QueryResult = { ok: true; answer: Answer } | Exclude<Resolution, { ok: true }>;

/**
 * Een vraag in het vraagformaat uitgerekend: het getal of de lijst uit code, de zin uit een
 * vaste template, met de aannames van code en daarna die van het model.
 *
 * @param today vandaag in Nederland (`todayIn`)
 * @param choice bij een verduidelijking door code: welke tegenpartij uit de keuzes
 */
export function runQuery(
	db: DB,
	query: Query,
	today: string,
	opts: { choice?: number; catalog?: Catalog } = {}
): QueryResult {
	const cat = opts.catalog ?? catalog(db);
	const resolution = resolveQuery(query, cat, today, {
		earliest: earliestDate(db, today),
		choice: opts.choice
	});
	if (!resolution.ok) return resolution;
	const r = resolution.resolved;
	const computed = compute(db, r, cat, today);
	const rows = computed.rows ? sortRows(computed.rows, query.sorteren) : null;
	const limit = query.limiet ?? MAX_ROWS;
	const assumptions = [
		...(query.maat === 'te_krijgen' ? [] : [r.period.assumption]),
		...r.assumptions,
		...computed.assumptions,
		...query.aannames
	];
	return {
		ok: true,
		answer: {
			measure: query.maat,
			grouping: query.groeperen,
			unit: query.maat === 'aantal' ? 'aantal' : 'cent',
			value: computed.value,
			rows: rows ? rows.slice(0, limit) : null,
			rowCount: rows?.length ?? 0,
			sentence: answerSentence(r, computed.value, computed.monthsUsed),
			assumptions,
			query: queryLines(query)
		}
	};
}
