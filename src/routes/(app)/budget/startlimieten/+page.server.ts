import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { toIsoDate } from '#lib/dates.ts';
import { parseAmount } from '#lib/money.ts';
import { db } from '#lib/server/db/index.ts';
import { ValidationError } from '#lib/server/errors.ts';
import { applyStartLimits, startLimitsPage } from '#lib/server/startLimits.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ page: startLimitsPage(db(), toIsoDate(new Date())) });

// Per aangevinkte categorie een bedragveld `limiet-<id>`; het spaardoel gaat niet mee, dat
// wordt niet bewaard (spec: Startlimieten uit historie).
const picks = z.array(z.uuid()).max(200);

export const actions: Actions = {
	apply: async ({ request }) => {
		const form = await request.formData();
		const parsed = picks.safeParse(form.getAll('kies'));
		if (!parsed.success) return fail(400, { message: 'Controleer de invoer.', categoryId: null });
		const entries = [];
		for (const categoryId of parsed.data) {
			const text = String(form.get(`limiet-${categoryId}`) ?? '').trim();
			const cents = text.length > 16 ? null : parseAmount(text);
			if (cents === null || cents === 0)
				return fail(400, {
					message:
						cents === 0 ? 'Een limiet moet meer dan € 0 zijn.' : 'Dat bedrag kan ik niet lezen.',
					categoryId
				});
			entries.push({ categoryId, limitCents: cents });
		}
		try {
			return applyStartLimits(db(), toIsoDate(new Date()), entries);
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: e.message, categoryId: null });
			throw e;
		}
	}
};
