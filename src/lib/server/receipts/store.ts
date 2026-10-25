import { error } from '@sveltejs/kit';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { config } from '../config.ts';
import type { DB } from '../db/index.ts';
import { receipts } from '../db/schema.ts';
import { declareJob, enqueue, runJobsSoon } from '../jobs.ts';
import { log } from '../log.ts';
import {
	MAX_UPLOAD_BYTES,
	declaredMediaType,
	extensionFor,
	sniffImage,
	type MediaType
} from './image.ts';

// Een bon binnenhalen (spec: Bonnetjes → Verwerking, Uploaden via het deelmenu): handtekening
// controleren, opnieuw encoderen met sharp (EXIF en andere metadata eraf), opslaan buiten de
// webroot onder een eigen UUID en een taak `bon_lezen` in de wachtrij. Voor het deelmenu
// (`/api/ingest`) en voor uploads vanuit de app zelf.

/** De taak die een bon door Haiku laat lezen. Payload: `{ receiptId }`. */
export const READ_RECEIPT_JOB = 'bon_lezen';
// De handler (receipts/worker.ts) wordt alleen geregistreerd met een API-sleutel; zonder blijven
// de taken wachten in plaats van te mislukken
declareJob(READ_RECEIPT_JOB);

export interface ReadReceiptPayload {
	receiptId: string;
}

/**
 * Groter dan een foto van 48 megapixel weigeren we: een klein PNG-bestand kan anders
 * uitpakken tot gigabytes (decompressiebom). De app en de opdracht schalen naar 2576 px.
 */
const MAX_PIXELS = 50_000_000;

// Eén container met 512 MB: geen cache van gedecodeerde beelden en één thread per beeld
sharp.cache(false);
sharp.concurrency(1);

export function receiptsDir(): string {
	const c = config();
	return c.RECEIPTS_DIR ?? join(dirname(c.DATABASE_PATH), 'receipts');
}

/** Pad van een bon op schijf. Alleen uit de database (UUID), nooit uit invoer. */
export function receiptPath(fileId: string, mediaType: MediaType): string {
	return join(receiptsDir(), `${fileId}.${extensionFor(mediaType)}`);
}

/**
 * Leest een ruwe body (image/jpeg of image/png) met een groottelimiet. De Content-Length
 * kan liegen; daarom telt hij ook tijdens het lezen. Bij twijfel weigeren.
 */
export async function readImageBody(
	request: Request
): Promise<{ bytes: Buffer; mediaType: MediaType }> {
	const declared = declaredMediaType(request.headers.get('content-type'));
	if (!declared) error(415, 'Alleen JPEG of PNG.');
	const length = Number(request.headers.get('content-length') ?? '0');
	if (length > MAX_UPLOAD_BYTES) error(413, 'De afbeelding is groter dan 10 MB.');
	if (!request.body) error(400, 'Geen afbeelding ontvangen.');

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_UPLOAD_BYTES) {
			await reader.cancel();
			error(413, 'De afbeelding is groter dan 10 MB.');
		}
		chunks.push(value);
	}
	const bytes = Buffer.concat(chunks);
	if (bytes.length === 0) error(400, 'Geen afbeelding ontvangen.');
	if (sniffImage(bytes) !== declared) error(415, 'Het bestand is geen JPEG of PNG.');
	return { bytes, mediaType: declared };
}

/**
 * Decodeert en encodeert opnieuw in hetzelfde formaat. De oriëntatie uit EXIF wordt eerst
 * toegepast; daarna gaat alle metadata eraf (sharp neemt die standaard niet mee). Een
 * screenshot blijft PNG, zodat kleine tekst scherp blijft; een foto wordt één keer JPEG 90.
 */
export async function reencode(bytes: Buffer, mediaType: MediaType): Promise<Buffer> {
	const format = mediaType === 'image/png' ? 'png' : 'jpeg';
	try {
		const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'warning' });
		const meta = await image.metadata();
		if (meta.format !== format) throw new Error('Ander formaat dan de handtekening');
		const oriented = image.autoOrient();
		return format === 'png'
			? await oriented.png({ compressionLevel: 9 }).toBuffer()
			: await oriented.jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer();
	} catch (e) {
		// De melding van libvips kan iets over het bestand zeggen; alleen de soort fout loggen
		log.warn({ err: { name: e instanceof Error ? e.name : 'Onbekend' } }, 'bon niet te lezen');
		error(422, 'De afbeelding is beschadigd of te groot.');
	}
}

/**
 * Slaat een bon op en zet hem in de wachtrij om gelezen te worden. Het bestand komt eerst;
 * lukt de database daarna niet, dan gaat het bestand weer weg.
 */
export async function storeReceipt(
	db: DB,
	input: {
		bytes: Buffer;
		mediaType: MediaType;
		source: 'app' | 'deelmenu';
		uploadTokenId?: string;
	},
	now = new Date()
): Promise<{ id: string }> {
	const clean = await reencode(input.bytes, input.mediaType);
	const fileId = crypto.randomUUID();
	const path = receiptPath(fileId, input.mediaType);
	await mkdir(receiptsDir(), { recursive: true, mode: 0o700 });
	// `wx`: nooit een bestaand bestand overschrijven
	await writeFile(path, clean, { flag: 'wx', mode: 0o600 });
	try {
		const id = db.transaction((tx) => {
			const receipt = tx
				.insert(receipts)
				.values({
					fileId,
					mediaType: input.mediaType,
					source: input.source,
					uploadTokenId: input.uploadTokenId ?? null,
					status: 'wordt_gelezen'
				})
				.returning({ id: receipts.id })
				.get();
			enqueue(tx, READ_RECEIPT_JOB, now, { receiptId: receipt.id } satisfies ReadReceiptPayload);
			return receipt.id;
		});
		log.info({ receipt: id, source: input.source }, 'bon ontvangen');
		// Meteen lezen, niet pas bij de volgende ronde van de worker
		runJobsSoon();
		return { id };
	} catch (e) {
		await rm(path, { force: true });
		throw e;
	}
}
