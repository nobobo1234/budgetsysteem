import { toIsoDate } from '#lib/dates.ts';
import { closedMonths, pendingMonth } from '#lib/server/closing.ts';
import { db } from '#lib/server/db/index.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const today = toIsoDate(new Date());
	return {
		pending: pendingMonth(db(), today),
		months: closedMonths(db()).map((c) => ({
			month: c.month,
			closedAt: c.closedAt,
			outcome: c.snapshot.outcome,
			totalLimitCents: c.snapshot.totalLimitCents,
			totalSpentCents: c.snapshot.totalSpentCents,
			open: c.openItems.length
		}))
	};
};
