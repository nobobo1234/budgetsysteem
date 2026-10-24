import { matchRule, type Rule } from '../rules.ts';
import { normalize, normalizeCounterparty } from '../text.ts';
import { splitPeople, splitShare, type ParsedEntry } from './parser.ts';

export interface CategoryRef {
	id: string;
	name: string;
}

export interface AccountRef {
	id: string;
	alias: string;
	kind: 'sns' | 'revolut' | 'anders';
}

export interface ResolveContext {
	categories: readonly CategoryRef[];
	accounts: readonly AccountRef[];
	/** Regels, al gesorteerd met `sortRules` */
	rules: readonly Rule[];
	/** Bekende tegenpartijen, de vaakst gebruikte eerst */
	knownCounterparties: readonly string[];
}

export interface Draft {
	amountCents: number | null;
	origAmountCents: number | null;
	origCurrency: 'USD' | null;
	date: string;
	counterparty: string;
	categoryId: string | null;
	accountId: string | null;
	/** Jouw deel in centen als er gedeeld wordt; anders gelijk aan het totaal */
	myShareCents: number | null;
	sharedWith: string[];
	people: number;
	/** Wat nog ingevuld moet worden voordat de post compleet is */
	missing: ('bedrag' | 'eurobedrag' | 'rekening')[];
}

// Een paar winkels die je vaak afkort; je eigen historie gaat voor.
const BUILTIN_NAMES = new Map<string, string>(
	Object.entries({
		ah: 'Albert Heijn',
		appie: 'Albert Heijn',
		jumbo: 'Jumbo',
		lidl: 'Lidl',
		aldi: 'Aldi',
		plus: 'PLUS',
		dirk: 'Dirk',
		hema: 'HEMA',
		ns: 'NS',
		kruidvat: 'Kruidvat',
		etos: 'Etos',
		thuisbezorgd: 'Thuisbezorgd',
		netflix: 'Netflix',
		spotify: 'Spotify'
	})
);

// Trefwoorden naar startcategorieën, als er geen regel of #categorie is.
const KEYWORDS = new Map<string, string>(
	Object.entries({
		'albert heijn': 'Boodschappen',
		jumbo: 'Boodschappen',
		lidl: 'Boodschappen',
		aldi: 'Boodschappen',
		plus: 'Boodschappen',
		dirk: 'Boodschappen',
		boodschappen: 'Boodschappen',
		supermarkt: 'Boodschappen',
		etentje: 'Uit eten en bezorgen',
		eten: 'Uit eten en bezorgen',
		lunch: 'Uit eten en bezorgen',
		diner: 'Uit eten en bezorgen',
		restaurant: 'Uit eten en bezorgen',
		pizza: 'Uit eten en bezorgen',
		thuisbezorgd: 'Uit eten en bezorgen',
		borrel: 'Uitgaan',
		kroeg: 'Uitgaan',
		bier: 'Uitgaan',
		club: 'Uitgaan',
		ns: 'Vervoer',
		trein: 'Vervoer',
		ov: 'Vervoer',
		bus: 'Vervoer',
		tram: 'Vervoer',
		taxi: 'Vervoer',
		uber: 'Vervoer',
		tanken: 'Vervoer',
		benzine: 'Vervoer',
		kruidvat: 'Drogist en verzorging',
		etos: 'Drogist en verzorging',
		kapper: 'Drogist en verzorging',
		hema: 'Huishouden',
		netflix: 'Abonnementen',
		spotify: 'Abonnementen',
		sportschool: 'Sport',
		gym: 'Sport',
		cadeau: 'Cadeaus',
		cadeautje: 'Cadeaus'
	})
);

function initials(name: string): string {
	return normalizeCounterparty(name)
		.split(' ')
		.filter((w) => w.length > 0)
		.map((w) => w[0])
		.join('');
}

/** Koppelt getypte tekst aan een bekende naam: exact, initialen (`ah`) of begin van de naam. */
export function matchCounterparty(text: string, known: readonly string[]): string | null {
	const t = normalizeCounterparty(text);
	if (t.length === 0) return null;
	for (const name of known) if (normalizeCounterparty(name) === t) return name;
	if (t.length >= 2 && !t.includes(' ')) {
		for (const name of known) {
			const ini = initials(name);
			if (ini.length >= 2 && ini.startsWith(t)) return name;
		}
	}
	if (t.length >= 3) {
		for (const name of known) if (normalizeCounterparty(name).startsWith(t)) return name;
	}
	return BUILTIN_NAMES.get(t) ?? null;
}

export function findCategory(hint: string, categories: readonly CategoryRef[]): CategoryRef | null {
	const h = normalize(hint);
	if (h.length === 0) return null;
	return (
		categories.find((c) => normalize(c.name) === h) ??
		categories.find((c) => normalize(c.name).startsWith(h)) ??
		categories.find((c) => normalize(c.name).split(' ').includes(h)) ??
		null
	);
}

/** Startcategorie bij een tegenpartij of tekst, op basis van trefwoorden. */
export function keywordCategory(text: string, direction: 'uit' | 'in'): string | null {
	const t = normalize(text);
	if (direction === 'in' && t.split(' ').includes('tikkie')) return 'Terugbetaling';
	const whole = KEYWORDS.get(t);
	if (whole) return whole;
	for (const word of t.split(' ')) {
		const hit = KEYWORDS.get(word);
		if (hit) return hit;
	}
	return null;
}

export function resolveEntry(entry: ParsedEntry, ctx: ResolveContext): Draft {
	const missing: Draft['missing'] = [];

	const typed = entry.text.trim();
	const known = typed ? matchCounterparty(typed, ctx.knownCounterparties) : null;
	const counterparty = known ?? typed;

	let account: AccountRef | undefined;
	if (entry.account) {
		account =
			ctx.accounts.find((a) => a.alias === entry.account) ??
			ctx.accounts.find((a) => a.alias.startsWith(entry.account!));
	}
	// Dollars betaal je met Revolut; anders de eerste SNS-rekening
	account ??=
		entry.currency === 'USD'
			? ctx.accounts.find((a) => a.kind === 'revolut')
			: ctx.accounts.find((a) => a.kind === 'sns');
	if (!account) missing.push('rekening');

	let categoryId: string | null = null;
	if (entry.category) categoryId = findCategory(entry.category, ctx.categories)?.id ?? null;
	if (!categoryId && counterparty) {
		categoryId =
			matchRule(ctx.rules as Rule[], { counterparty, counterIban: null, description: typed })
				?.categoryId ?? null;
	}
	if (!categoryId) {
		const keyword = keywordCategory(counterparty || typed, entry.direction);
		if (keyword) categoryId = ctx.categories.find((c) => c.name === keyword)?.id ?? null;
	}

	let amountCents: number | null = null;
	let origAmountCents: number | null = null;
	let origCurrency: 'USD' | null = null;
	if (entry.amountCents === null) {
		missing.push('bedrag');
	} else if (entry.currency === 'USD') {
		origAmountCents = entry.direction === 'uit' ? -entry.amountCents : entry.amountCents;
		origCurrency = 'USD';
		missing.push('eurobedrag');
	} else {
		amountCents = entry.direction === 'uit' ? -entry.amountCents : entry.amountCents;
	}

	const people = entry.direction === 'uit' ? splitPeople(entry) : 1;
	let myShareCents: number | null = amountCents;
	if (amountCents !== null && people > 1) {
		myShareCents = -splitShare(-amountCents, people).mine;
	}

	return {
		amountCents,
		origAmountCents,
		origCurrency,
		date: entry.date,
		counterparty,
		categoryId,
		accountId: account?.id ?? null,
		myShareCents,
		sharedWith: entry.direction === 'uit' ? entry.splitWith : [],
		people,
		missing
	};
}
