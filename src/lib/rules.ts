import { normalize, normalizeCounterparty, normalizeIban } from './text.ts';

export type RuleField = 'tegenpartij' | 'iban' | 'omschrijving';

export interface Rule {
	id: string;
	field: RuleField;
	pattern: string;
	categoryId: string;
	priority: number;
}

export interface Matchable {
	counterparty: string;
	counterIban: string | null;
	description: string;
}

/** Laagste prioriteit wint; bij gelijke prioriteit het langste (meest specifieke) patroon. */
export function sortRules<T extends Rule>(rules: T[]): T[] {
	return [...rules].sort(
		(a, b) =>
			a.priority - b.priority || b.pattern.length - a.pattern.length || a.id.localeCompare(b.id)
	);
}

interface Normalized {
	counterparty: string;
	iban: string | null;
	description: string;
}

function normalizeTx(tx: Matchable): Normalized {
	return {
		counterparty: normalizeCounterparty(tx.counterparty),
		iban: tx.counterIban === null ? null : normalizeIban(tx.counterIban),
		description: normalize(tx.description)
	};
}

// Genormaliseerd patroon per regel-object: bij opnieuw toepassen komt elke regel duizenden keren langs
const patterns = new WeakMap<Rule, string>();

function normalizedPattern(rule: Rule): string {
	let p = patterns.get(rule);
	if (p === undefined) {
		p =
			rule.field === 'iban'
				? normalizeIban(rule.pattern)
				: rule.field === 'tegenpartij'
					? normalizeCounterparty(rule.pattern)
					: normalize(rule.pattern);
		patterns.set(rule, p);
	}
	return p;
}

function matches(rule: Rule, tx: Normalized): boolean {
	const p = normalizedPattern(rule);
	if (p.length === 0) return false;
	switch (rule.field) {
		case 'iban':
			return tx.iban === p;
		case 'tegenpartij':
			return tx.counterparty.includes(p);
		case 'omschrijving':
			return tx.description.includes(p);
	}
}

export function ruleMatches(rule: Rule, tx: Matchable): boolean {
	return matches(rule, normalizeTx(tx));
}

/** Eerste passende regel, of `null`. Verwacht regels die al met `sortRules` gesorteerd zijn. */
export function matchRule<T extends Rule>(sorted: T[], tx: Matchable): T | null {
	// De transactie één keer normaliseren: bij opnieuw toepassen gaat dit over de hele historie
	const normalized = normalizeTx(tx);
	for (const rule of sorted) if (matches(rule, normalized)) return rule;
	return null;
}
