import { error } from '@sveltejs/kit';
import { db } from '#lib/server/db/index.ts';
import { json, readJson } from '#lib/server/http.ts';
import { createTransaction, ValidationError } from '#lib/server/transactions.ts';
import { newTransactionSchema } from '#lib/server/validation.ts';
import type { RequestHandler } from './$types';

// Nieuwe handmatige transactie (snelinvoer en offline wachtrij). Idempotent op `id`.
export const POST: RequestHandler = async ({ request }) => {
	const parsed = newTransactionSchema.safeParse(await readJson(request));
	if (!parsed.success) error(400, 'Ongeldige invoer');
	try {
		const result = createTransaction(db(), parsed.data);
		return json(result, result.created ? 201 : 200);
	} catch (e) {
		if (e instanceof ValidationError) error(400, e.message);
		throw e;
	}
};
