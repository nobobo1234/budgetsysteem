import { db } from '#lib/server/db/index.ts';
import { listItemCounts } from '#lib/server/receipts/list.ts';
import { recentReceipts } from '#lib/server/receipts/process.ts';
import { receiptView } from '#lib/server/receipts/view.ts';
import type { PageServerLoad } from './$types';

// Bonnen (spec: Schermen): uploaden en de laatste bonnen met hun stand. De pagina ververst zelf
// zolang er een bon gelezen wordt (`app:bonnen`).
export const load: PageServerLoad = ({ depends, setHeaders }) => {
	depends('app:bonnen');
	setHeaders({ 'cache-control': 'private, no-cache' });
	const recent = recentReceipts(db(), 50);
	const counts = listItemCounts(
		db(),
		recent.filter((r) => r.kind === 'lijst').map((r) => r.id)
	);
	return { receipts: recent.map((r) => receiptView(r, counts.get(r.id) ?? 0)) };
};
