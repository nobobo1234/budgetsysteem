// Bedragen altijd als hele centen (integer). Nooit parseFloat: alleen strikte grammatica's.

/** Grootste bedrag dat de app accepteert: één miljoen euro. */
export const MAX_CENTS = 100_000_000;

const PLAIN = /^(\d{1,9})(?:[.,](\d{1,2}))?$/;
const THOUSANDS_DOT = /^(\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?$/;

function toCents(whole: string, fraction: string | undefined): number | null {
	const euros = Number(whole);
	const cents = fraction === undefined ? 0 : Number(fraction.padEnd(2, '0'));
	const total = euros * 100 + cents;
	return Number.isSafeInteger(total) && total <= MAX_CENTS ? total : null;
}

/**
 * Leest een positief bedrag zoals een mens het typt: `12`, `12,5`, `12,50`, `12.50` of
 * `1.234,56`. Geeft `null` bij alles wat niet exact past; dubbelzinnige invoer zoals `12,345`
 * wordt geweigerd in plaats van geraden.
 */
export function parseAmount(input: string): number | null {
	if (input.length === 0 || input.length > 16) return null;
	let m = PLAIN.exec(input);
	if (m) return toCents(m[1]!, m[2]);
	m = THOUSANDS_DOT.exec(input);
	if (m) return toCents(m[1]!.replaceAll('.', ''), m[2]);
	return null;
}

/** Als `parseAmount`, maar ook onder nul (`-12,50` of `−12,50`), zoals een saldo dat rood staat. */
export function parseSignedAmount(input: string): number | null {
	const text = input.trim();
	const negative = text.startsWith('-') || text.startsWith('−');
	const cents = parseAmount(negative ? text.slice(1).trimStart() : text);
	if (cents === null) return null;
	return negative && cents !== 0 ? -cents : cents;
}

const DECIMAL = /^(-?)(\d{1,12})(?:\.(\d{1,2}))?$/;

/** Leest een machinebedrag met punt als decimaalteken, zoals in CAMT en de SNS-CSV (`-43.90`). */
export function parseDecimal(input: string): number | null {
	const m = DECIMAL.exec(input.trim());
	if (!m) return null;
	const cents = toCents(m[2]!, m[3]);
	if (cents === null) return null;
	return m[1] === '-' ? -cents : cents;
}

const euro = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const euroWhole = new Intl.NumberFormat('nl-NL', {
	style: 'currency',
	currency: 'EUR',
	maximumFractionDigits: 0
});

/** Formatteert centen als euro, met deling door 100 alleen bij weergave. */
export function formatCents(cents: number, opts: { whole?: boolean; sign?: boolean } = {}): string {
	const value = cents / 100;
	const text = (opts.whole ? euroWhole : euro).format(Math.abs(value));
	if (cents < 0) return `−${text}`;
	if (opts.sign && cents > 0) return `+${text}`;
	return text;
}

/** Bedrag voor een invoerveld: `12,50`. */
export function centsToInput(cents: number): string {
	const abs = Math.abs(cents);
	return `${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}
