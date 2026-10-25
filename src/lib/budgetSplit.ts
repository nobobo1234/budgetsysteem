// Vast, dagelijks en vrij voor de gestapelde balk op Budget. Apart van budget.ts, zodat het
// startscherm (dat budget.ts laadt) deze code niet meekrijgt.
import { FIXED_GROUP, type BudgetLine } from './budget.ts';

export interface BudgetSplit {
	/** Vaste lasten en reserveringen van deze maand, bevestigd of nog te komen */
	fixedCents: number;
	/** Wat daarvan nog moet komen */
	fixedLeftCents: number;
	/** Alle andere uitgaven, ook zonder categorie of limiet */
	dailyCents: number;
	/** Wat er echt nog vrij is: nog vrij min de vaste lasten die nog komen */
	freeCents: number;
}

/**
 * De maand in drie delen voor de gestapelde balk op Budget: vast, dagelijks en vrij. Vast is
 * alles in de groep Vaste lasten (ook een afschrijving uit de import die nog niet aan een vaste
 * last gekoppeld is) plus wat elders gepland is, zoals een reservering. Samen zijn de delen de
 * som van de limieten, tenzij je erboven zit; dan is vrij nul.
 */
export function budgetSplit(
	lines: readonly Pick<BudgetLine, 'group' | 'spentCents' | 'plannedCents' | 'plannedSpentCents'>[],
	freeCents: number,
	uncategorizedCents = 0
): BudgetSplit {
	let fixedCents = 0;
	let fixedLeftCents = 0;
	let dailyCents = Math.max(0, uncategorizedCents);
	for (const l of lines) {
		const left = Math.max(0, l.plannedCents - l.plannedSpentCents);
		const other = Math.max(0, l.spentCents - l.plannedSpentCents);
		fixedLeftCents += left;
		if (l.group === FIXED_GROUP) fixedCents += Math.max(0, l.spentCents) + left;
		else {
			fixedCents += Math.max(l.plannedCents, l.plannedSpentCents);
			dailyCents += other;
		}
	}
	return {
		fixedCents,
		fixedLeftCents,
		dailyCents,
		freeCents: Math.max(0, freeCents - fixedLeftCents)
	};
}
