import { toIsoDate } from '#lib/dates.ts';
import { trendAnalysis } from '#lib/server/analyses.ts';
import { db } from '#lib/server/db/index.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({
	trend: trendAnalysis(db(), toIsoDate(new Date()))
});
