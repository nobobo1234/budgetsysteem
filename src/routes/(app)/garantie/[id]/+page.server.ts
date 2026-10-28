import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { toIsoDate } from '#lib/dates.ts';
import { db } from '#lib/server/db/index.ts';
import { ValidationError } from '#lib/server/errors.ts';
import { discardWarranty, updateWarranty, warrantyDetail } from '#lib/server/warranty.ts';
import { fieldsSchema, fromForm, toFields } from '../form.ts';
import type { Actions, PageServerLoad } from './$types';

const idSchema = z.uuid();

export const load: PageServerLoad = ({ params, setHeaders }) => {
	if (!idSchema.safeParse(params.id).success) error(404, 'Niet gevonden');
	const warranty = warrantyDetail(db(), params.id);
	if (!warranty) error(404, 'Niet gevonden');
	setHeaders({ 'cache-control': 'private, no-cache' });
	return { warranty, today: toIsoDate(new Date()) };
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
		const parsed = fieldsSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success)
			return fail(400, { message: 'Vul een productnaam, afleverdatum en levensduur in.' });
		return guarded(() => {
			if (!updateWarranty(db(), params.id, toFields(parsed.data))) error(404, 'Niet gevonden');
			return { saved: true };
		});
	},
	discard: ({ params }) => {
		if (!idSchema.safeParse(params.id).success) error(404, 'Niet gevonden');
		if (!discardWarranty(db(), params.id)) error(404, 'Niet gevonden');
		return { discarded: true };
	}
};
