import { fail } from '@sveltejs/kit';
import { asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { normalizeCounterparty } from '#lib/text.ts';
import { recordChange } from '#lib/server/audit.ts';
import { db } from '#lib/server/db/index.ts';
import { categories, importBatches, rules } from '#lib/server/db/schema.ts';
import { ImportError, parseBankFile } from '#lib/server/import/index.ts';
import {
	applyRules,
	countCardCounterpartyRepairs,
	fillCardCounterparties,
	importRecords,
	uncategorizedGroups
} from '#lib/server/import/importer.ts';
import { MAX_IMPORT_BYTES } from '#lib/server/import/types.ts';
import { log } from '#lib/server/log.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({
	batches: db().select().from(importBatches).orderBy(desc(importBatches.createdAt)).limit(5).all(),
	uncategorized: uncategorizedGroups(db()),
	// Pinbetalingen uit een import van vóór de herkenning van winkelnamen
	repairable: countCardCounterpartyRepairs(db()),
	categories: db()
		.select({ id: categories.id, name: categories.name, group: categories.group })
		.from(categories)
		.where(eq(categories.archived, false))
		.orderBy(asc(categories.sortOrder))
		.all()
});

const ruleSchema = z.object({
	pattern: z.string().trim().min(2).max(100),
	categoryId: z.uuid()
});

export const actions: Actions = {
	upload: async ({ request }) => {
		const form = await request.formData();
		const file = form.get('file');
		if (!(file instanceof File) || file.size === 0)
			return fail(400, { message: 'Kies een bestand.' });
		if (file.size > MAX_IMPORT_BYTES)
			return fail(413, { message: 'Het bestand is groter dan 20 MB.' });
		try {
			const { format, records } = parseBankFile(new Uint8Array(await file.arrayBuffer()));
			const summary = importRecords(db(), records, format);
			log.info({ format, new: summary.newCount, duplicates: summary.duplicateCount }, 'import');
			return { summary };
		} catch (e) {
			if (e instanceof ImportError) return fail(400, { message: e.message });
			throw e;
		}
	},
	repair: () => {
		const repaired = fillCardCounterparties(db());
		log.info(repaired, 'tegenpartijen van pinbetalingen ingevuld');
		return { repaired };
	},
	rule: async ({ request }) => {
		const parsed = ruleSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Kies een categorie.' });
		const pattern = normalizeCounterparty(parsed.data.pattern);
		if (pattern.length < 2) return fail(400, { message: 'Dit patroon is te kort.' });
		const exists = db()
			.select({ id: categories.id })
			.from(categories)
			.where(eq(categories.id, parsed.data.categoryId))
			.get();
		if (!exists) return fail(400, { message: 'Onbekende categorie.' });
		const rule = db()
			.insert(rules)
			.values({ field: 'tegenpartij', pattern, categoryId: parsed.data.categoryId })
			.onConflictDoUpdate({
				target: [rules.field, rules.pattern],
				set: { categoryId: parsed.data.categoryId }
			})
			.returning()
			.get();
		recordChange(db(), 'regel', 'rules', rule.id, null, rule);
		return { applied: applyRules(db()), pattern };
	}
};
