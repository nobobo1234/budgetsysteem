// Een bon uploaden vanuit de app (spec: Bonnetjes en koppelen, Verwerking stap 1): de browser
// schaalt de foto of het screenshot naar hooguit 2576 px aan de lange kant, comprimeert één keer
// als JPEG met kwaliteit 0,9 en haalt EXIF eraf. Dat laatste gebeurt vanzelf: een canvas schrijft
// geen metadata weg. De oriëntatie uit EXIF passen browsers al toe bij het tekenen.

export const MAX_EDGE = 2576;
export const JPEG_QUALITY = 0.9;

/** Formaat binnen `max` aan de lange kant, met dezelfde verhouding; nooit vergroten. */
export function scaledSize(
	width: number,
	height: number,
	max = MAX_EDGE
): { width: number; height: number } {
	if (!(width > 0 && height > 0)) throw new RangeError('ongeldig beeldformaat');
	const factor = Math.min(1, max / Math.max(width, height));
	return {
		width: Math.max(1, Math.round(width * factor)),
		height: Math.max(1, Math.round(height * factor))
	};
}

export class UploadError extends Error {}

async function decode(file: Blob): Promise<HTMLImageElement> {
	const url = URL.createObjectURL(file);
	const img = new Image();
	img.decoding = 'async';
	img.src = url;
	try {
		await img.decode();
		return img;
	} catch {
		throw new UploadError('Deze afbeelding kan ik niet openen. Kies een foto of screenshot.');
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** Verkleint en comprimeert één keer; het resultaat is altijd een JPEG zonder metadata. */
export async function prepareUpload(file: Blob): Promise<Blob> {
	const img = await decode(file);
	const { width, height } = scaledSize(img.naturalWidth, img.naturalHeight);
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new UploadError('Je browser kan de afbeelding niet verkleinen.');
	// Een screenshot met doorzichtige delen krijgt een witte achtergrond, zoals papier
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, width, height);
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(img, 0, 0, width, height);
	const blob = await new Promise<Blob | null>((resolve) =>
		canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY)
	);
	if (!blob) throw new UploadError('Je browser kan de afbeelding niet verkleinen.');
	return blob;
}

/** Stuurt de bon met je sessie naar de server; geeft het ID van de nieuwe bon. */
export async function uploadReceipt(file: Blob): Promise<string> {
	const body = await prepareUpload(file);
	let response: Response;
	try {
		response = await fetch('/api/receipts', {
			method: 'POST',
			headers: { 'content-type': 'image/jpeg' },
			body
		});
	} catch {
		throw new UploadError('Geen verbinding. Probeer het opnieuw zodra je online bent.');
	}
	const data = (await response.json().catch(() => null)) as {
		id?: unknown;
		message?: unknown;
	} | null;
	if (!response.ok || typeof data?.id !== 'string') {
		throw new UploadError(
			typeof data?.message === 'string' ? data.message : 'Uploaden lukte niet. Probeer het opnieuw.'
		);
	}
	return data.id;
}
