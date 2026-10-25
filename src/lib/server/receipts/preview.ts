import sharp from 'sharp';

// Previews van een opgeslagen bon: een vierkantje voor in een lijst en een groter beeld voor het
// bonscherm. Alleen verkleinen, nooit vergroten; geen metadata (sharp schrijft die standaard niet).

const SIZES = {
	klein: { width: 144, height: 144, fit: 'cover' as const, position: 'top' as const },
	groot: { width: 1200, height: 1600, fit: 'inside' as const }
};

export type PreviewSize = keyof typeof SIZES;

export async function previewImage(original: Buffer, size: PreviewSize): Promise<Buffer> {
	return sharp(original, { limitInputPixels: 50_000_000 })
		.rotate()
		.resize({ ...SIZES[size], withoutEnlargement: true })
		.flatten({ background: '#ffffff' })
		.jpeg({ quality: size === 'klein' ? 70 : 82 })
		.toBuffer();
}
