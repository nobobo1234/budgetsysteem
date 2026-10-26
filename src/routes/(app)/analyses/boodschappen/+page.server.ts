import { shiftMonth, toIsoDate } from '#lib/dates.ts';
import { db } from '#lib/server/db/index.ts';
import { groceryOverview } from '#lib/server/groceries.ts';
import type { PageServerLoad } from './$types';

// Boodschappen per productgroep (spec: Schermen, Analyses → Boodschappen per productgroep): de
// boodschappen van een maand verdeeld over de groepen, uit de regels van je bonnen. Alleen
// lezen; een groep aanpas je op de bon zelf.

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const load: PageServerLoad = ({ url, setHeaders }) => {
	setHeaders({ 'cache-control': 'private, no-cache' });
	const current = toIsoDate(new Date()).slice(0, 7);
	const asked = url.searchParams.get('maand');
	const month = asked && MONTH.test(asked) && asked <= current ? asked : current;
	const o = groceryOverview(db(), month);
	return {
		month,
		previous: shiftMonth(month, -1),
		next: month < current ? shiftMonth(month, 1) : null,
		isCurrent: month === current,
		missingCategory: o.missingCategory,
		coverage: o.coverage,
		rows: o.rows,
		discount: o.discount,
		total: o.total,
		comparedMonths: o.comparedMonths,
		topLines: o.topLines.map((l) => ({
			id: l.id,
			receiptId: l.receiptId,
			description: l.description,
			cents: l.cents,
			group: l.group,
			date: l.date,
			counterparty: l.counterparty
		}))
	};
};
