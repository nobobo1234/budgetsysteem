import sharp from 'sharp';
import { fitSize, planSlices, type Rect, type Size } from './slicing.ts';

// Beeldvoorbereiding voor de drie varianten uit het testplan (spec: Beeldkwaliteit): 1600 px,
// 2576 px (binnen de tokengrens) en lange bonnen in overlappende stukken. Net als in de browser:
// rechtzetten volgens EXIF, verkleinen, één keer JPEG met kwaliteit 90, metadata eraf (sharp
// schrijft standaard geen metadata weg). Verkleinen en snijden gebeurt op ruwe pixels, zodat elk
// stuk maar één keer gecomprimeerd wordt.

export const VARIANTS = ['1600', '2576', 'stukken'] as const;
export type Variant = (typeof VARIANTS)[number];

export const JPEG_QUALITY = 90;
/** Grens tegen beeldbommen: een telefoonfoto is zo'n 12 tot 50 megapixel. */
const MAX_INPUT_PIXELS = 100_000_000;

export interface PreparedImage {
	data: Buffer;
	mediaType: 'image/jpeg';
	width: number;
	height: number;
}

/** Formaat na rechtzetten volgens de EXIF-oriëntatie (5 t/m 8 zijn een kwartslag gedraaid). */
export async function orientedSize(input: Buffer): Promise<Size> {
	const meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
	if (!meta.width || !meta.height) throw new Error('beeld zonder afmetingen');
	const turned = (meta.orientation ?? 1) >= 5;
	return turned
		? { width: meta.height, height: meta.width }
		: { width: meta.width, height: meta.height };
}

/** Bereidt één foto voor; geeft meerdere stukken bij een lange bon in de variant "stukken". */
export async function prepareImage(input: Buffer, variant: Variant): Promise<PreparedImage[]> {
	const size = await orientedSize(input);
	const plan =
		variant === 'stukken'
			? planSlices(size)
			: (() => {
					const scaled = fitSize(size, variant === '1600' ? 1600 : 2576);
					return { scaled, pieces: [{ left: 0, top: 0, ...scaled }] };
				})();

	const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
		.rotate()
		.resize(plan.scaled.width, plan.scaled.height, { fit: 'fill' })
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const raw = { width: info.width, height: info.height, channels: info.channels };

	return Promise.all(plan.pieces.map((piece) => encodePiece(data, raw, piece)));
}

async function encodePiece(
	data: Buffer,
	raw: { width: number; height: number; channels: 1 | 2 | 3 | 4 },
	piece: Rect
): Promise<PreparedImage> {
	const out = await sharp(data, { raw })
		.extract(piece)
		.jpeg({ quality: JPEG_QUALITY })
		.toBuffer({ resolveWithObject: true });
	return {
		data: out.data,
		mediaType: 'image/jpeg',
		width: out.info.width,
		height: out.info.height
	};
}

/** Bereidt alle foto's van één bon voor, in volgorde; de delen gaan als "Deel 1", "Deel 2" mee. */
export async function prepareReceipt(inputs: Buffer[], variant: Variant): Promise<PreparedImage[]> {
	const parts: PreparedImage[] = [];
	for (const input of inputs) parts.push(...(await prepareImage(input, variant)));
	return parts;
}
