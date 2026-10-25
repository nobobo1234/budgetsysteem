import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { toIsoDate } from '#lib/dates.ts';
import { MAX_CENTS, parseAmount } from '#lib/money.ts';
import { db } from '#lib/server/db/index.ts';
import { ValidationError } from '#lib/server/errors.ts';
import { createOwed, deleteOwed, forgiveOwed, owedOverview, updateOwed } from '#lib/server/owed.ts';
import { findOrCreatePerson, listPeople } from '#lib/server/people.ts';
import { openShareCount } from '#lib/server/shares.ts';
import { dateInRange, optionalHttpsUrl, personName } from '#lib/server/validation.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const today = toIsoDate(new Date());
	return {
		today,
		overview: owedOverview(db(), today),
		people: listPeople(db()),
		openShares: openShareCount(db())
	};
};

const idSchema = z.object({ id: z.uuid() });

const newSchema = z.object({
	direction: z.enum(['te_krijgen', 'te_betalen']),
	personId: z.union([z.uuid(), z.literal('')]),
	newName: z.union([personName, z.literal('')]),
	amount: z.string().trim().min(1).max(16),
	description: z.string().trim().max(100),
	date: z.iso.date(),
	tikkieUrl: optionalHttpsUrl
});

const editSchema = z.object({
	id: z.uuid(),
	personId: z.union([z.uuid(), z.literal('')]).optional(),
	note: z.string().trim().max(500),
	tikkieUrl: optionalHttpsUrl
});

function fromForm(form: FormData) {
	return Object.fromEntries([...form].map(([k, v]) => [k, typeof v === 'string' ? v : '']));
}

function guarded<T>(fn: () => T) {
	try {
		return fn();
	} catch (e) {
		if (e instanceof ValidationError) return fail(400, { message: `${e.message}.` });
		throw e;
	}
}

export const actions: Actions = {
	add: async ({ request }) => {
		const parsed = newSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Controleer de velden.' });
		const { direction, personId, newName, description, date, tikkieUrl } = parsed.data;
		const cents = parseAmount(parsed.data.amount);
		if (cents === null || cents === 0 || cents > MAX_CENTS)
			return fail(400, { message: 'Dat bedrag kan ik niet lezen.' });
		if (!dateInRange(date)) return fail(400, { message: 'Die datum ligt te ver weg.' });
		if (!personId && !newName) return fail(400, { message: 'Kies een persoon.' });
		return guarded(() => {
			const who = personId || db().transaction((tx) => findOrCreatePerson(tx, newName));
			createOwed(db(), {
				personId: who,
				direction,
				amountCents: cents,
				description,
				date,
				tikkieUrl
			});
			return { added: true };
		});
	},
	edit: async ({ request }) => {
		const parsed = editSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success)
			return fail(400, { message: 'Controleer de velden; een Tikkie-link begint met https://.' });
		const { id, personId, note, tikkieUrl } = parsed.data;
		return guarded(() => {
			updateOwed(db(), id, { note, tikkieUrl, ...(personId ? { personId } : {}) });
			return { saved: true };
		});
	},
	forgive: async ({ request }) => {
		const parsed = idSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Onbekende post.' });
		return guarded(() => {
			forgiveOwed(db(), parsed.data.id);
			return { forgiven: parsed.data.id };
		});
	},
	unforgive: async ({ request }) => {
		const parsed = idSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Onbekende post.' });
		return guarded(() => {
			forgiveOwed(db(), parsed.data.id, true);
			return { restored: true };
		});
	},
	delete: async ({ request }) => {
		const parsed = idSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Onbekende post.' });
		return guarded(() => {
			deleteOwed(db(), parsed.data.id);
			return { deleted: true };
		});
	}
};
