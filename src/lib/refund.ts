// Terugbetalingen in de transactielijst: waar een gekoppelde betaling voor was, en de draad die
// hem met de uitgave verbindt. Pure functies, zodat ze zonder database te testen zijn.

import { formatShortMonth } from './dates.ts';

export interface RefundTarget {
	/** De uitgave of afschrijving van de post, als die er is */
	transactionId: string | null;
	/** Tegenpartij van de uitgave, of de omschrijving van de post */
	label: string;
	/** Maand van een maandaandeel (`YYYY-MM`) */
	month: string | null;
}

export interface RefundInfo {
	direction: 'te_krijgen' | 'te_betalen';
	people: string[];
	/** Posten die deze betaling dekt, elk één keer */
	targets: RefundTarget[];
	/** Wat als tegoed staat, zonder post */
	creditCents: number;
}

const list = (parts: string[]) =>
	parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} en ${parts.at(-1)}`;

/** `Ziggo sep, okt`; meer dan drie maanden als aantal. */
function targetText(targets: RefundTarget[]): string {
	const byLabel = new Map<string, string[]>();
	for (const t of targets) {
		const months = byLabel.get(t.label) ?? [];
		if (t.month && !months.includes(t.month)) months.push(t.month);
		byLabel.set(t.label, months);
	}
	if (byLabel.size > 2) return `${byLabel.size} posten`;
	return list(
		[...byLabel].map(([label, months]) => {
			if (months.length === 0) return label;
			if (months.length > 3) return `${label}, ${months.length} maanden`;
			return `${label} ${months.sort().map(formatShortMonth).join(', ')}`;
		})
	);
}

/**
 * De regel onder de tegenpartij van een gekoppelde betaling, in plaats van de categorie:
 * `Terug voor Domino's`, `Sanne · voor Ziggo sep` of `Tegoed van Sanne`. De naam staat
 * er alleen bij als hij niet al in de tegenpartij staat.
 */
export function describeRefund(info: RefundInfo, counterparty: string): string {
	const cp = counterparty.toLowerCase();
	const names = info.people.filter((p) => !cp.includes(p.toLowerCase()));
	const incoming = info.direction === 'te_krijgen';
	if (info.targets.length === 0) {
		const who = list(info.people);
		return incoming ? `Tegoed van ${who}` : `Tegoed bij ${who}`;
	}
	const what = targetText(info.targets);
	if (names.length === 0) return `${incoming ? 'Terug' : 'Terugbetaald'} voor ${what}`;
	return `${list(names)} · voor ${what}`;
}

export interface ThreadRow {
	id: string;
	refund?: RefundInfo | null;
}

export interface ThreadGroup {
	/** De uitgave waar de draad begint */
	source: string;
	/** Betalingen die erop binnenkwamen */
	payments: string[];
}

/**
 * Groepen voor de draad: per uitgave de betalingen ernaar die op dezelfde lijst staan. Een
 * betaling voor twee uitgaven zit in twee groepen; een uitgave buiten de lijst krijgt er geen.
 */
export function threadGroups(rows: readonly ThreadRow[]): ThreadGroup[] {
	const onList = new Set(rows.map((r) => r.id));
	const groups = new Map<string, string[]>();
	for (const r of rows) {
		for (const t of r.refund?.targets ?? []) {
			if (!t.transactionId || t.transactionId === r.id || !onList.has(t.transactionId)) continue;
			const payments = groups.get(t.transactionId) ?? [];
			if (!payments.includes(r.id)) payments.push(r.id);
			groups.set(t.transactionId, payments);
		}
	}
	return [...groups].map(([source, payments]) => ({ source, payments }));
}

export interface Span {
	top: number;
	bottom: number;
}

/**
 * Baan per draad, zodat draden die elkaar overlappen naast elkaar lopen. Kortste draden het
 * dichtst bij de rijen. Past een draad niet in `max` banen, dan krijgt hij `null`: geen draad,
 * het label in de rij zegt dan nog steeds waar de betaling voor was.
 */
export function assignLanes(spans: readonly Span[], max: number): (number | null)[] {
	const order = spans
		.map((s, i) => ({ ...s, i }))
		.sort((a, b) => a.bottom - a.top - (b.bottom - b.top) || a.top - b.top);
	const taken: Span[][] = Array.from({ length: max }, () => []);
	const out: (number | null)[] = spans.map(() => null);
	for (const s of order) {
		const lane = taken.findIndex((spansInLane) =>
			spansInLane.every((t) => s.bottom < t.top || s.top > t.bottom)
		);
		if (lane === -1) continue;
		taken[lane]!.push(s);
		out[s.i] = lane;
	}
	return out;
}

export interface ThreadLayout {
	groups: (ThreadGroup & { lane: number })[];
	/** Aantal banen in gebruik; 0 als er niets te verbinden is */
	lanes: number;
}

/**
 * Draden voor een lijst in volgorde van weergave. De banen hangen alleen van de volgorde af, niet
 * van pixels, zodat de server de ruimte ervoor al reserveert en er niets verspringt.
 */
export function threadLayout(rows: readonly ThreadRow[], max = 3): ThreadLayout {
	const index = new Map(rows.map((r, i) => [r.id, i]));
	const groups = threadGroups(rows);
	const lanes = assignLanes(
		groups.map((g) => {
			const at = [g.source, ...g.payments].map((id) => index.get(id)!);
			return { top: Math.min(...at), bottom: Math.max(...at) };
		}),
		max
	);
	const placed = groups.flatMap((g, i) => {
		const lane = lanes[i];
		return lane === null || lane === undefined ? [] : [{ ...g, lane }];
	});
	return { groups: placed, lanes: placed.reduce((n, g) => Math.max(n, g.lane + 1), 0) };
}
