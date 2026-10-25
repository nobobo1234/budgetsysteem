import { toIsoDate } from '#lib/dates.ts';
import { balanceCheckDue } from '#lib/server/balance.ts';
import { monthOverview } from '#lib/server/budgets.ts';
import { quickEntryContext } from '#lib/server/context.ts';
import { db } from '#lib/server/db/index.ts';
import { owedSummary } from '#lib/server/owed.ts';
import { listTransactions, reviewCount } from '#lib/server/transactions.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ setHeaders }) => {
	const today = toIsoDate(new Date());
	const month = today.slice(0, 7);
	// Privé en niet zonder controle hergebruiken; wel bruikbaar als offline terugval
	setHeaders({ 'cache-control': 'private, no-cache' });
	return {
		today,
		overview: monthOverview(db(), month, today),
		recent: listTransactions(db(), { limit: 8 }),
		reviewCount: reviewCount(db()),
		owed: owedSummary(db()),
		balanceCheckDue: balanceCheckDue(db(), today),
		context: quickEntryContext(db())
	};
};
