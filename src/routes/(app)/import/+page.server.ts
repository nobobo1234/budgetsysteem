import { fail } from '@sveltejs/kit';
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isIsoDate } from '#lib/dates.ts';
import { normalizeCounterparty } from '#lib/text.ts';
import { recordChange } from '#lib/server/audit.ts';
import { db } from '#lib/server/db/index.ts';
import { categories, importBatches, rules, transactions } from '#lib/server/db/schema.ts';
import { ImportError, parseBankFile } from '#lib/server/import/index.ts';
import {
	applyRules,
	countCardCounterpartyRepairs,
	fillCardCounterparties,
	importRecords,
	uncategorizedGroups
} from '#lib/server/import/importer.ts';
import { MAX_IMPORT_BYTES } from '#lib/server/import/types.ts';
import { unlinkCorrection } from '#lib/server/corrections.ts';
import { log } from '#lib/server/log.ts';
import { proposalCount, refreshProposals } from '#lib/server/recurring.ts';
import type { Actions, PageServerLoad } from './$types';

/** De categorieën die je het vaakst gebruikt, als snelle keuze naast het voorstel. */
function topCategories(limit = 4): string[] {
	return db()
		.select({ id: transactions.categoryId })
		.from(transactions)
		.innerJoin(categories, eq(categories.id, transactions.categoryId))
		.where(
			and(
				isNotNull(transactions.categoryId),
				eq(categories.archived, false),
				eq(categories.countsForBudget, true)
			)
		)
		.groupBy(transactions.categoryId)
		.orderBy(desc(sql`count(*)`))
		.limit(limit)
		.all()
		.map((r) => r.id!);
}

export const load: PageServerLoad = () => ({
	topCategories: topCategories(),
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

/** Leeg betekent: alles importeren */
const fromSchema = z.union([z.literal(''), z.string().refine(isIsoDate)]);

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
		const from = fromSchema.safeParse(form.get('from') ?? '');
		if (!from.success) return fail(400, { message: 'Ongeldige begindatum.' });
		try {
			const { format, records, balances } = parseBankFile(new Uint8Array(await file.arrayBuffer()));
			const summary = importRecords(db(), records, format, {
				from: from.data || undefined,
				balances
			});
			log.info({ format, new: summary.newCount, duplicates: summary.duplicateCount }, 'import');
			// Vaste lasten meteen uit de nieuwe historie voorstellen
			refreshProposals(db());
			return { summary, proposals: proposalCount(db()) };
		} catch (e) {
			if (e instanceof ImportError) return fail(400, { message: e.message });
			throw e;
		}
	},
	/** Een automatisch verrekende storno weer losmaken: hij komt op te controleren */
	undoReversal: async ({ request }) => {
		const id = z.uuid().safeParse((await request.formData()).get('id'));
		if (!id.success) return fail(400, { message: 'Deze boeking ken ik niet.' });
		const done = db().transaction((tx) => unlinkCorrection(tx, id.data));
		if (!done) return fail(400, { message: 'Deze boeking is niet (meer) gekoppeld.' });
		return { undone: id.data };
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
