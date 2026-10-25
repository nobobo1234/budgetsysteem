import { error } from '@sveltejs/kit';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { db } from '#lib/server/db/index.ts';
import { requireSession } from '#lib/server/http.ts';
import { previewImage } from '#lib/server/receipts/preview.ts';
import { loadReceipt } from '#lib/server/receipts/process.ts';
import { receiptPath } from '#lib/server/receipts/store.ts';
import type { RequestHandler } from './$types';

// Een kleine preview van een bon voor de interface (spec: Beeldkwaliteit: "de interface gebruikt
// een kleine preview"). Het origineel blijft het archief en verlaat de server niet. Alleen met
// een sessie; het pad komt uit de database, nooit uit het verzoek.
const sizeSchema = z.enum(['klein', 'groot']).catch('groot');

export const GET: RequestHandler = async (event) => {
	requireSession(event);
	const id = z.uuid().safeParse(event.params.id);
	if (!id.success) error(404, 'Niet gevonden');
	const receipt = loadReceipt(db(), id.data);
	if (!receipt) error(404, 'Niet gevonden');
	let original: Buffer;
	try {
		original = await readFile(receiptPath(receipt.fileId, receipt.mediaType));
	} catch {
		error(404, 'Niet gevonden');
	}
	const size = sizeSchema.parse(event.url.searchParams.get('formaat'));
	const body = await previewImage(original, size);
	return new Response(new Uint8Array(body), {
		headers: {
			'content-type': 'image/jpeg',
			// Een bon verandert nooit; alleen in de eigen browser bewaren
			'cache-control': 'private, max-age=86400',
			'x-content-type-options': 'nosniff'
		}
	});
};
