import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '#lib/server/db/index.ts';
import { ValidationError } from '#lib/server/errors.ts';
import { openPosts } from '#lib/server/owed.ts';
import {
	addIban,
	createPerson,
	deletePerson,
	ibansOf,
	listPeople,
	removeIban,
	updatePerson
} from '#lib/server/people.ts';
import { personName } from '#lib/server/validation.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const open = new Map<string, { toReceive: number; toPay: number }>();
	for (const p of openPosts(db())) {
		if (!p.personId) continue;
		const sum = open.get(p.personId) ?? { toReceive: 0, toPay: 0 };
		if (p.direction === 'te_krijgen') sum.toReceive += p.outstandingCents;
		else sum.toPay += p.outstandingCents;
		open.set(p.personId, sum);
	}
	const people = listPeople(db()).map((p) => ({
		...p,
		ibans: ibansOf(db(), p.id),
		...(open.get(p.id) ?? { toReceive: 0, toPay: 0 })
	}));
	return { people, openCount: openPosts(db()).length };
};

const idSchema = z.object({ id: z.uuid() });
const addSchema = z.object({ name: personName });
const editSchema = z.object({ id: z.uuid(), name: personName, active: z.literal('on').optional() });
const ibanSchema = z.object({ id: z.uuid(), iban: z.string().trim().min(15).max(42) });

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
		const parsed = addSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Een naam van hooguit 40 tekens.' });
		return guarded(() => {
			createPerson(db(), parsed.data.name);
			return { added: true };
		});
	},
	edit: async ({ request }) => {
		const parsed = editSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Een naam van hooguit 40 tekens.' });
		return guarded(() => {
			updatePerson(db(), parsed.data.id, {
				name: parsed.data.name,
				active: parsed.data.active === 'on'
			});
			return { saved: true };
		});
	},
	delete: async ({ request }) => {
		const parsed = idSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Onbekende persoon.' });
		return guarded(() => {
			deletePerson(db(), parsed.data.id);
			return { deleted: true };
		});
	},
	addIban: async ({ request }) => {
		const parsed = ibanSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Dat IBAN klopt niet.' });
		return guarded(() => {
			addIban(db(), parsed.data.id, parsed.data.iban);
			return { ibanAdded: true };
		});
	},
	removeIban: async ({ request }) => {
		const parsed = ibanSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Onbekend IBAN.' });
		return guarded(() => {
			removeIban(db(), parsed.data.id, parsed.data.iban);
			return { ibanRemoved: true };
		});
	}
};
