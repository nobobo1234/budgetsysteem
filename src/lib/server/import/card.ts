// Pinbetalingen van SNS hebben geen tegenpartij in RltdPties: de winkel staat alleen in de
// omschrijving, in deze vorm (waarden verzonnen):
//
//   WINKELNAAM 12      >PLAATS 01.02.2026 8U05 KV011 PTR00001 MCC:5499 Apple Pay betaling NLNEDERLAND
//
// Winkel vóór het eerste `>`, dan de plaats (soms direct gevolgd door de datum), tijd `<uur>U<min>`,
// terminalgegevens, `MCC:<4 cijfers>`, betaalwijze en land. Alles zonder geneste herhalingen in
// regexen, zodat een rare omschrijving nooit veel rekentijd kost.

export interface CardPayment {
	merchant: string;
	place: string;
	/** Merchant Category Code, vier cijfers (als tekst: voorloopnullen tellen mee) */
	mcc: string;
}

/** Omschrijvingen worden bij de import al op 500 tekens afgekapt. */
const MAX_LENGTH = 500;
const MAX_MERCHANT = 64;
const MAX_PLACE = 64;
/** Tussen de tijd en de MCC staan bij SNS twee velden (KV011 en de terminal). */
const MAX_TOKENS_BEFORE_MCC = 4;

const DATE = /(\d{2})\.(\d{2})\.(\d{4})/;
const TIME = /^(\d{1,2})U(\d{2})$/;
const MCC = /^MCC:(\d{4})$/;
const LETTER = /\p{L}/u;

function collapse(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

/** Herkent de omschrijving van een pinbetaling; `null` als het formaat niet precies past. */
export function parseCardPayment(description: string): CardPayment | null {
	if (description.length === 0 || description.length > MAX_LENGTH) return null;

	const gt = description.indexOf('>');
	if (gt <= 0) return null;
	const merchant = collapse(description.slice(0, gt));
	if (merchant.length === 0 || merchant.length > MAX_MERCHANT || !LETTER.test(merchant))
		return null;

	const rest = description.slice(gt + 1);
	const date = DATE.exec(rest);
	if (!date) return null;
	const day = Number(date[1]);
	const month = Number(date[2]);
	if (day < 1 || day > 31 || month < 1 || month > 12) return null;

	const place = collapse(rest.slice(0, date.index));
	if (place.length > MAX_PLACE || place.includes('>')) return null;

	const after = rest.slice(date.index + date[0].length);
	// Na de datum moet een spatie komen; anders is het geen losse datum
	if (!/^\s/.test(after)) return null;
	const tokens = collapse(after).split(' ');

	const time = TIME.exec(tokens[0] ?? '');
	if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) return null;

	for (let i = 1; i <= MAX_TOKENS_BEFORE_MCC + 1 && i < tokens.length; i++) {
		const mcc = MCC.exec(tokens[i]!);
		if (mcc) return { merchant, place, mcc: mcc[1]! };
	}
	return null;
}

/** De tegenpartij uit het bestand, of anders de winkel uit de omschrijving van een pinbetaling. */
export function counterpartyOrMerchant(counterparty: string, description: string): string {
	if (counterparty.trim()) return counterparty;
	return parseCardPayment(description)?.merchant ?? counterparty;
}

// Een kleine vaste tabel naar de startcategorieën (seed.ts). Alleen als voorstel na de import,
// nooit om automatisch te boeken. Een Map, zodat sleutels als `__proto__` niets opleveren.
const MCC_CATEGORIES = new Map<string, string>([
	['5411', 'Boodschappen'], // supermarkten
	['5422', 'Boodschappen'], // slagers
	['5451', 'Boodschappen'], // zuivel
	['5462', 'Boodschappen'], // bakkers
	['5499', 'Boodschappen'], // overige levensmiddelen
	['5812', 'Uit eten en bezorgen'], // restaurants
	['5814', 'Uit eten en bezorgen'], // fastfood
	['5813', 'Uitgaan'], // cafés en bars
	['4111', 'Vervoer'], // openbaar vervoer
	['4112', 'Vervoer'], // trein
	['4121', 'Vervoer'], // taxi
	['4131', 'Vervoer'], // bus
	['5541', 'Vervoer'], // tankstations
	['5542', 'Vervoer'], // tankautomaten
	['7523', 'Vervoer'], // parkeren
	['5912', 'Drogist en verzorging'], // drogisterijen en apotheken
	['4511', 'Reizen'], // luchtvaart
	['7011', 'Reizen'] // hotels
]);

/** Naam van de startcategorie bij een MCC, of `null`. */
export function mccCategory(mcc: string): string | null {
	return MCC_CATEGORIES.get(mcc) ?? null;
}
