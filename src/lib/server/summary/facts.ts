import { asc, inArray } from 'drizzle-orm';
import { cells, monthsFrom } from '../../analyses.ts';
import { shiftMonth } from '../../dates.ts';
import { coverage, distribute } from '../../groceries.ts';
import { PRODUCT_GROUP_LABEL, PRODUCT_GROUPS } from '../../productGroups.ts';
import { HISTORY_MONTHS, pickFacts, type Fact, type Series } from '../../summary.ts';
import { displayName, modelName, normalize, normalizeIban } from '../../text.ts';
import { NO_CATEGORY, reservedByMonth, spendingParts } from '../analyses.ts';
import { sha256 } from '../auth/crypto.ts';
import { hasMonthData } from '../closing.ts';
import type { DB } from '../db/index.ts';
import { categories, owedPayments, people, peopleIbans, transactions } from '../db/schema.ts';
import { groceriesCategoryId, groceryPurchases } from '../groceries.ts';
import { tagSpendByMonth } from '../tags.ts';

// De feiten voor de maandsamenvatting uit de database (spec: Maandsamenvatting, Feiten in code):
// per categorie, tegenpartij (nette naam), lopende tag en productgroep de bedragen van deze maand
// en de zes ervoor. Met dezelfde functies als Budget en Analyses: alleen categorieën die
// meetellen, splits, en terugboekingen in de maand van de boeking die ze verrekenen. Welke
// feiten opvallen, kiest `pickFacts`.

/** Twee aliassen in plaats van namen van personen (spec: Wat naar Haiku gaat). */
export const REPAYMENTS = 'verrekening huisgenoten';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const housemate = (index: number) =>
	`huisgenoot ${index < LETTERS.length ? LETTERS[index] : index + 1}`;

/**
 * Een productgroep telt pas in een maand als minstens de helft van de boodschappen een bon met
 * regels heeft; anders leest een lage dekking als weinig uitgeven (spec: Boodschappen, Dekking).
 */
export const MIN_GROCERY_COVERAGE = 0.5;

const CHUNK = 500;

/**
 * Per transactie de alias van een persoon: een terugbetaling (in `owed_payments`) telt bij
 * "verrekening huisgenoten", een tegen-IBAN van een persoon wordt "huisgenoot A". IBANs blijven
 * hier op de server; alleen de alias gaat verder.
 */
function personAliases(db: DB, ids: readonly string[]): Map<string, string> {
	const out = new Map<string, string>();
	if (ids.length === 0) return out;
	const order = db
		.select({ id: people.id })
		.from(people)
		.orderBy(asc(people.createdAt), asc(people.id))
		.all();
	const letter = new Map(order.map((p, i) => [p.id, housemate(i)]));
	const byIban = new Map(
		db
			.select({ iban: peopleIbans.iban, personId: peopleIbans.personId })
			.from(peopleIbans)
			.all()
			.map((r) => [r.iban, letter.get(r.personId)!])
	);
	for (let i = 0; i < ids.length; i += CHUNK) {
		const chunk = ids.slice(i, i + CHUNK);
		const repaid = new Set(
			db
				.select({ id: owedPayments.transactionId })
				.from(owedPayments)
				.where(inArray(owedPayments.transactionId, chunk))
				.all()
				.map((r) => r.id)
		);
		const rows = db
			.select({ id: transactions.id, iban: transactions.counterIban })
			.from(transactions)
			.where(inArray(transactions.id, chunk))
			.all();
		for (const r of rows) {
			if (repaid.has(r.id)) out.set(r.id, REPAYMENTS);
			else {
				const alias = r.iban ? byIban.get(normalizeIban(r.iban)) : undefined;
				if (alias) out.set(r.id, alias);
			}
		}
	}
	return out;
}

export interface MonthFacts {
	months: string[];
	facts: Fact[];
	/** Alle namen die niet letterlijk in een zin mogen (spec: Controle) */
	names: string[];
	/** Hash van de feiten: verandert hij, dan komt er een nieuwe samenvatting */
	key: string;
}

/** De reeksen van alle kandidaten en de namen die de app kent, voor `pickFacts` en de controle. */
export function monthSeries(
	db: DB,
	month: string
): { months: string[]; series: Series[]; names: string[] } {
	const first = shiftMonth(month, -HISTORY_MONTHS);
	const months = monthsFrom(first, month);
	const last = months.length - 1;
	// Een maand zonder boeking of limiet is van vóór de historie: geen gegevens, geen nul
	const known = months.map((m, i) => i === last || hasMonthData(db, m));
	const series: Series[] = [];
	const names = new Set<string>();
	const add = (kind: Series['kind'], name: string, cents: (m: string) => number | null) =>
		series.push({ kind, name, values: months.map((m, i) => (known[i] ? cents(m) : null)) });

	// Categorieën, zoals Budget: met reserveringen, nooit onder nul
	const parts = spendingParts(db, `${first}-01`, `${month}-31`);
	const catNames = new Map(
		db
			.select({ id: categories.id, name: categories.name })
			.from(categories)
			.all()
			.map((c) => [c.id, modelName(c.name)])
	);
	for (const n of catNames.values()) names.add(n);
	const byCategory = Map.groupBy(
		cells(parts, reservedByMonth(db, first, month)),
		(c) => c.categoryId
	);
	for (const [id, list] of byCategory) {
		const name = id === null ? NO_CATEGORY : catNames.get(id);
		if (!name) continue;
		const spent = new Map(list.map((c) => [c.month, c.spentCents]));
		add('categorie', name, (m) => spent.get(m) ?? 0);
	}

	// Tegenpartijen op hun nette naam; personen als alias. Per saldo, dus een retour of een
	// terugbetaling verlaagt het bedrag (en kan het negatief maken).
	const aliases = personAliases(db, [...new Set(parts.map((p) => p.id))]);
	const counterparties = new Map<string, { name: string; cents: Map<string, number> }>();
	for (const p of parts) {
		const shown = displayName(p.counterparty);
		const name = aliases.get(p.id) ?? modelName(shown);
		if (!aliases.has(p.id) && shown) names.add(name);
		if (!name) continue;
		const key = normalize(name);
		let c = counterparties.get(key);
		if (!c) counterparties.set(key, (c = { name, cents: new Map() }));
		const m = p.date.slice(0, 7);
		c.cents.set(m, (c.cents.get(m) ?? 0) + p.cents);
	}
	for (const c of counterparties.values()) add('tegenpartij', c.name, (m) => c.cents.get(m) ?? 0);

	// Tags die in de maand liepen
	for (const t of tagSpendByMonth(db, first, month)) {
		const name = modelName(t.name);
		names.add(name);
		if (name) add('tag', name, (m) => t.cents.get(m) ?? 0);
	}

	// Productgroepen uit bonregels, alleen in maanden met genoeg dekking
	const groceries = groceriesCategoryId(db);
	if (groceries) {
		const purchases = Map.groupBy(groceryPurchases(db, groceries, first, month), (p) => p.month);
		const perMonth = new Map(
			months.map((m) => {
				const list = purchases.get(m) ?? [];
				const share = coverage(list).share;
				return [
					m,
					share !== null && share >= MIN_GROCERY_COVERAGE
						? distribute(list.flatMap((p) => p.lines)).buckets
						: null
				];
			})
		);
		for (const group of PRODUCT_GROUPS) {
			names.add(PRODUCT_GROUP_LABEL[group]);
			add('productgroep', PRODUCT_GROUP_LABEL[group], (m) => {
				const buckets = perMonth.get(m);
				return buckets ? (buckets.get(group) ?? 0) : null;
			});
		}
	}

	// Ook echte namen van personen mogen nooit letterlijk in een zin, al krijgt het model ze niet
	for (const p of db.select({ name: people.name }).from(people).all()) names.add(modelName(p.name));
	names.add(NO_CATEGORY);
	names.delete('');
	return { months, series, names: [...names] };
}

/** Wat er in `month` opviel, met de sleutel om te zien of het sinds de vorige keer veranderde. */
export function monthFacts(db: DB, month: string): MonthFacts {
	const { months, series, names } = monthSeries(db, month);
	const facts = pickFacts(series, months);
	return { months, facts, names, key: sha256(JSON.stringify(facts)).slice(0, 32) };
}
