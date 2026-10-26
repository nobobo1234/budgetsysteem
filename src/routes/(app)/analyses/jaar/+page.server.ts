import { FIXED_GROUP } from '#lib/budget.ts';
import { toIsoDate } from '#lib/dates.ts';
import { yearAnalysis } from '#lib/server/analyses.ts';
import { db } from '#lib/server/db/index.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	const today = toIsoDate(new Date());
	const current = Number(today.slice(0, 4));
	const asked = Number(url.searchParams.get('jaar'));
	// Alleen een jaar dat al begonnen is, en niet eindeloos terug
	const year = Number.isInteger(asked) && asked >= 2000 && asked <= current ? asked : current;
	return { year: yearAnalysis(db(), year, today), fixedGroup: FIXED_GROUP };
};
