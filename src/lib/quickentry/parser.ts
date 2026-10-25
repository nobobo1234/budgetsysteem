import { addDays, fromIsoDate, isValidDate, toIsoDate } from '../dates.ts';
import { parseAmount } from '../money.ts';

// Snelinvoer zonder AI en zonder netwerk. Een eenvoudige tokenizer op witruimte, zonder
// reguliere expressies met geneste herhalingen (ReDoS), en nooit meer dan 200 tekens.

export const MAX_INPUT = 200;

export type SpanKind = 'bedrag' | 'datum' | 'categorie' | 'rekening' | 'delen' | 'persoon';

export interface Span {
	start: number;
	end: number;
	kind: SpanKind;
	text: string;
}

export interface ParsedEntry {
	/** Positief bedrag in centen, of null als er (nog) geen bedrag is */
	amountCents: number | null;
	direction: 'uit' | 'in';
	currency: 'EUR' | 'USD';
	date: string;
	dateExplicit: boolean;
	/** Ruwe hint na `#`, zonder het hekje */
	category: string | null;
	/** Rekeningalias, met of zonder `@` getypt */
	account: string | null;
	/** "voor 3": het totaal aantal personen, jij inbegrepen */
	splitCount: number | null;
	/** "met sanne en tom": de anderen */
	splitWith: string[];
	/** Een bekende persoon los in de tekst (`+15 tikkie sanne`), zoals hij in de app heet */
	person: string | null;
	/** Overige tekst: tegenpartij of omschrijving */
	text: string;
	spans: Span[];
}

export interface ParseOptions {
	/** Bekende rekeningaliassen, zodat `rev` zonder `@` ook werkt */
	accountAliases?: readonly string[];
	/** Startposities van tokens die de gebruiker weer gewone tekst heeft gemaakt */
	plain?: ReadonlySet<number>;
	/** Namen van bekende personen, voor `+15 tikkie sanne` */
	people?: readonly string[];
}

/**
 * Opzoektabel van personen: op de hele naam en op de voornaam, in kleine letters. Een voornaam
 * die bij meer personen hoort, herkent de parser niet; dan is niet te zeggen wie je bedoelt.
 */
// Per lijst één keer opbouwen: de snelinvoer parset bij elke toetsaanslag met dezelfde lijst
const indexCache = new WeakMap<readonly string[], Map<string, string>>();

function peopleIndex(people: readonly string[]): Map<string, string> {
	const cached = indexCache.get(people);
	if (cached) return cached;
	const out = new Map<string, string>();
	const ambiguous = new Set<string>();
	for (const name of people) {
		const full = name.trim().toLowerCase();
		if (full.length === 0) continue;
		out.set(full, name);
		const first = full.split(' ')[0]!;
		if (first === full) continue;
		if (out.has(first) && out.get(first) !== name) ambiguous.add(first);
		else out.set(first, name);
	}
	for (const name of people) ambiguous.delete(name.trim().toLowerCase());
	for (const key of ambiguous) out.delete(key);
	indexCache.set(people, out);
	return out;
}

interface Token {
	text: string;
	start: number;
	end: number;
}

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let start = -1;
	for (let i = 0; i <= input.length; i++) {
		const ch = input[i];
		const space = ch === undefined || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
		if (space) {
			if (start !== -1) {
				tokens.push({ text: input.slice(start, i), start, end: i });
				start = -1;
			}
		} else if (start === -1) {
			start = i;
		}
	}
	return tokens;
}

function amountToken(
	raw: string
): { cents: number; incoming: boolean; currency: 'EUR' | 'USD' } | null {
	let s = raw;
	let incoming = false;
	let currency: 'EUR' | 'USD' = 'EUR';
	if (s.startsWith('+')) {
		incoming = true;
		s = s.slice(1);
	} else if (s.startsWith('-')) {
		s = s.slice(1);
	}
	if (s.startsWith('€')) s = s.slice(1);
	else if (s.startsWith('$')) {
		currency = 'USD';
		s = s.slice(1);
	} else if (s.endsWith('€')) s = s.slice(0, -1);
	const cents = parseAmount(s);
	if (cents === null || cents === 0) return null;
	return { cents, incoming, currency };
}

// Map in plaats van een object: `__proto__` of `constructor` mogen nooit iets opleveren
const WEEKDAYS = new Map<string, number>(
	Object.entries({
		zo: 0,
		zondag: 0,
		ma: 1,
		maandag: 1,
		di: 2,
		dinsdag: 2,
		wo: 3,
		woensdag: 3,
		do: 4,
		donderdag: 4,
		vr: 5,
		vrijdag: 5,
		za: 6,
		zaterdag: 6
	})
);

function isDigits(s: string): boolean {
	if (s.length === 0) return false;
	for (const ch of s) if (ch < '0' || ch > '9') return false;
	return true;
}

/** `12/10`, `12-10`, `12/10/2026` of `12-10-26`; zonder jaar het meest recente jaar. */
function slashDate(raw: string, today: string): string | null {
	const sep = raw.includes('/') ? '/' : raw.includes('-') ? '-' : null;
	if (!sep) return null;
	const parts = raw.split(sep);
	if (parts.length < 2 || parts.length > 3) return null;
	if (!parts.every((p) => isDigits(p) && p.length <= 4)) return null;
	const day = Number(parts[0]);
	const month = Number(parts[1]);
	const todayYear = Number(today.slice(0, 4));
	let year: number;
	if (parts.length === 3) {
		const y = parts[2]!;
		if (y.length === 2) year = 2000 + Number(y);
		else if (y.length === 4) year = Number(y);
		else return null;
	} else {
		year = todayYear;
	}
	if (!isValidDate(year, month, day)) return null;
	let iso = toIsoDate(new Date(year, month - 1, day));
	// Zonder jaartal en ruim in de toekomst: dan bedoel je vorig jaar
	if (parts.length === 2 && iso > addDays(today, 7)) {
		if (!isValidDate(year - 1, month, day)) return null;
		iso = toIsoDate(new Date(year - 1, month - 1, day));
	}
	return iso;
}

function wordDate(lower: string, today: string): string | null {
	if (lower === 'vandaag') return today;
	if (lower === 'gisteren') return addDays(today, -1);
	if (lower === 'eergisteren') return addDays(today, -2);
	const wd = WEEKDAYS.get(lower);
	if (wd === undefined) return null;
	const current = fromIsoDate(today).getDay();
	return addDays(today, -((current - wd + 7) % 7));
}

function isName(s: string): boolean {
	if (s.length === 0 || s.length > 40) return false;
	for (const ch of s) {
		const lower = ch.toLowerCase();
		const letter = lower !== ch.toUpperCase() || (lower >= 'a' && lower <= 'z');
		if (!letter && ch !== '-' && ch !== "'") return false;
	}
	return true;
}

export function parseQuickEntry(
	input: string,
	today: string,
	opts: ParseOptions = {}
): ParsedEntry {
	const source = input.length > MAX_INPUT ? input.slice(0, MAX_INPUT) : input;
	const tokens = tokenize(source);
	const aliases = new Set((opts.accountAliases ?? []).map((a) => a.toLowerCase()));
	const plain = opts.plain;
	const people = opts.people && opts.people.length > 0 ? peopleIndex(opts.people) : null;

	const result: ParsedEntry = {
		amountCents: null,
		direction: 'uit',
		currency: 'EUR',
		date: today,
		dateExplicit: false,
		category: null,
		account: null,
		splitCount: null,
		splitWith: [],
		person: null,
		text: '',
		spans: []
	};
	const text: string[] = [];
	const span = (from: Token, to: Token, kind: SpanKind) =>
		result.spans.push({
			start: from.start,
			end: to.end,
			kind,
			text: source.slice(from.start, to.end)
		});

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i]!;
		if (plain?.has(tok.start)) {
			text.push(tok.text);
			continue;
		}
		const lower = tok.text.toLowerCase();

		if (result.amountCents === null) {
			const amount = amountToken(tok.text);
			if (amount) {
				result.amountCents = amount.cents;
				result.direction = amount.incoming ? 'in' : 'uit';
				result.currency = amount.currency;
				span(tok, tok, 'bedrag');
				continue;
			}
		}

		if (lower.length > 1 && lower.startsWith('#') && result.category === null) {
			result.category = tok.text.slice(1).replaceAll('-', ' ');
			span(tok, tok, 'categorie');
			continue;
		}

		if (lower.length > 1 && lower.startsWith('@') && result.account === null) {
			result.account = lower.slice(1);
			span(tok, tok, 'rekening');
			continue;
		}

		if (!result.dateExplicit) {
			const date = wordDate(lower, today) ?? slashDate(lower, today);
			if (date) {
				result.date = date;
				result.dateExplicit = true;
				span(tok, tok, 'datum');
				continue;
			}
		}

		if (lower === 'voor' && result.splitCount === null) {
			const next = tokens[i + 1];
			if (next && !plain?.has(next.start) && isDigits(next.text) && next.text.length <= 2) {
				const n = Number(next.text);
				if (n >= 2 && n <= 50) {
					result.splitCount = n;
					span(tok, next, 'delen');
					i++;
					continue;
				}
			}
		}

		if (lower === 'met' && result.splitWith.length === 0) {
			const names: string[] = [];
			let j = i + 1;
			let last = tok;
			while (j < tokens.length && names.length < 20) {
				const t = tokens[j]!;
				if (plain?.has(t.start)) break;
				const word = t.text.endsWith(',') ? t.text.slice(0, -1) : t.text;
				const wl = word.toLowerCase();
				if (wl === 'en' && names.length > 0) {
					j++;
					continue;
				}
				if (!isName(word) || aliases.has(wl) || wordDate(wl, today) || wl === 'voor') break;
				names.push(word);
				last = t;
				j++;
				if (!t.text.endsWith(',') && tokens[j]?.text.toLowerCase() !== 'en') break;
			}
			if (names.length > 0) {
				result.splitWith = names;
				span(tok, last, 'delen');
				i = tokens.indexOf(last);
				continue;
			}
		}

		if (people && result.person === null) {
			const word = lower.endsWith(',') ? lower.slice(0, -1) : lower;
			const name = people.get(word);
			if (name !== undefined) {
				result.person = name;
				span(tok, tok, 'persoon');
				continue;
			}
		}

		if (result.account === null && aliases.has(lower)) {
			result.account = lower;
			span(tok, tok, 'rekening');
			continue;
		}

		text.push(tok.text);
	}

	result.text = text.join(' ');
	return result;
}

/** Hoeveel personen delen er mee, jij inbegrepen. */
export function splitPeople(entry: Pick<ParsedEntry, 'splitCount' | 'splitWith'>): number {
	const named = entry.splitWith.length > 0 ? entry.splitWith.length + 1 : 1;
	// `voor 2 met sanne en tim`: de namen tellen, niet het te lage aantal
	return Math.max(entry.splitCount ?? 1, named);
}
