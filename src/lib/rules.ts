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

export function ruleMatches(rule: Rule, tx: Matchable): boolean {
	if (rule.pattern.length === 0) return false;
	switch (rule.field) {
		case 'iban':
			return (
				tx.counterIban !== null && normalizeIban(tx.counterIban) === normalizeIban(rule.pattern)
			);
		case 'tegenpartij': {
			const p = normalizeCounterparty(rule.pattern);
			return p.length > 0 && normalizeCounterparty(tx.counterparty).includes(p);
		}
		case 'omschrijving': {
			const p = normalize(rule.pattern);
			return p.length > 0 && normalize(tx.description).includes(p);
		}
	}
}

/** Eerste passende regel, of `null`. Verwacht regels die al met `sortRules` gesorteerd zijn. */
export function matchRule<T extends Rule>(sorted: T[], tx: Matchable): T | null {
	for (const rule of sorted) if (ruleMatches(rule, tx)) return rule;
	return null;
}
