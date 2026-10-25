import { rankMatches, type MatchLabel } from '../match.ts';
import { splitEqually } from '../owed.ts';
import { matchRule, type Rule } from '../rules.ts';
import { normalize, normalizeCounterparty } from '../text.ts';
import { splitPeople, type ParsedEntry } from './parser.ts';

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
	/** Bekende personen, voor delen en ontvangen */
	people?: readonly { id: string; name: string }[];
	/** Open posten voor de koppellijst bij ontvangen of terugbetalen */
	openPosts?: readonly OpenPostRef[];
}

export interface OpenPostRef {
	id: string;
	personId: string;
	personName: string;
	direction: 'te_krijgen' | 'te_betalen';
	outstandingCents: number;
	description: string;
	date: string;
}

export interface PostCandidate extends OpenPostRef {
	score: number;
	label: MatchLabel;
}

export interface Draft {
	amountCents: number | null;
	origAmountCents: number | null;
	origCurrency: 'USD' | null;
	date: string;
	counterparty: string;
	categoryId: string | null;
	accountId: string | null;
	description: string;
	/** Jouw deel in centen als er gedeeld wordt; anders gelijk aan het totaal */
	myShareCents: number | null;
	/** De anderen met naam, zoals ze in de app heten als ze bekend zijn */
	sharedWith: string[];
	/** Per ander het bedrag (positief), in dezelfde volgorde; namenloze anderen achteraan */
	otherShares: number[];
	people: number;
	/** Koppellijst bij binnenkomend geld (te krijgen) of een terugbetaling (te betalen) */
	candidates: PostCandidate[];
	preselect: string | null;
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

/** Een getypte naam zoals de persoon in de app heet; onbekend blijft hij zoals getypt. */
export function knownPerson(name: string, people: readonly { name: string }[]): string {
	const key = normalize(name);
	return people.find((p) => normalize(p.name) === key)?.name ?? name;
}

export function resolveEntry(entry: ParsedEntry, ctx: ResolveContext): Draft {
	const missing: Draft['missing'] = [];
	const people = ctx.people ?? [];

	const typed = entry.text.trim();
	// `+15 tikkie sanne`: de persoon is de tegenpartij, de rest de omschrijving
	const known = entry.person
		? null
		: typed
			? matchCounterparty(typed, ctx.knownCounterparties)
			: null;
	const counterparty = entry.person ?? known ?? typed;
	const description = entry.person ? typed : '';

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
		const keyword =
			keywordCategory(counterparty || typed, entry.direction) ??
			(entry.person && typed ? keywordCategory(typed, entry.direction) : null);
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

	const sharing = entry.direction === 'uit' ? splitPeople(entry) : 1;
	const sharedWith =
		entry.direction === 'uit' ? entry.splitWith.map((n) => knownPerson(n, people)) : [];
	let myShareCents: number | null = amountCents;
	let otherShares: number[] = [];
	if (amountCents !== null && sharing > 1) {
		const share = splitEqually(-amountCents, sharing);
		myShareCents = -share.mine;
		otherShares = share.others;
	}

	// Koppellijst: binnenkomend geld tegen posten te krijgen, een uitgave zonder delen tegen
	// posten te betalen. Alleen kandidaten met enige overeenkomst, zodat salaris geen lijst geeft.
	let candidates: PostCandidate[] = [];
	let preselect: string | null = null;
	if (amountCents !== null && sharing === 1 && ctx.openPosts && ctx.openPosts.length > 0) {
		const direction = entry.direction === 'in' ? 'te_krijgen' : 'te_betalen';
		const all = ctx.openPosts.filter((p) => p.direction === direction);
		// Noem je een bekende persoon, dan alleen diens posten (als die er zijn)
		const own = entry.person ? all.filter((p) => p.personName === entry.person) : [];
		const posts = own.length > 0 ? own : all;
		const ranked = rankMatches(
			{ amountCents: Math.abs(amountCents), date: entry.date, name: `${counterparty} ${typed}` },
			posts.map((p) => ({ ...p, amountCents: p.outstandingCents, name: p.personName })),
			{ lower: 'deels' }
		);
		candidates = ranked.candidates
			.filter((c) => c.parts.name > 0.5 || c.parts.amount === 1)
			.map((c) => ({
				id: c.target.id,
				personId: c.target.personId,
				personName: c.target.personName,
				direction: c.target.direction,
				outstandingCents: c.target.outstandingCents,
				description: c.target.description,
				date: c.target.date,
				score: c.score,
				label: c.label
			}));
		preselect = candidates.some((c) => c.id === ranked.preselect) ? ranked.preselect : null;
	}

	return {
		amountCents,
		origAmountCents,
		origCurrency,
		date: entry.date,
		counterparty,
		description,
		categoryId,
		accountId: account?.id ?? null,
		myShareCents,
		sharedWith,
		otherShares,
		people: sharing,
		candidates,
		preselect,
		missing
	};
}
