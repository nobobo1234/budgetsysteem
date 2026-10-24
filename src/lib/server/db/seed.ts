import { sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { accounts, categories, rules } from './schema.ts';
import type * as schema from './schema.ts';

// Startcategorieën uit de spec (Datamodel); zelf aan te passen in de app.
export const START_CATEGORIES: { group: string; names: string[]; countsForBudget: boolean }[] = [
	{
		group: 'Vaste lasten',
		names: [
			'Wonen',
			'Energie en water',
			'Internet en telefoon',
			'Verzekeringen',
			'Abonnementen',
			'Belastingen en gemeente'
		],
		countsForBudget: true
	},
	{
		group: 'Dagelijks',
		names: ['Boodschappen', 'Uit eten en bezorgen', 'Drogist en verzorging', 'Huishouden'],
		countsForBudget: true
	},
	{ group: 'Onderweg', names: ['Vervoer'], countsForBudget: true },
	{
		group: 'Vrije tijd',
		names: ['Uitgaan', 'Sport', 'Hobby en entertainment', 'Reizen'],
		countsForBudget: true
	},
	{
		group: 'Overig',
		names: ['Kleding', 'Gezondheid', 'Cadeaus', 'Elektronica', 'Overig'],
		countsForBudget: true
	},
	{
		group: 'Buiten budget',
		names: ['Inkomen', 'Sparen en beleggen', 'Interne overboeking', 'Terugbetaling'],
		countsForBudget: false
	}
];

export const INTERNAL_TRANSFER = 'Interne overboeking';

/** Vult een lege database met startcategorieën, de twee rekeningen en de Revolut-regel. */
export function seed(db: BetterSQLite3Database<typeof schema>): void {
	db.transaction((tx) => {
		const count =
			tx
				.select({ n: sql<number>`count(*)` })
				.from(categories)
				.get()?.n ?? 0;
		if (count > 0) return;

		let order = 0;
		for (const group of START_CATEGORIES) {
			for (const name of group.names) {
				tx.insert(categories)
					.values({
						name,
						group: group.group,
						countsForBudget: group.countsForBudget,
						sortOrder: order++
					})
					.run();
			}
		}

		tx.insert(accounts)
			.values([
				{ name: 'SNS', kind: 'sns', alias: 'sns' },
				{ name: 'Revolut', kind: 'revolut', alias: 'rev' }
			])
			.onConflictDoNothing()
			.run();

		// Opwaarderen vanuit SNS naar Revolut is een interne overboeking, geen uitgave (spec: Import)
		const internal = tx
			.select({ id: categories.id })
			.from(categories)
			.where(sql`${categories.name} = ${INTERNAL_TRANSFER}`)
			.get();
		if (internal) {
			tx.insert(rules)
				.values({ field: 'tegenpartij', pattern: 'revolut', categoryId: internal.id, priority: 10 })
				.onConflictDoNothing()
				.run();
		}
	});
}
