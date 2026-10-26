import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { toIsoDate } from '#lib/dates.ts';
import { db } from '#lib/server/db/index.ts';
import { ValidationError } from '#lib/server/errors.ts';
import { deleteTag, setTransactionTag, tagDetail, updateTag } from '#lib/server/tags.ts';
import { fromForm, tagFormSchema, toTagInput } from '../form.ts';
import type { Actions, PageServerLoad } from './$types';

const idSchema = z.uuid();
const toggleSchema = z.object({ transactionId: z.uuid(), on: z.enum(['0', '1']) });

export const load: PageServerLoad = ({ params }) => {
	if (!idSchema.safeParse(params.id).success) error(404, 'Niet gevonden');
	const today = toIsoDate(new Date());
	const detail = tagDetail(db(), params.id, today);
	if (!detail) error(404, 'Niet gevonden');
	return { ...detail, today };
};

function guarded<T>(fn: () => T) {
	try {
		return fn();
	} catch (e) {
		if (e instanceof ValidationError) return fail(400, { message: `${e.message}.` });
		throw e;
	}
}

export const actions: Actions = {
	save: async ({ params, request }) => {
		if (!idSchema.safeParse(params.id).success) error(404, 'Niet gevonden');
		const parsed = tagFormSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Vul een naam en een begindatum in.' });
		return guarded(() => {
			if (!updateTag(db(), params.id, toTagInput(parsed.data))) error(404, 'Niet gevonden');
			return { saved: true };
		});
	},
	toggle: async ({ params, request }) => {
		if (!idSchema.safeParse(params.id).success) error(404, 'Niet gevonden');
		const parsed = toggleSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Onbekende transactie.' });
		return guarded(() => {
			setTransactionTag(db(), parsed.data.transactionId, params.id, parsed.data.on === '1');
			return { toggled: parsed.data.on === '1' ? 'aan' : 'uit' };
		});
	},
	delete: async ({ params }) => {
		if (!idSchema.safeParse(params.id).success) error(404, 'Niet gevonden');
		deleteTag(db(), params.id);
		redirect(303, '/tags?verwijderd=1');
	}
};
