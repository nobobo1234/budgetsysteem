// Startlimieten uit historie (spec: Analyses → Startlimieten uit historie): pure functies,
// zonder database. Geen AI: elk voorstel is na te rekenen uit de maanden die erbij staan.

import { formatMonth, shiftMonth } from './dates.ts';

/** Zoveel volle maanden kijkt het voorstel terug. */
export const HISTORY_MONTHS = 6;
/** Met minder volle maanden is er geen voorstel, maar "nog te weinig historie". */
export const MIN_HISTORY_MONTHS = 3;

/**
 * De laatste volle maanden met historie, oudste eerst. De lopende maand telt niet mee, en een
 * maand alleen als de historie op of vóór de eerste van die maand begint: een maand waarin de
 * historie halverwege begint, zou het voorstel omlaag trekken.
 */
export function historyMonths(
	currentMonth: string,
	historyStart: string | null,
	count = HISTORY_MONTHS
): string[] {
	if (!historyStart) return [];
	const out: string[] = [];
	for (let i = count; i >= 1; i--) {
		const month = shiftMonth(currentMonth, -i);
		if (`${month}-01` >= historyStart) out.push(month);
	}
	return out;
}

/** Middelste waarde; bij een even aantal het gemiddelde van de middelste twee (kan op een halve cent uitkomen). */
export function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const s = [...values].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Afgerond op hele euro's, naar het dichtstbijzijnde bedrag. */
export const roundEuro = (cents: number) => Math.round(cents / 100) * 100;

export type Proposal =
	| {
			kind: 'voorstel';
			/** Gepland deze maand plus de mediaan, op hele euro's */
			proposalCents: number;
			plannedCents: number;
			medianCents: number;
			/** Laagste en hoogste maand, met wat er deze maand gepland is erbij */
			lowestCents: number;
			highestCents: number;
	  }
	| { kind: 'geen_uitgaven' };

/**
 * Voorstel voor één categorie. `monthly` zijn de uitgaven per volle maand die niet bij een vaste
 * last horen (een maand zonder uitgaven als 0); `plannedCents` wat er deze maand gepland is.
 */
export function proposeLimit(monthly: readonly number[], plannedCents: number): Proposal {
	const values = monthly.map((c) => Math.max(0, c));
	const med = median(values);
	const planned = Math.max(0, plannedCents);
	const proposalCents = roundEuro(planned + med);
	if (proposalCents <= 0) return { kind: 'geen_uitgaven' };
	return {
		kind: 'voorstel',
		proposalCents,
		plannedCents: planned,
		medianCents: Math.round(med),
		lowestCents: planned + Math.min(...values),
		highestCents: planned + Math.max(...values)
	};
}

export interface PlanInput {
	/** Mediaan van het inkomen over dezelfde maanden */
	incomeCents: number;
	/** Spaardoel per maand; 0 zonder doel */
	savingsCents: number;
	/** Limieten die er al zijn: die doen niet mee, maar tellen wel mee in het totaal */
	existingLimitsCents: number;
	/** De aangevinkte voorstellen, zoals ze nu in de velden staan */
	chosenCents: readonly number[];
}

export interface Plan {
	/** Bestaande limieten plus de aangevinkte voorstellen */
	totalCents: number;
	/** Wat er per maand overblijft: inkomen min het totaal; negatief is een tekort */
	leftCents: number;
	/** Inkomen min spaardoel */
	distributableCents: number;
	/** Hoeveel het totaal boven te verdelen uitkomt; 0 als het past */
	shortfallCents: number;
}

export function plan(input: PlanInput): Plan {
	const totalCents =
		input.existingLimitsCents + input.chosenCents.reduce((s, c) => s + Math.max(0, c), 0);
	const distributableCents = input.incomeCents - Math.max(0, input.savingsCents);
	return {
		totalCents,
		leftCents: input.incomeCents - totalCents,
		distributableCents,
		shortfallCents: Math.max(0, totalCents - distributableCents)
	};
}

/**
 * Bij een tekort: de categorieën met het grootste verschil tussen voorstel en laagste maand
 * eerst, want daar gaf je eerder al minder uit. De volgorde is verder stabiel.
 */
export function byRoom<T extends { valueCents: number; lowestCents: number }>(
	rows: readonly T[]
): T[] {
	return rows
		.map((row, i) => ({ row, i, room: row.valueCents - row.lowestCents }))
		.sort((a, b) => b.room - a.room || a.i - b.i)
		.map((x) => x.row);
}

const monthOnly = (month: string) => formatMonth(month).replace(/\s+\d{4}$/, '');

/** "Mediaan van april tot en met september"; over een jaarwisseling met jaartallen. */
export function periodSentence(months: readonly string[]): string {
	if (months.length === 0) return '';
	const first = months[0]!;
	const last = months.at(-1)!;
	const sameYear = first.slice(0, 4) === last.slice(0, 4);
	const from = sameYear ? monthOnly(first) : formatMonth(first);
	return `Mediaan van ${from} tot en met ${sameYear ? monthOnly(last) : formatMonth(last)}`;
}
