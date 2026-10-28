import { toIsoDate } from '#lib/dates.ts';
import { db } from '#lib/server/db/index.ts';
import { listWarranties } from '#lib/server/warranty.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ setHeaders }) => {
	const today = toIsoDate(new Date());
	setHeaders({ 'cache-control': 'private, no-cache' });
	return { today, ...listWarranties(db(), today) };
};
