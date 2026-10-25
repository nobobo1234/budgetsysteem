import { db } from '#lib/server/db/index.ts';
import { recentReceipts } from '#lib/server/receipts/process.ts';
import { receiptView } from '#lib/server/receipts/view.ts';
import type { PageServerLoad } from './$types';

// Bonnen (spec: Schermen): uploaden en de laatste bonnen met hun stand. De pagina ververst zelf
// zolang er een bon gelezen wordt (`app:bonnen`).
export const load: PageServerLoad = ({ depends, setHeaders }) => {
	depends('app:bonnen');
	setHeaders({ 'cache-control': 'private, no-cache' });
	return { receipts: recentReceipts(db(), 50).map(receiptView) };
};
