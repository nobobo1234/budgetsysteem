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
