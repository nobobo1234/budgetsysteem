import { FIXED_GROUP } from '#lib/budget.ts';
import { shiftMonth, toIsoDate } from '#lib/dates.ts';
import { monthAnalysis } from '#lib/server/analyses.ts';
import { db } from '#lib/server/db/index.ts';
import type { PageServerLoad } from './$types';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const load: PageServerLoad = ({ url }) => {
	const today = toIsoDate(new Date());
	const current = today.slice(0, 7);
	const asked = url.searchParams.get('maand');
	// Een maand die nog moet komen heeft niets te analyseren
	const month = asked && MONTH.test(asked) && asked <= current ? asked : current;
	return {
		analysis: monthAnalysis(db(), month, today),
		// Hier en niet in de pagina: budget.ts zou anders een eigen chunk op het startscherm worden
		fixedGroup: FIXED_GROUP,
		previous: shiftMonth(month, -1),
		next: month < current ? shiftMonth(month, 1) : null
	};
};
