import { shiftMonth } from './dates.ts';
import { PRODUCT_GROUPS, type ProductGroup } from './productGroups.ts';

// Boodschappen per productgroep (spec: Analyses → Boodschappen per productgroep). Pure logica,
// zodat de verdeling, de kortingen en de dekking zonder database te testen zijn. De server haalt
// de aankopen in de categorie Boodschappen op, met de regels van hun bon.

/** De categorie waar het overzicht bij hoort (startcategorie in de groep Dagelijks). */
export const GROCERIES = 'Boodschappen';

/** Het overzicht van een maand, bereikbaar vanaf de categorie Boodschappen. */
export const groceriesHref = (month: string) => `/analyses/boodschappen?maand=${month}`;

export type GroceryLineKind =
	'artikel' | 'korting' | 'bonus' | 'statiegeld' | 'statiegeld_retour' | 'fooi' | 'overig';

export interface GroceryLine {
	id: string;
	receiptId: string;
	/** Zoals op de bon: onbetrouwbare tekst, alleen als gewone tekst tonen. */
	description: string;
	kind: GroceryLineKind;
	/** Met het teken waarmee de regel meetelt: korting en bonus negatief. */
	cents: number;
	group: ProductGroup | null;
	date: string;
	counterparty: string;
}

/** Eén uitgave in de categorie Boodschappen, met de regels van de bon die erbij hoort. */
export interface GroceryPurchase {
	id: string;
	month: string;
	/** Wat er in Boodschappen telt (bij een verdeling alleen dat deel), positief. */
	spentCents: number;
	/** Leeg als er geen bon met regels bij hoort. */
	lines: GroceryLine[];
}

/**
 * Waar een regel in de verdeling heen gaat: een productgroep, "nog geen groep" (bonnen van voor
 * de productgroepen) of de overige regels zonder groep (statiegeld, fooi). Korting en bonus
 * staan apart: één regel in het totaal en niet per groep.
 */
export type Bucket = ProductGroup | 'zonder_groep' | 'overige_regels';

export interface Distribution {
	buckets: Map<Bucket, number>;
	/** Korting en bonus samen, negatief (of 0). */
	discountCents: number;
	/** Alle regels samen, met korting: wat er op de bonnen betaald is. */
	totalCents: number;
}

const DISCOUNT_KINDS: ReadonlySet<GroceryLineKind> = new Set(['korting', 'bonus']);

export function bucketOf(line: Pick<GroceryLine, 'kind' | 'group'>): Bucket | 'korting' {
	if (DISCOUNT_KINDS.has(line.kind)) return 'korting';
	if (line.kind !== 'artikel') return 'overige_regels';
	return line.group ?? 'zonder_groep';
}

export function distribute(lines: readonly GroceryLine[]): Distribution {
	const buckets = new Map<Bucket, number>();
	let discountCents = 0;
	let totalCents = 0;
	for (const line of lines) {
		totalCents += line.cents;
		const bucket = bucketOf(line);
		if (bucket === 'korting') discountCents += line.cents;
		else buckets.set(bucket, (buckets.get(bucket) ?? 0) + line.cents);
	}
	return { buckets, discountCents, totalCents };
}

export interface Coverage {
	/** Boodschappen met een bon met regels. */
	coveredCents: number;
	totalCents: number;
	/** Aandeel van 0 tot 1; `null` zonder boodschappen. */
	share: number | null;
}

/** Welk deel van de boodschappen een bon met regels heeft, naar bedrag. */
export function coverage(purchases: readonly GroceryPurchase[]): Coverage {
	let coveredCents = 0;
	let totalCents = 0;
	for (const p of purchases) {
		const spent = Math.max(0, p.spentCents);
		totalCents += spent;
		if (p.lines.length > 0) coveredCents += spent;
	}
	return { coveredCents, totalCents, share: totalCents === 0 ? null : coveredCents / totalCents };
}

/** "68%": afgerond naar beneden, zodat 99,6% niet als alles leest. */
export function coveragePercent(share: number): number {
	return Math.floor(share * 100 + 1e-9);
}

export interface BucketRow {
	bucket: Bucket;
	cents: number;
	/** Gemiddelde van de vorige maanden met regels; `null` als er geen zijn. */
	averageCents: number | null;
	diffCents: number | null;
}

export interface Comparable {
	cents: number;
	averageCents: number | null;
	diffCents: number | null;
}

export interface GroceryMonth {
	month: string;
	coverage: Coverage;
	/** Groepen van groot naar klein; overig, nog geen groep en overige regels achteraan. */
	rows: BucketRow[];
	discount: Comparable;
	total: Comparable;
	/** Hoeveel van de vorige drie maanden regels hadden om mee te vergelijken. */
	comparedMonths: number;
	/** De tien duurste artikelen van de maand. */
	topLines: GroceryLine[];
}

const LAST: Bucket[] = ['overig', 'zonder_groep', 'overige_regels'];
const ORDER: Bucket[] = [...PRODUCT_GROUPS.filter((g) => !LAST.includes(g)), ...LAST];

function compare(cents: number, values: number[] | null): Comparable {
	if (values === null) return { cents, averageCents: null, diffCents: null };
	const averageCents = Math.round(values.reduce((s, v) => s + v, 0) / values.length);
	return { cents, averageCents, diffCents: cents - averageCents };
}

/** De duurste artikelen; bij een gelijk bedrag de nieuwste eerst. */
export function topLines(lines: readonly GroceryLine[], limit = 10): GroceryLine[] {
	return lines
		.filter((l) => l.kind === 'artikel' && l.cents > 0)
		.toSorted(
			(a, b) =>
				b.cents - a.cents ||
				b.date.localeCompare(a.date) ||
				a.description.localeCompare(b.description, 'nl')
		)
		.slice(0, limit);
}

/**
 * Het overzicht van één maand. Het gemiddelde komt uit de vorige drie maanden, maar alleen uit
 * maanden met minstens één bon met regels: een maand zonder bonnen is geen maand zonder
 * boodschappen.
 */
export function groceryMonth(purchases: readonly GroceryPurchase[], month: string): GroceryMonth {
	const inMonth = (m: string) => purchases.filter((p) => p.month === m);
	const current = inMonth(month);
	const lines = current.flatMap((p) => p.lines);
	const now = distribute(lines);
	const previous = [1, 2, 3]
		.map((n) => inMonth(shiftMonth(month, -n)))
		.filter((ps) => ps.some((p) => p.lines.length > 0))
		.map((ps) => distribute(ps.flatMap((p) => p.lines)));
	const has = previous.length > 0;

	const rows: BucketRow[] = [];
	for (const bucket of ORDER) {
		const cents = now.buckets.get(bucket) ?? 0;
		const values = has ? previous.map((d) => d.buckets.get(bucket) ?? 0) : null;
		const row = { bucket, ...compare(cents, values) };
		if (row.cents !== 0 || (row.averageCents ?? 0) !== 0) rows.push(row);
	}
	const last = (b: Bucket) => LAST.indexOf(b);
	rows.sort((a, b) => last(a.bucket) - last(b.bucket) || b.cents - a.cents);

	return {
		month,
		coverage: coverage(current),
		rows,
		discount: compare(now.discountCents, has ? previous.map((d) => d.discountCents) : null),
		total: compare(now.totalCents, has ? previous.map((d) => d.totalCents) : null),
		comparedMonths: previous.length,
		topLines: topLines(lines)
	};
}
