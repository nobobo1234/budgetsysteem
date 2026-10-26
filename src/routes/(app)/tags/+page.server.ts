import { fail, redirect } from '@sveltejs/kit';
import { toIsoDate } from '#lib/dates.ts';
import { nextHue } from '#lib/tags.ts';
import { db } from '#lib/server/db/index.ts';
import { ValidationError } from '#lib/server/errors.ts';
import { createTag, tagSummaries } from '#lib/server/tags.ts';
import { fromForm, tagFormSchema, toTagInput } from './form.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const today = toIsoDate(new Date());
	const tags = tagSummaries(db(), today);
	return {
		today,
		tags,
		// Een tint die nog niet bij een lopende of komende tag hoort
		hue: nextHue(tags.filter((t) => t.state !== 'voorbij').map((t) => t.hue))
	};
};

export const actions: Actions = {
	create: async ({ request }) => {
		const parsed = tagFormSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Vul een naam en een begindatum in.' });
		let id: string;
		try {
			id = createTag(db(), toTagInput(parsed.data));
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: `${e.message}.` });
			throw e;
		}
		redirect(303, `/tags/${id}`);
	}
};
