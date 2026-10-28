// Garantie (spec: Garantie): pure regels, zonder database. De datums (einde van het eerste jaar
// na aflevering, de fabrieksgarantie, de geschatte levensduur), de voorstelregel, de momenten
// van de herinneringen en de zinnen op de pagina's en in de melding. Geen juridisch advies, en
// nooit "verlopen": de wettelijke garantie heeft in Nederland geen vaste termijn.

import { addDays } from './dates.ts';
import { daysBetween } from './owed.ts';

/** Een uitgave vanaf dit bedrag (jouw deel) in een categorie met garantie wordt een voorstel. */
export const WARRANTY_MIN_CENTS = 5000;

/** Zoveel dagen voor het einde van het eerste jaar of de fabrieksgarantie komt de herinnering. */
export const REMIND_DAYS = 30;

/** Binnen zoveel dagen loopt er "binnenkort" iets af: die producten staan bovenaan. */
export const SOON_DAYS = 60;

/** Verwachte levensduur per soort, als schatting (spec: Garantie → Gegevens). */
export const LIFETIME_KINDS = [
	{ key: 'telefoon', label: 'Telefoon of laptop', years: 5 },
	{ key: 'groot', label: 'Groot huishoudelijk', years: 8 },
	{ key: 'klein', label: 'Klein elektrisch', years: 3 }
] as const;

export const DEFAULT_LIFETIME_YEARS = 5;
export const MAX_LIFETIME_YEARS = 30;

/**
 * Dezelfde dag, `years` jaar later. Bestaat die dag niet (29 februari in een gewoon jaar), dan de
 * laatste dag van die maand.
 */
export function addYears(iso: string, years: number): string {
	const y = Number(iso.slice(0, 4)) + years;
	const m = Number(iso.slice(5, 7));
	const d = Number(iso.slice(8, 10));
	const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
	return `${String(y).padStart(4, '0')}-${iso.slice(5, 7)}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export interface WarrantyDates {
	purchaseDate: string;
	deliveryDate: string;
	factoryUntil: string | null;
	lifetimeYears: number;
}

/**
 * De dag waarop het eerste jaar na aflevering voorbij is. Tot dan wordt aangenomen dat een gebrek
 * er al was (BW 7:18 lid 2).
 */
export function firstYearEnd(deliveryDate: string): string {
	return addYears(deliveryDate, 1);
}

/** Einde van de geschatte levensduur, vanaf de aflevering. Altijd een schatting. */
export function lifetimeEnd(w: Pick<WarrantyDates, 'deliveryDate' | 'lifetimeYears'>): string {
	return addYears(w.deliveryDate, w.lifetimeYears);
}

// --- Herinneringen ---------------------------------------------------------------------------

export type Moment = 'jaar' | 'fabriek';

export interface Reminder {
	moment: Moment;
	/** De dag waarop het afloopt */
	endDate: string;
	/** Op deze dag (om 9:00) komt de melding */
	remindOn: string;
}

/** De twee momenten die vastliggen: het eerste jaar, en de fabrieksgarantie als je die invulde. */
export function reminders(w: Pick<WarrantyDates, 'deliveryDate' | 'factoryUntil'>): Reminder[] {
	const out: Reminder[] = [];
	const year = firstYearEnd(w.deliveryDate);
	out.push({ moment: 'jaar', endDate: year, remindOn: addDays(year, -REMIND_DAYS) });
	if (w.factoryUntil)
		out.push({
			moment: 'fabriek',
			endDate: w.factoryUntil,
			remindOn: addDays(w.factoryUntil, -REMIND_DAYS)
		});
	return out;
}

/**
 * Herinneringen die vandaag aan de beurt zijn: vanaf de dag van de herinnering tot het einde. Een
 * gemiste ochtend (server uit, of een afleverdatum die je terugzette) komt zo de volgende ochtend
 * alsnog; na het einde komt er niets meer.
 */
export function dueReminders(
	w: Pick<WarrantyDates, 'deliveryDate' | 'factoryUntil'>,
	today: string
): (Reminder & { daysLeft: number })[] {
	return reminders(w)
		.filter((r) => r.remindOn <= today && today < r.endDate)
		.map((r) => ({ ...r, daysLeft: daysBetween(today, r.endDate) }));
}

/** Ontdubbel-sleutel: één melding per product, moment en einddatum. */
export function reminderKey(id: string, r: Pick<Reminder, 'moment' | 'endDate'>): string {
	return `garantie:${r.moment}:${id}:${r.endDate}`;
}

const days = (n: number) => (n === 1 ? '1 dag' : `${n} dagen`);

/**
 * De tekst van de melding. `text` staat altijd op het vergrendelscherm; `detail` met product en
 * winkel alleen als je namen en bedragen daar aanzette.
 */
export function reminderText(
	r: Pick<Reminder, 'moment'> & { daysLeft: number },
	product: string,
	store: string
): { text: string; detail: string } {
	const text = `Een garantie loopt over ${days(r.daysLeft)} af`;
	const detail =
		r.moment === 'jaar'
			? `Nog ${days(r.daysLeft)} waarin ${store} moet bewijzen dat je ${product} in orde was. Werkt alles nog?`
			: `Nog ${days(r.daysLeft)} fabrieksgarantie op je ${product}. Werkt alles nog?`;
	return { text, detail };
}

// --- Voorstelregel ---------------------------------------------------------------------------

export interface ProposalFacts {
	/** Negatief: een uitgave */
	amountCents: number;
	status: 'bevestigd' | 'verwacht' | 'te_controleren';
	date: string;
	/** Jouw deel in categorieën met garantie, positief (zoals bij Budget, zonder voorgeschoten) */
	shareCents: number;
	/** Wat er al terugkwam via retouren en storno's, positief */
	refundedCents: number;
	/** Er is al een garantie of een afgewezen voorstel bij deze transactie */
	decided: boolean;
}

/** Of de uitgave in één keer helemaal terugkwam (retour of storno). */
export function fullyRefunded(f: Pick<ProposalFacts, 'amountCents' | 'refundedCents'>): boolean {
	return f.amountCents < 0 && f.refundedCents >= -f.amountCents;
}

/**
 * Een voorstel "garantie bijhouden?" (spec: Garantie → Hoe een aankoop erin komt): een bevestigde
 * uitgave met jouw deel vanaf de drempel in een categorie met garantie, die niet helemaal
 * terugkwam en waarover je nog niet besliste. Alleen zolang het eerste jaar na aankoop loopt;
 * een oudere aankoop uit de import houd je zelf bij via de transactie.
 */
export function isProposal(
	f: ProposalFacts,
	today: string,
	minCents = WARRANTY_MIN_CENTS
): boolean {
	return (
		f.status === 'bevestigd' &&
		f.amountCents < 0 &&
		f.shareCents >= minCents &&
		!fullyRefunded(f) &&
		!f.decided &&
		f.date <= today &&
		firstYearEnd(f.date) > today
	);
}

// --- Weergave --------------------------------------------------------------------------------

/** Hele kalendermaanden van `from` tot `to`. */
function monthsBetween(from: string, to: string): number {
	const months =
		(Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
		Number(to.slice(5, 7)) -
		Number(from.slice(5, 7));
	return to.slice(8) < from.slice(8) ? months - 1 : months;
}

/** "12 dagen", "3 weken", "7 maanden": hoe lang het van `from` tot `to` nog duurt. */
export function formatLeft(from: string, to: string): string {
	const n = daysBetween(from, to);
	if (n < 14) return days(Math.max(0, n));
	if (n < 60) return `${Math.floor(n / 7)} weken`;
	const months = monthsBetween(from, to);
	return months === 1 ? '1 maand' : `${months} maanden`;
}

/** Wat er binnenkort afloopt, als het binnen `SOON_DAYS` dagen is. */
export function nextEnd(
	w: Pick<WarrantyDates, 'deliveryDate' | 'factoryUntil'>,
	today: string
): (Pick<Reminder, 'moment' | 'endDate'> & { daysLeft: number }) | null {
	const next = reminders(w)
		.filter((r) => r.endDate > today)
		.sort((a, b) => a.endDate.localeCompare(b.endDate))[0];
	if (!next) return null;
	const daysLeft = daysBetween(today, next.endDate);
	return daysLeft <= SOON_DAYS ? { moment: next.moment, endDate: next.endDate, daysLeft } : null;
}

/**
 * De zin onder het product (spec: Schermen, Garantieproduct). In het eerste jaar wat de winkel nog
 * moet bewijzen; daarna hoe lang de wettelijke garantie ongeveer kan gelden, altijd als schatting.
 */
export function warrantySentence(
	w: WarrantyDates & { status: 'actief' | 'afgewezen' | 'afgedankt' },
	store: string,
	today: string
): string {
	if (w.status === 'afgedankt') return 'Afgedankt; je krijgt er geen meldingen meer over.';
	const year = firstYearEnd(w.deliveryDate);
	if (today < w.deliveryDate)
		return `Na de aflevering moet ${store} een jaar lang bewijzen dat hij in orde was.`;
	if (today < year)
		return `${store} moet nog ${formatLeft(today, year)} bewijzen dat hij in orde was.`;
	const end = lifetimeEnd(w);
	return today < end
		? `Wettelijke garantie kan nog gelden tot ongeveer ${end.slice(0, 4)} (schatting).`
		: `De geschatte levensduur liep tot ongeveer ${end.slice(0, 4)}.`;
}

export interface StripMark {
	key: 'jaar' | 'fabriek' | 'vandaag';
	label: string;
	date: string;
	/** Positie op de strook, van 0 (aankoop) tot 1 (einde levensduur) */
	at: number;
}

/**
 * De strook van aankoop tot het einde van de geschatte levensduur, met streepjes voor het einde
 * van het eerste jaar en de fabrieksgarantie, en een streep voor vandaag (spec: Schermen).
 */
export function strip(w: WarrantyDates, today: string): { end: string; marks: StripMark[] } {
	const start = w.purchaseDate < w.deliveryDate ? w.purchaseDate : w.deliveryDate;
	const end = lifetimeEnd(w);
	const span = Math.max(1, daysBetween(start, end));
	const at = (date: string) => Math.min(1, Math.max(0, daysBetween(start, date) / span));
	const marks: StripMark[] = [
		{ key: 'jaar', label: 'Einde eerste jaar', date: firstYearEnd(w.deliveryDate), at: 0 }
	];
	if (w.factoryUntil)
		marks.push({ key: 'fabriek', label: 'Einde fabrieksgarantie', date: w.factoryUntil, at: 0 });
	marks.push({ key: 'vandaag', label: 'Vandaag', date: today, at: 0 });
	return { end, marks: marks.map((m) => ({ ...m, at: at(m.date) })) };
}
