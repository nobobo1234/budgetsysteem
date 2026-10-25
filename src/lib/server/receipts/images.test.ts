import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { orientedSize, prepareImage, prepareReceipt } from './images.ts';
import { fitsModel } from './slicing.ts';

// Gemaakte beelden, geen echte bonnen: vlakken in zwart en wit zodat te zien is waar een stuk
// vandaan komt.

async function blank(width: number, height: number, colour = '#ffffff'): Promise<Buffer> {
	return sharp({ create: { width, height, channels: 3, background: colour } })
		.jpeg()
		.toBuffer();
}

/** Bovenste `dark` pixels zwart, de rest wit. */
async function topDark(width: number, height: number, dark: number): Promise<Buffer> {
	const black = await sharp({
		create: { width, height: dark, channels: 3, background: '#000000' }
	})
		.png()
		.toBuffer();
	return sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
		.composite([{ input: black, top: 0, left: 0 }])
		.png()
		.toBuffer();
}

/** Gemiddelde helderheid (0–255) van één rij pixels. */
async function rowMean(jpeg: Buffer, row: number): Promise<number> {
	const { data, info } = await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true });
	let sum = 0;
	for (let x = 0; x < info.width; x++) sum += data[row * info.width + x]!;
	return sum / info.width;
}

const isJpeg = (b: Buffer) => b[0] === 0xff && b[1] === 0xd8;

describe('prepareImage', () => {
	it('verkleint een telefoonfoto tot 1600 px aan de lange kant', async () => {
		const [out, ...rest] = await prepareImage(await blank(3024, 4032), '1600');
		expect(rest).toHaveLength(0);
		expect(out).toMatchObject({ width: 1200, height: 1600, mediaType: 'image/jpeg' });
		expect(isJpeg(out!.data)).toBe(true);
	});

	it('houdt de variant 2576 binnen de tokengrens van het model', async () => {
		const [out] = await prepareImage(await blank(3024, 4032), '2576');
		expect(out!.height).toBeLessThanOrEqual(2576);
		expect(fitsModel(out!.width, out!.height)).toBe(true);
	});

	it('vergroot een klein beeld niet', async () => {
		const [out] = await prepareImage(await blank(400, 600), '2576');
		expect(out).toMatchObject({ width: 400, height: 600 });
	});

	it('zet de foto recht volgens EXIF en haalt de metadata eraf', async () => {
		const turned = await sharp(await blank(400, 300))
			.withMetadata({ orientation: 6 })
			.jpeg()
			.toBuffer();
		expect(await orientedSize(turned)).toEqual({ width: 300, height: 400 });

		const [out] = await prepareImage(turned, '1600');
		expect(out).toMatchObject({ width: 300, height: 400 });
		const meta = await sharp(out!.data).metadata();
		expect(meta.orientation).toBeUndefined();
		expect(meta.exif).toBeUndefined();
	});

	it('snijdt een lange bon in overlappende stukken op de juiste plek', async () => {
		const parts = await prepareImage(await topDark(900, 4500, 2000), 'stukken');
		expect(parts.map((p) => [p.width, p.height])).toEqual([
			[900, 2576],
			[900, 2576]
		]);
		// Deel 1 begint bovenaan (zwart) en eindigt in het wit
		expect(await rowMean(parts[0]!.data, 0)).toBeLessThan(30);
		expect(await rowMean(parts[0]!.data, 2575)).toBeGreaterThan(225);
		// Deel 2 begint op 1924 px: de onderste 76 rijen zwart zitten in de overlap
		expect(await rowMean(parts[1]!.data, 10)).toBeLessThan(30);
		expect(await rowMean(parts[1]!.data, 200)).toBeGreaterThan(225);
		expect(await rowMean(parts[1]!.data, 2575)).toBeGreaterThan(225);
	});

	it('snijdt een gewone bon in de variant "stukken" niet', async () => {
		const parts = await prepareImage(await blank(1000, 3000), 'stukken');
		expect(parts).toHaveLength(1);
		expect(parts[0]).toMatchObject({ width: 859, height: 2576 });
	});

	it('weigert iets dat geen beeld is', async () => {
		await expect(prepareImage(Buffer.from('geen beeld'), '1600')).rejects.toThrow();
	});
});

describe('prepareReceipt', () => {
	it('zet de delen van meerdere foto’s achter elkaar', async () => {
		const parts = await prepareReceipt(
			[await blank(1000, 1000), await blank(900, 4500)],
			'stukken'
		);
		expect(parts.map((p) => p.height)).toEqual([1000, 2576, 2576]);
	});
});
