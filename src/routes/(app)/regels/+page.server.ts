import { fail } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { normalizeCounterparty, normalizeIban, normalize } from '#lib/text.ts';
import { recordChange } from '#lib/server/audit.ts';
import { db } from '#lib/server/db/index.ts';
import { categories, rules } from '#lib/server/db/schema.ts';
import { applyRulesToUncategorized } from '#lib/server/import/importer.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({
	categories: db()
		.select({ id: categories.id, name: categories.name, group: categories.group })
		.from(categories)
		.where(eq(categories.archived, false))
		.orderBy(asc(categories.sortOrder), asc(categories.name))
		.all(),
	rules: db()
		.select({
			id: rules.id,
			field: rules.field,
			pattern: rules.pattern,
			priority: rules.priority,
			categoryId: rules.categoryId,
			categoryName: categories.name,
			categoryGroup: categories.group
		})
		.from(rules)
		.innerJoin(categories, eq(categories.id, rules.categoryId))
		.orderBy(asc(rules.priority), asc(rules.pattern))
		.all()
});

const ruleSchema = z.object({
	field: z.enum(['tegenpartij', 'iban', 'omschrijving']),
	pattern: z.string().trim().min(2).max(100),
	categoryId: z.uuid(),
	priority: z.coerce.number().int().min(0).max(1000).default(100)
});

const idSchema = z.object({ id: z.uuid() });

export const actions: Actions = {
	addRule: async ({ request }) => {
		const parsed = ruleSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Controleer de regel.' });
		const { field, categoryId, priority } = parsed.data;
		const pattern =
			field === 'iban'
				? normalizeIban(parsed.data.pattern)
				: field === 'tegenpartij'
					? normalizeCounterparty(parsed.data.pattern)
					: normalize(parsed.data.pattern);
		if (pattern.length < 2) return fail(400, { message: 'Dit patroon is te kort.' });
		if (
			!db()
				.select({ id: categories.id })
				.from(categories)
				.where(eq(categories.id, categoryId))
				.get()
		) {
			return fail(400, { message: 'Onbekende categorie.' });
		}
		const rule = db()
			.insert(rules)
			.values({ field, pattern, categoryId, priority })
			.onConflictDoUpdate({ target: [rules.field, rules.pattern], set: { categoryId, priority } })
			.returning()
			.get();
		recordChange(db(), 'regel', 'rules', rule.id, null, rule);
		return { applied: applyRulesToUncategorized(db()) };
	},
	deleteRule: async ({ request }) => {
		const id = idSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!id.success) return fail(400, { message: 'Onbekende regel.' });
		const before = db().select().from(rules).where(eq(rules.id, id.data.id)).get();
		if (!before) return fail(404, { message: 'Niet gevonden.' });
		db().delete(rules).where(eq(rules.id, id.data.id)).run();
		recordChange(db(), 'verwijderd', 'rules', id.data.id, before, null);
		return { ok: true };
	}
};
