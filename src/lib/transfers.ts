// Interne overboekingen samen als één rij: het geld dat van SNS afging en op Revolut binnenkwam
// is één beweging, geen uitgave plus inkomen. Een paar wordt bij het lezen gevormd, niets wordt
// opgeslagen; een boeking zonder tegenhanger blijft een gewone rij.

export interface TransferLeg {
	id: string;
	amountCents: number;
	date: string;
	accountId: string;
}

/** Zoveel dagen mogen de twee boekingen uit elkaar liggen (een weekend bij de bank) */
export const TRANSFER_DAYS = 3;

const dayNumber = (iso: string) => {
	const [y, m, d] = iso.split('-').map(Number);
	return Date.UTC(y!, m! - 1, d!) / 86_400_000;
};

/**
 * Paren van een afschrijving en een bijschrijving met hetzelfde bedrag op een andere eigen
 * rekening, hooguit `TRANSFER_DAYS` dagen uit elkaar. De dichtstbijzijnde datum gaat voor, dan
 * de oudste; elke boeking zit in hooguit één paar. Geeft per afschrijving de bijschrijving.
 */
export function pairTransfers(legs: readonly TransferLeg[]): Map<string, string> {
	const incoming = Map.groupBy(
		legs.filter((l) => l.amountCents > 0),
		(l) => l.amountCents
	);
	const edges: { out: TransferLeg; in: TransferLeg; gap: number }[] = [];
	for (const out of legs) {
		if (out.amountCents >= 0) continue;
		for (const inc of incoming.get(-out.amountCents) ?? []) {
			if (inc.accountId === out.accountId) continue;
			const gap = Math.abs(dayNumber(inc.date) - dayNumber(out.date));
			if (gap <= TRANSFER_DAYS) edges.push({ out, in: inc, gap });
		}
	}
	edges.sort(
		(a, b) =>
			a.gap - b.gap ||
			a.out.date.localeCompare(b.out.date) ||
			a.out.id.localeCompare(b.out.id) ||
			a.in.id.localeCompare(b.in.id)
	);
	const pairs = new Map<string, string>();
	const used = new Set<string>();
	for (const e of edges) {
		if (pairs.has(e.out.id) || used.has(e.in.id)) continue;
		pairs.set(e.out.id, e.in.id);
		used.add(e.in.id);
	}
	return pairs;
}
