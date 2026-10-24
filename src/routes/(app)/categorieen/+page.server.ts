import { fail } from '@sveltejs/kit';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { normalizeCounterparty, normalizeIban, normalize } from '#lib/text.ts';
import { recordChange } from '#lib/server/audit.ts';
import { db } from '#lib/server/db/index.ts';
import { categories, rules } from '#lib/server/db/schema.ts';
import { applyRulesToUncategorized } from '#lib/server/import/importer.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({
	categories: db()
		.select()
		.from(categories)
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

const categorySchema = z.object({
	name: z.string().trim().min(1).max(60),
	group: z.string().trim().min(1).max(40),
	countsForBudget: z.literal('on').optional()
});

const ruleSchema = z.object({
	field: z.enum(['tegenpartij', 'iban', 'omschrijving']),
	pattern: z.string().trim().min(2).max(100),
	categoryId: z.uuid(),
	priority: z.coerce.number().int().min(0).max(1000).default(100)
});

const idSchema = z.object({ id: z.uuid() });

function isUniqueError(e: unknown): boolean {
	return e instanceof Error && 'code' in e && String(e.code).startsWith('SQLITE_CONSTRAINT');
}

export const actions: Actions = {
	addCategory: async ({ request }) => {
		const parsed = categorySchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Geef een naam en groep op.' });
		const max =
			db()
				.select({ n: sql<number>`coalesce(max(${categories.sortOrder}), 0)` })
				.from(categories)
				.get()?.n ?? 0;
		try {
			const row = db()
				.insert(categories)
				.values({
					name: parsed.data.name,
					group: parsed.data.group,
					countsForBudget: parsed.data.countsForBudget === 'on',
					sortOrder: max + 1
				})
				.returning()
				.get();
			recordChange(db(), 'aangemaakt', 'categories', row.id, null, row);
		} catch (e) {
			if (isUniqueError(e)) return fail(400, { message: 'Die categorie bestaat al.' });
			throw e;
		}
		return { ok: true };
	},
	updateCategory: async ({ request }) => {
		const form = Object.fromEntries(await request.formData());
		const id = idSchema.safeParse(form);
		const parsed = categorySchema.safeParse(form);
		if (!id.success || !parsed.success) return fail(400, { message: 'Controleer de invoer.' });
		const before = db().select().from(categories).where(eq(categories.id, id.data.id)).get();
		if (!before) return fail(404, { message: 'Niet gevonden.' });
		try {
			const after = db()
				.update(categories)
				.set({
					name: parsed.data.name,
					group: parsed.data.group,
					countsForBudget: parsed.data.countsForBudget === 'on'
				})
				.where(eq(categories.id, id.data.id))
				.returning()
				.get();
			recordChange(db(), 'gewijzigd', 'categories', id.data.id, before, after);
		} catch (e) {
			if (isUniqueError(e)) return fail(400, { message: 'Die naam bestaat al.' });
			throw e;
		}
		return { ok: true };
	},
	archiveCategory: async ({ request }) => {
		const id = idSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!id.success) return fail(400, { message: 'Onbekende categorie.' });
		const before = db().select().from(categories).where(eq(categories.id, id.data.id)).get();
		if (!before) return fail(404, { message: 'Niet gevonden.' });
		db()
			.update(categories)
			.set({ archived: !before.archived })
			.where(eq(categories.id, id.data.id))
			.run();
		recordChange(
			db(),
			before.archived ? 'teruggezet' : 'gearchiveerd',
			'categories',
			id.data.id,
			before,
			null
		);
		return { ok: true };
	},
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
