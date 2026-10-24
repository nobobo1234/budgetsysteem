// Budget- en tempoberekening: pure functies, zonder database.

export type Pace = 'rustig' | 'op_schema' | 'snel' | 'over';

export interface PaceInput {
	spentCents: number;
	limitCents: number;
	/** Dag van de maand (1-31) */
	day: number;
	daysInMonth: number;
}

export interface PaceResult {
	/** Uitgegeven als deel van de limiet; kan boven 1 komen */
	spentRatio: number;
	/** Deel van de maand dat voorbij is, inclusief vandaag */
	monthRatio: number;
	pace: Pace;
}

/** Marge waarbinnen je "op schema" zit: 10% boven het deel van de maand dat voorbij is. */
const MARGIN = 1.1;

export function pace({ spentCents, limitCents, day, daysInMonth }: PaceInput): PaceResult {
	const monthRatio = Math.min(1, Math.max(0, day / daysInMonth));
	if (limitCents <= 0) {
		return {
			spentRatio: spentCents > 0 ? Infinity : 0,
			monthRatio,
			pace: spentCents > 0 ? 'over' : 'rustig'
		};
	}
	const spentRatio = spentCents / limitCents;
	let p: Pace;
	if (spentRatio > 1) p = 'over';
	else if (spentRatio > monthRatio * MARGIN) p = 'snel';
	else if (spentRatio < monthRatio * 0.75) p = 'rustig';
	else p = 'op_schema';
	return { spentRatio, monthRatio, pace: p };
}

export interface CategoryBudget {
	categoryId: string;
	limitCents: number;
	/** Uitgegeven: positief getal. Terugbetalingen in dezelfde categorie verlagen het. */
	spentCents: number;
}

/** Nog vrij deze maand: som van de limieten min de uitgaven in budgetcategorieën. */
export function freeThisMonth(budgets: CategoryBudget[], spentOutsideLimits = 0): number {
	let free = 0;
	for (const b of budgets) free += b.limitCents - b.spentCents;
	return free - spentOutsideLimits;
}
