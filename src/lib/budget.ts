// Budget- en tempoberekening: pure functies, zonder database.

/** `gepland`: alles in de categorie is gepland, dus er is geen tempo (spec: Tempo met vaste lasten) */
export type Pace = 'rustig' | 'op_schema' | 'snel' | 'over' | 'gepland';

export interface PaceInput {
	/** Alles wat als uitgave telt, inclusief reserveringen en bevestigde vaste lasten */
	spentCents: number;
	limitCents: number;
	/** Dag van de maand (1-31) */
	day: number;
	daysInMonth: number;
	/** Gepland: reserveringen en de verwachte of bevestigde vaste lasten van de maand */
	plannedCents?: number;
	/** Het deel van gepland dat al als uitgave telt: reserveringen en bevestigde vaste lasten */
	plannedSpentCents?: number;
}

export interface PaceResult {
	/** Uitgegeven als deel van de limiet; kan boven 1 komen */
	spentRatio: number;
	/** Deel van de maand dat voorbij is, inclusief vandaag */
	monthRatio: number;
	pace: Pace;
	/** Overige uitgaven: alles behalve de geplande posten. Hier meet het tempo. */
	otherCents: number;
	/** Limiet min gepland: het vrije deel. Negatief als de limiet lager is dan gepland. */
	freeLimitCents: number;
}

/** Marge waarbinnen je "op schema" zit: 10% boven het deel van de maand dat voorbij is. */
const MARGIN = 1.1;

function paceFor(ratio: number, monthRatio: number): Pace {
	if (ratio > 1) return 'over';
	if (ratio > monthRatio * MARGIN) return 'snel';
	if (ratio < monthRatio * 0.75) return 'rustig';
	return 'op_schema';
}

/**
 * Tempo: uitgegeven als deel van de limiet tegenover het deel van de maand dat voorbij is.
 * Geplande posten tellen niet mee in het tempo: dat meet alleen de overige uitgaven tegenover
 * het vrije deel (limiet − gepland). Met alleen geplande posten is er geen tempo, en kleurt
 * de balk alleen als de categorie (met de nog verwachte posten erbij) over de limiet gaat.
 */
export function pace(input: PaceInput): PaceResult {
	const { spentCents, limitCents, day, daysInMonth } = input;
	const planned = input.plannedCents ?? 0;
	const plannedSpent = input.plannedSpentCents ?? 0;
	const monthRatio = Math.min(1, Math.max(0, day / daysInMonth));
	const otherCents = spentCents - plannedSpent;
	const freeLimitCents = limitCents - planned;
	const base = { monthRatio, otherCents, freeLimitCents };
	if (limitCents <= 0) {
		return {
			...base,
			spentRatio: spentCents > 0 ? Infinity : 0,
			pace: spentCents > 0 ? 'over' : 'rustig'
		};
	}
	const spentRatio = spentCents / limitCents;
	if (planned === 0 && plannedSpent === 0) {
		return { ...base, spentRatio, pace: paceFor(spentRatio, monthRatio) };
	}
	// Met de verwachte posten erbij: komt de categorie aan het eind van de maand over de limiet?
	const projected = spentCents + Math.max(0, planned - plannedSpent);
	if (projected > limitCents) return { ...base, spentRatio, pace: 'over' };
	if (freeLimitCents <= 0) return { ...base, spentRatio, pace: 'gepland' };
	return { ...base, spentRatio, pace: paceFor(otherCents / freeLimitCents, monthRatio) };
}

/** Voorstel als de limiet lager is dan wat gepland is: gepland, naar boven op hele euro's. */
export function suggestedLimit(plannedCents: number): number {
	return Math.ceil(plannedCents / 100) * 100;
}

export interface CategoryBudget {
	categoryId: string;
	limitCents: number;
	/** Uitgegeven: positief getal. Terugbetalingen in dezelfde categorie verlagen het. */
	spentCents: number;
}

/**
 * Nog vrij deze maand: som van de limieten min de uitgaven en reserveringen in
 * budgetcategorieën. Reserveringen zitten al in `spentCents`.
 */
export function freeThisMonth(budgets: CategoryBudget[], spentOutsideLimits = 0): number {
	let free = 0;
	for (const b of budgets) free += b.limitCents - b.spentCents;
	return free - spentOutsideLimits;
}
