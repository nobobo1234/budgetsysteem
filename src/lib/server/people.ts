import { and, asc, eq } from 'drizzle-orm';
import { isValidIban, normalize, normalizeIban } from '../text.ts';
import { recordChange } from './audit.ts';
import type { Conn, DB } from './db/index.ts';
import { accounts, owed, owedPayments, people, peopleIbans } from './db/schema.ts';
import { ValidationError } from './errors.ts';

// Personen voor Te krijgen (en straks gedeelde vaste lasten). IBANs van anderen zijn
// persoonsgegevens: nooit loggen, ook niet in een foutmelding.

export const MAX_NAME = 40;

/** Naam zoals je hem typte, met een hoofdletter: `sanne` wordt `Sanne`. */
export function displayName(raw: string): string {
	const name = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
	return name.charAt(0).toLocaleUpperCase('nl-NL') + name.slice(1);
}

export function listPeople(db: Conn) {
	return db
		.select({ id: people.id, name: people.name, active: people.active })
		.from(people)
		.orderBy(asc(people.name))
		.all();
}

export function findPersonByName(db: Conn, name: string): { id: string; name: string } | null {
	const key = normalize(name);
	if (!key) return null;
	return listPeople(db).find((p) => normalize(p.name) === key) ?? null;
}

/** Zoekt een persoon op naam (hoofdletters en accenten maken niet uit) of maakt hem aan. */
export function findOrCreatePerson(db: Conn, raw: string): string {
	const name = displayName(raw);
	if (!name) throw new ValidationError('Naam ontbreekt');
	const existing = findPersonByName(db, name);
	if (existing) return existing.id;
	const row = db.insert(people).values({ name }).returning().get();
	recordChange(db, 'aangemaakt', 'people', row.id, null, row);
	return row.id;
}

export function createPerson(db: DB, raw: string): string {
	const name = displayName(raw);
	if (!name) throw new ValidationError('Naam ontbreekt');
	if (findPersonByName(db, name)) throw new ValidationError(`${name} bestaat al`);
	return db.transaction((tx) => findOrCreatePerson(tx, name));
}

export function updatePerson(db: DB, id: string, patch: { name?: string; active?: boolean }) {
	return db.transaction((tx) => {
		const before = tx.select().from(people).where(eq(people.id, id)).get();
		if (!before) throw new ValidationError('Onbekende persoon');
		const name = patch.name === undefined ? before.name : displayName(patch.name);
		if (!name) throw new ValidationError('Naam ontbreekt');
		const clash = findPersonByName(tx, name);
		if (clash && clash.id !== id) throw new ValidationError(`${name} bestaat al`);
		const after = tx
			.update(people)
			.set({ name, active: patch.active ?? before.active })
			.where(eq(people.id, id))
			.returning()
			.get();
		recordChange(tx, 'gewijzigd', 'people', id, before, after);
		return after;
	});
}

/** Alleen een persoon zonder posten en betalingen; anders zet je hem op niet actief. */
export function deletePerson(db: DB, id: string): void {
	db.transaction((tx) => {
		const before = tx.select().from(people).where(eq(people.id, id)).get();
		if (!before) throw new ValidationError('Onbekende persoon');
		const used =
			tx.select({ id: owed.id }).from(owed).where(eq(owed.personId, id)).get() ??
			tx
				.select({ id: owedPayments.id })
				.from(owedPayments)
				.where(eq(owedPayments.personId, id))
				.get();
		if (used) throw new ValidationError('Er staan posten op deze persoon; zet hem op niet actief');
		tx.delete(people).where(eq(people.id, id)).run();
		recordChange(tx, 'verwijderd', 'people', id, before, null);
	});
}

export function ibansOf(db: Conn, personId: string): string[] {
	return db
		.select({ iban: peopleIbans.iban })
		.from(peopleIbans)
		.where(eq(peopleIbans.personId, personId))
		.orderBy(asc(peopleIbans.createdAt))
		.all()
		.map((r) => r.iban);
}

/**
 * Een IBAN hoort bij hooguit één persoon en is nooit een eigen rekening. Geeft het IBAN als het
 * nieuw is bij deze persoon, `null` als hij het al had. Binnen een transactie; `addIban` in
 * shares.ts koppelt daarna de betalingen die al binnen zijn.
 */
export function insertIban(db: Conn, personId: string, raw: string): string | null {
	const iban = normalizeIban(raw);
	if (!isValidIban(iban)) throw new ValidationError('Dat IBAN klopt niet');
	if (!db.select({ id: people.id }).from(people).where(eq(people.id, personId)).get())
		throw new ValidationError('Onbekende persoon');
	if (db.select({ id: accounts.id }).from(accounts).where(eq(accounts.iban, iban)).get())
		throw new ValidationError('Dat is een eigen rekening');
	const other = db
		.select({ personId: peopleIbans.personId })
		.from(peopleIbans)
		.where(eq(peopleIbans.iban, iban))
		.get();
	if (other?.personId === personId) return null;
	if (other) throw new ValidationError('Dat IBAN hoort al bij iemand anders');
	const row = db.insert(peopleIbans).values({ personId, iban }).returning().get();
	// Alleen het ID in het audit-log; het IBAN zelf blijft in people_ibans
	recordChange(db, 'iban_toegevoegd', 'people', personId, null, { ibanId: row.id });
	return iban;
}

export function removeIban(db: DB, personId: string, raw: string): void {
	const iban = normalizeIban(raw);
	db.transaction((tx) => {
		const row = tx
			.select()
			.from(peopleIbans)
			.where(and(eq(peopleIbans.personId, personId), eq(peopleIbans.iban, iban)))
			.get();
		if (!row) throw new ValidationError('Onbekend IBAN');
		tx.delete(peopleIbans).where(eq(peopleIbans.id, row.id)).run();
		recordChange(tx, 'iban_verwijderd', 'people', personId, { ibanId: row.id }, null);
	});
}

/** De persoon bij een tegen-IBAN, als die bij precies één persoon hoort. */
export function personByIban(db: Conn, raw: string | null): string | null {
	if (!raw) return null;
	return (
		db
			.select({ personId: peopleIbans.personId })
			.from(peopleIbans)
			.where(eq(peopleIbans.iban, normalizeIban(raw)))
			.get()?.personId ?? null
	);
}

/** Alle personen met hun IBANs, voor de koppellijst (op de server; IBANs gaan niet naar de browser). */
export function peopleWithIbans(db: Conn): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const r of db.select().from(peopleIbans).all()) {
		const list = out.get(r.personId) ?? [];
		list.push(r.iban);
		out.set(r.personId, list);
	}
	return out;
}
