// Saldocheck (spec: Dagelijks gebruik). Pure rekenregels, zonder database: wat de app verwacht dat
// er op een rekening staat, en waar je moet zoeken als dat niet klopt met de bank.
import { addDays } from './dates.ts';

/** Saldo van een rekening aan het eind van `date`, na alle boekingen van die dag. */
export interface BalanceAnchor {
	accountId: string;
	date: string;
	amountCents: number;
}

/** Een boeking zoals de saldoberekening hem ziet; `amountCents` is altijd het eurobedrag. */
export interface BalanceEntry {
	accountId: string;
	date: string;
	amountCents: number;
	status: 'bevestigd' | 'verwacht' | 'te_controleren';
}

/** Het echte saldo volgens de bank, aan het eind van `date`. */
export interface BalanceCheck {
	date: string;
	amountCents: number;
}

/**
 * Telt een boeking mee in het saldo? Een verwachte post (nog niet bevestigd) niet: dat geld is
 * nog niet weg. Een post die je nog moet controleren wel, want die is wel geboekt. Reserveringen
 * zijn geen boekingen en komen hier dus nooit langs.
 */
export function countsForBalance(entry: Pick<BalanceEntry, 'status'>): boolean {
	return entry.status !== 'verwacht';
}

/**
 * Verwacht saldo aan het eind van `date`: het anker plus alle boekingen van die rekening na de
 * ankerdatum tot en met `date`. Ligt `date` vóór het anker, dan rekent hij terug. Een terugboeking
 * telt op de datum dat het geld binnenkwam; vreemde valuta via het eurobedrag.
 */
export function expectedBalance(
	anchor: BalanceAnchor,
	entries: Iterable<BalanceEntry>,
	date: string
): number {
	let total = anchor.amountCents;
	for (const e of entries) {
		if (e.accountId !== anchor.accountId || !countsForBalance(e)) continue;
		if (e.date > anchor.date && e.date <= date) total += e.amountCents;
		else if (e.date > date && e.date <= anchor.date) total -= e.amountCents;
	}
	return total;
}

export interface CheckResult extends BalanceCheck {
	expectedCents: number;
	/** Echt min verwacht: negatief betekent dat er bij de bank minder staat (een vergeten uitgave) */
	differenceCents: number;
	/** Waar het verschil ontstond: sinds de laatste check die klopte (of het anker), tot deze check */
	period: { from: string; to: string };
}

/** Tussen welke datums een verschil ontstond, zodat je gericht kunt zoeken. Datums inclusief. */
export function differencePeriod(since: string, date: string): { from: string; to: string } {
	if (date > since) return { from: addDays(since, 1), to: date };
	if (date < since) return { from: addDays(date, 1), to: since };
	return { from: date, to: date };
}

/** Elke check met het verwachte saldo en het verschil, de nieuwste eerst. */
export function checkResults(
	anchor: BalanceAnchor,
	entries: readonly BalanceEntry[],
	checks: readonly BalanceCheck[]
): CheckResult[] {
	let since = anchor.date;
	const out: CheckResult[] = [];
	for (const check of checks.toSorted((a, b) => a.date.localeCompare(b.date))) {
		const expectedCents = expectedBalance(anchor, entries, check.date);
		const differenceCents = check.amountCents - expectedCents;
		out.push({
			...check,
			expectedCents,
			differenceCents,
			period: differencePeriod(since, check.date)
		});
		if (differenceCents === 0) since = check.date;
	}
	return out.reverse();
}

/** Is er deze maand (`YYYY-MM`) al een check gedaan? */
export function checkedInMonth(checks: readonly Pick<BalanceCheck, 'date'>[], month: string) {
	return checks.some((c) => c.date.startsWith(`${month}-`));
}
