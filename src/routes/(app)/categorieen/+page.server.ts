import { fail } from '@sveltejs/kit';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '#lib/server/audit.ts';
import { db } from '#lib/server/db/index.ts';
import { categories, rules } from '#lib/server/db/schema.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({
	categories: db()
		.select()
		.from(categories)
		.orderBy(asc(categories.sortOrder), asc(categories.name))
		.all(),
	ruleCount:
		db()
			.select({ n: sql<number>`count(*)` })
			.from(rules)
			.get()?.n ?? 0
});

const categorySchema = z.object({
	name: z.string().trim().min(1).max(60),
	group: z.string().trim().min(1).max(40),
	countsForBudget: z.literal('on').optional(),
	tracksWarranty: z.literal('on').optional()
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
					tracksWarranty: parsed.data.tracksWarranty === 'on',
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
					countsForBudget: parsed.data.countsForBudget === 'on',
					tracksWarranty: parsed.data.tracksWarranty === 'on'
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
	}
};
