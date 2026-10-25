import { asc, eq } from 'drizzle-orm';
import { toIsoDate } from '../dates.ts';
import { sortRules } from '../rules.ts';
import type { DB } from './db/index.ts';
import { accounts, categories, people, rules } from './db/schema.ts';
import { refundTargets } from './corrections.ts';
import { matchablePosts } from './owed.ts';
import { knownCounterparties } from './transactions.ts';

/** Alles wat de snelinvoer in de browser nodig heeft om lokaal te parsen en te koppelen. */
export function quickEntryContext(db: DB) {
	return {
		categories: db
			.select({ id: categories.id, name: categories.name, group: categories.group })
			.from(categories)
			.where(eq(categories.archived, false))
			.orderBy(asc(categories.sortOrder), asc(categories.name))
			.all(),
		accounts: db
			.select({ id: accounts.id, alias: accounts.alias, kind: accounts.kind, name: accounts.name })
			.from(accounts)
			.orderBy(asc(accounts.createdAt))
			.all(),
		rules: sortRules(
			db
				.select({
					id: rules.id,
					field: rules.field,
					pattern: rules.pattern,
					categoryId: rules.categoryId,
					priority: rules.priority
				})
				.from(rules)
				.all()
		),
		knownCounterparties: knownCounterparties(db),
		// Alleen naam en ID; IBANs van anderen gaan niet naar de browser
		people: db
			.select({ id: people.id, name: people.name })
			.from(people)
			.where(eq(people.active, true))
			.orderBy(asc(people.name))
			.all(),
		openPosts: matchablePosts(db),
		// Uitgaven van de laatste 60 dagen voor `retour`; zonder IBANs
		refundTargets: refundTargets(db, toIsoDate(new Date()))
	};
}
