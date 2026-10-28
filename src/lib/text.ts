/** Kleine letters, zonder accenten, met enkele spaties. Voor vergelijken, niet voor weergave. */
export function normalize(text: string): string {
	return text
		.normalize('NFKD')
		.replace(/[\u0300-\u036F]/g, '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Tegenpartij zonder filiaalnummers, plaatsnamen in hoofdletters en betaalterminal-ruis,
 * zodat "AH 1234 UTRECHT" en "Albert Heijn 5678" bij elkaar kunnen komen.
 */
export function normalizeCounterparty(text: string): string {
	return normalize(text)
		.replace(/[^a-z0-9 &'-]/g, ' ')
		.replace(/\b\d+\b/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** IBAN zonder spaties, in hoofdletters. */
export function normalizeIban(iban: string): string {
	return iban.replace(/\s+/g, '').toUpperCase();
}

const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;

/** Controleert vorm en mod-97-controlegetal (ISO 13616). */
export function isValidIban(raw: string): boolean {
	const iban = normalizeIban(raw);
	if (!IBAN.test(iban)) return false;
	const rearranged = iban.slice(4) + iban.slice(0, 4);
	let remainder = 0;
	for (const ch of rearranged) {
		const code = ch.charCodeAt(0);
		const digits = code >= 65 ? String(code - 55) : ch;
		for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
	}
	return remainder === 1;
}

// Plaatsnamen die banken achter een winkelnaam zetten ("JUMBO UTRECHT LEIDSCHE RIJN"). Alleen
// grotere plaatsen: een onbekende plaats blijft gewoon staan, dat is beter dan een naam afkappen.
const PLACES = [
	'amsterdam',
	'rotterdam',
	'den haag',
	"'s-gravenhage",
	'utrecht',
	'eindhoven',
	'groningen',
	'tilburg',
	'almere',
	'breda',
	'nijmegen',
	'arnhem',
	'haarlem',
	'enschede',
	'amersfoort',
	'apeldoorn',
	'zwolle',
	'leiden',
	'maastricht',
	'dordrecht',
	'zoetermeer',
	'delft',
	'den bosch',
	"'s-hertogenbosch",
	'hilversum',
	'leeuwarden',
	'deventer',
	'alkmaar',
	'zeist',
	'houten',
	'nieuwegein',
	'schiphol'
];

// Kleine woorden binnen een naam: "CAFE DE BASTAARD" wordt "Cafe de Bastaard"
const PARTICLES = new Set(['de', 'het', 'van', 'der', 'den', 'en', 'op', 'in', 'aan', 'bij', 'of']);
// Afkortingen met een klinker; zonder klinker (NS, KPN) blijven ze vanzelf in hoofdletters
const ACRONYMS = new Set([
	'ah',
	'ov',
	'tv',
	'eu',
	'iz',
	'ing',
	'sns',
	'asn',
	'abn',
	'uwv',
	'duo',
	'anwb'
]);
// Rechtsvorm aan het eind: zegt niets over wie het is
const LEGAL = /\s+(?:b\.?\s?v\.?|n\.?\s?v\.?|v\.?o\.?f\.?|gmbh|ltd\.?|inc\.?)$/i;
// Betaalterminals zetten hun naam ervoor: "CCV*BAKKER BART", "SumUp *Cafe", "ZETTLE_*KOFFIE"
const TERMINAL = /^(?:ccv|sumup|zettle|izettle|sq|pay\.nl|mollie)\s*[_*]+\s*/i;

function titleWord(word: string, first: boolean): string {
	const lower = word.toLowerCase();
	if (!first && PARTICLES.has(lower)) return lower;
	// Afkortingen zoals NS, AH, KPN en ING blijven in hoofdletters
	const letters = lower.replace(/[^\p{L}]/gu, '');
	if (
		ACRONYMS.has(letters) ||
		(letters.length > 0 && letters.length <= 3 && !/[aeiouy]/.test(letters))
	)
		return word.toUpperCase();
	return lower.replace(
		/(^|[-&/(])(\p{L})/gu,
		(_, sep: string, ch: string) => sep + ch.toUpperCase()
	);
}

/**
 * Tegenpartij zoals een mens hem schrijft, alleen voor de weergave: "ALBERT HEIJN 1403 UTRECHT"
 * wordt "Albert Heijn". Wat al hoofd- en kleine letters heeft, blijft zoals het is, op een
 * betaalterminal of rechtsvorm na. De opgeslagen tegenpartij verandert nooit.
 */
export function displayName(raw: string): string {
	const trimmed = raw.replace(/\s+/g, ' ').trim();
	const text = trimmed.replace(TERMINAL, '') || trimmed;
	if (!/\p{Lu}/u.test(text) || /\p{Ll}/u.test(text)) return text.replace(LEGAL, '').trim() || text;

	// Vanaf het eerste woord met een cijfer (filiaal- of terminalnummer) of een bekende plaats
	// is het geen naam meer, zolang er een naam overblijft
	const words = text.split(' ');
	let end = words.length;
	for (let i = 1; i < words.length; i++) {
		const rest = words.slice(i).join(' ').toLowerCase();
		if (/\d/.test(words[i]!) || PLACES.some((p) => rest === p || rest.startsWith(`${p} `))) {
			if (words.slice(0, i).some((w) => /\p{L}/u.test(w))) end = i;
			break;
		}
	}
	const name = words.slice(0, end).join(' ').replace(LEGAL, '').trim() || text;
	return name
		.split(' ')
		.map((w, i) => titleWord(w, i === 0))
		.join(' ');
}

/** Hooguit twee initialen voor een monogram: "Albert Heijn" wordt "AH", "sanne" wordt "S". */
export function initials(name: string): string {
	const words = displayName(name)
		.split(/[\s.-]+/)
		.filter((w) => /\p{L}|\d/u.test(w) && !PARTICLES.has(w.toLowerCase()));
	const first = (w: string) => (/[\p{L}\d]/u.exec(w)?.[0] ?? '').toUpperCase();
	if (words.length === 0) return '?';
	if (words.length === 1) return first(words[0]!);
	return first(words[0]!) + first(words.at(-1)!);
}

/** Hoe lang een naam hoogstens is als hij naar een model gaat of in een AI-tekst staat. */
export const MODEL_NAME_MAX = 40;

// Iets dat op een URL of e-mailadres lijkt: een woord met `://`, `www.`, `@` of een `/`.
const URLISH = /(?:^|\s)\S*(?::\/\/|www\.|@|\/)\S*/giu;
// Een kale domeinnaam (`Thuisbezorgd.nl`, `bol.com`): alleen het eerste deel blijft, zonder punt
const DOMAIN = /([\p{L}\d-]+)(?:\.[\p{L}\d-]+)*\.[\p{L}]{2,}\b/gu;

/**
 * Een naam van een tegenpartij (of categorie) zoals hij naar een model mag (spec: Vragen en
 * samenvattingen met AI): wie je geld stuurt kiest zelf de naam op het afschrift. Een URL of
 * e-mailadres gaat er helemaal uit, van een kale domeinnaam blijft het eerste deel zonder punt
 * ("Thuisbezorgd.nl" wordt "Thuisbezorgd"), daarna blijven alleen letters, cijfers, spaties en
 * `&.'-` over, ingekort tot 40 tekens. Dit haalt tekens weg, geen woorden: het houdt het kanaal
 * klein, maar is geen bescherming tegen een instructie in gewone taal.
 */
export function modelName(raw: string): string {
	return raw
		.normalize('NFC')
		.replace(URLISH, ' ')
		.replace(DOMAIN, '$1')
		.replace(/[^\p{L}\p{N} &.'-]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MODEL_NAME_MAX)
		.trim();
}
