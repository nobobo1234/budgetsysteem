import { FIXED_GROUP } from '#lib/budget.ts';
import { toIsoDate } from '#lib/dates.ts';
import { trendAnalysis } from '#lib/server/analyses.ts';
import { db } from '#lib/server/db/index.ts';
import type { PageServerLoad } from './$types';

// De groep van de vaste lasten komt mee, zodat de pagina budget.ts niet laadt (eigen chunk op
// het startscherm, buiten het JS-budget)
export const load: PageServerLoad = () => ({
	trend: trendAnalysis(db(), toIsoDate(new Date())),
	fixedGroup: FIXED_GROUP
});
