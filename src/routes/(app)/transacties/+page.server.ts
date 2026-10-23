import { asc, eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import { categories } from '#lib/server/db/schema.ts';
import { listTransactions } from '#lib/server/transactions.ts';
import type { PageServerLoad } from './$types';

const PAGE = 50;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const load: PageServerLoad = ({ url }) => {
	const q = (url.searchParams.get('q') ?? '').slice(0, 100);
	const monthParam = url.searchParams.get('maand') ?? '';
	const month = MONTH.test(monthParam) ? monthParam : '';
	const categoryParam = url.searchParams.get('categorie') ?? '';
	const categoryId = categoryParam === 'geen' || UUID.test(categoryParam) ? categoryParam : '';
	const status = url.searchParams.get('status') === 'te_controleren' ? 'te_controleren' : undefined;
	const page = Math.max(
		0,
		Math.min(10_000, Number.parseInt(url.searchParams.get('pagina') ?? '0', 10) || 0)
	);

	const rows = listTransactions(db(), {
		q,
		month: month || undefined,
		categoryId: categoryId || undefined,
		status,
		limit: PAGE + 1,
		offset: page * PAGE
	});

	return {
		filter: { q, month, categoryId, status },
		page,
		hasMore: rows.length > PAGE,
		transactions: rows.slice(0, PAGE),
		categories: db()
			.select({ id: categories.id, name: categories.name })
			.from(categories)
			.where(eq(categories.archived, false))
			.orderBy(asc(categories.sortOrder))
			.all()
	};
};
