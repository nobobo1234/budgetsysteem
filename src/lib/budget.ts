// Budget- en tempoberekening: pure functies, zonder database.

import { formatCents } from './money.ts';

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

function paceFor(ratio: number, monthRatio: number): Exclude<Pace, 'gepland'> {
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

/** Wat een balk of het verhaal op het startscherm van een categorie nodig heeft. */
export interface BudgetLine {
	categoryId: string;
	name: string;
	group: string;
	limitCents: number;
	spentCents: number;
	plannedCents: number;
	plannedSpentCents: number;
	pace: Pace;
	spentRatio: number;
}

export interface MonthStory {
	/** Dagen die nog over zijn, vandaag meegeteld */
	daysLeft: number;
	/** Vaste lasten en reserveringen die deze maand nog komen */
	plannedLeftCents: number;
	/** Nog vrij min wat nog komt; negatief betekent een tekort */
	spendableCents: number;
	/** Wat je per dag nog kunt uitgeven, naar beneden op hele centen */
	perDayCents: number;
	/** Tempo van de overige uitgaven over alle limieten samen; null zonder vrij deel */
	pace: Exclude<Pace, 'gepland'> | null;
	/** Voor de maandlijn, als deel van de som van de limieten (0–1) */
	spentShare: number;
	plannedShare: number;
	monthRatio: number;
}

const share = (cents: number, total: number) =>
	total > 0 ? Math.max(0, Math.min(1, cents / total)) : 0;

/**
 * Het verhaal onder "nog vrij" (spec: Startscherm): hoeveel dagen er nog zijn, wat je per dag
 * kunt uitgeven als de vaste lasten die nog komen eraf zijn, en of je op schema ligt.
 */
export function monthStory(
	lines: readonly Pick<
		BudgetLine,
		'limitCents' | 'spentCents' | 'plannedCents' | 'plannedSpentCents'
	>[],
	freeCents: number,
	day: number,
	daysInMonth: number
): MonthStory {
	const withLimit = lines.filter((l) => l.limitCents > 0);
	const totalLimit = withLimit.reduce((s, l) => s + l.limitCents, 0);
	const plannedLeftCents = withLimit.reduce(
		(s, l) => s + Math.max(0, l.plannedCents - l.plannedSpentCents),
		0
	);
	const spent = totalLimit - freeCents;
	const daysLeft = Math.max(1, daysInMonth - day + 1);
	const spendableCents = freeCents - plannedLeftCents;
	const monthRatio = Math.min(1, Math.max(0, day / daysInMonth));
	const other = withLimit.reduce((s, l) => s + l.spentCents - l.plannedSpentCents, 0);
	const freeLimit = withLimit.reduce((s, l) => s + Math.max(0, l.limitCents - l.plannedCents), 0);
	let storyPace: MonthStory['pace'] = null;
	if (freeCents < 0) storyPace = 'over';
	else if (freeLimit > 0) storyPace = paceFor(other / freeLimit, monthRatio);
	return {
		daysLeft,
		plannedLeftCents,
		spendableCents,
		perDayCents: spendableCents > 0 ? Math.floor(spendableCents / daysLeft) : 0,
		pace: storyPace,
		spentShare: share(spent, totalLimit),
		plannedShare: Math.min(share(plannedLeftCents, totalLimit), 1 - share(spent, totalLimit)),
		monthRatio
	};
}

/** Groep waarvan de categorieën op het startscherm samen één balk zijn. */
export const FIXED_GROUP = 'Vaste lasten';

const URGENCY: Record<Pace, number> = { over: 0, snel: 1, op_schema: 2, rustig: 3, gepland: 4 };

/**
 * Balken op het startscherm: de vaste lasten samen, en de categorieën die het dichtst bij hun
 * limiet zitten (eerst over, dan snel, dan het hoogste deel van de limiet).
 */
export function homeBars<L extends BudgetLine>(
	lines: readonly L[],
	day: number,
	daysInMonth: number,
	count = 4
) {
	const shown = lines.filter((l) => l.limitCents > 0 || l.spentCents > 0);
	const fixedLines = shown.filter((l) => l.group === FIXED_GROUP);
	const sum = (key: 'limitCents' | 'spentCents' | 'plannedCents' | 'plannedSpentCents') =>
		fixedLines.reduce((s, l) => s + l[key], 0);
	const fixedInput = {
		spentCents: sum('spentCents'),
		limitCents: sum('limitCents'),
		plannedCents: sum('plannedCents'),
		plannedSpentCents: sum('plannedSpentCents')
	};
	const fixed =
		fixedLines.length > 0
			? { ...fixedInput, ...pace({ ...fixedInput, day, daysInMonth }), count: fixedLines.length }
			: null;
	const others = shown
		.filter((l) => l.group !== FIXED_GROUP)
		.sort(
			(a, b) =>
				URGENCY[a.pace] - URGENCY[b.pace] ||
				(Number.isFinite(b.spentRatio) ? b.spentRatio : Infinity) -
					(Number.isFinite(a.spentRatio) ? a.spentRatio : Infinity)
		);
	return { fixed, top: others.slice(0, count), more: Math.max(0, others.length - count) };
}

/** De zin onder "nog vrij". Bedragen in hele euro's; geen persoonsgegevens. */
export function storySentence(story: MonthStory, freeCents: number): string {
	const euro = (cents: number) => formatCents(cents, { whole: true });
	if (freeCents < 0) return `Je zit ${euro(-freeCents)} boven je limieten.`;
	if (story.spendableCents <= 0)
		return `Met de vaste lasten die nog komen, is er deze maand niets meer vrij.`;
	if (story.daysLeft === 1) return `Laatste dag van de maand, nog ${euro(story.spendableCents)}.`;
	const pacePart =
		story.pace === 'rustig'
			? ' Je houdt het rustig.'
			: story.pace === 'op_schema'
				? ' Je ligt op schema.'
				: story.pace === 'snel'
					? ' Je gaat iets sneller dan de maand.'
					: '';
	return `Nog ${story.daysLeft} dagen, ongeveer ${euro(story.perDayCents)} per dag.${pacePart}`;
}
