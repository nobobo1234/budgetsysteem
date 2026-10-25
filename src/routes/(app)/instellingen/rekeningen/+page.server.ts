import { fail } from '@sveltejs/kit';
import { and, asc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { isValidIban, normalizeIban } from '#lib/text.ts';
import { recordChange } from '#lib/server/audit.ts';
import { db } from '#lib/server/db/index.ts';
import { accounts } from '#lib/server/db/schema.ts';
import { requireSession } from '#lib/server/http.ts';
import { personByIban } from '#lib/server/people.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({
	accounts: db().select().from(accounts).orderBy(asc(accounts.createdAt)).all()
});

const accountSchema = z.object({
	id: z.uuid(),
	name: z.string().trim().min(1).max(40),
	alias: z
		.string()
		.trim()
		.toLowerCase()
		.regex(/^[a-z][a-z0-9]{1,9}$/),
	iban: z.string().trim().max(42)
});

export const actions: Actions = {
	account: async (event) => {
		requireSession(event);
		const parsed = accountSchema.safeParse(Object.fromEntries(await event.request.formData()));
		if (!parsed.success)
			return fail(400, { message: 'Naam en een korte alias (letters en cijfers) zijn nodig.' });
		const iban = parsed.data.iban ? normalizeIban(parsed.data.iban) : null;
		if (iban && !isValidIban(iban)) return fail(400, { message: 'Dat IBAN klopt niet.' });
		if (iban && personByIban(db(), iban))
			return fail(400, { message: 'Dat IBAN staat bij een persoon, niet bij een eigen rekening.' });
		const clash = db()
			.select({ id: accounts.id })
			.from(accounts)
			.where(and(eq(accounts.alias, parsed.data.alias), ne(accounts.id, parsed.data.id)))
			.get();
		if (clash) return fail(400, { message: 'Die alias is al in gebruik.' });
		const before = db().select().from(accounts).where(eq(accounts.id, parsed.data.id)).get();
		if (!before) return fail(404, { message: 'Onbekende rekening.' });
		try {
			const after = db()
				.update(accounts)
				.set({ name: parsed.data.name, alias: parsed.data.alias, iban })
				.where(eq(accounts.id, parsed.data.id))
				.returning()
				.get();
			recordChange(db(), 'gewijzigd', 'accounts', after.id, before, after);
		} catch {
			return fail(400, { message: 'Dat IBAN hoort al bij een andere rekening.' });
		}
		return { ok: true };
	}
};
