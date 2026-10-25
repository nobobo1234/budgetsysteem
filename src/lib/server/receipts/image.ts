// Bestandshandtekening van een upload (spec: Toetsing aan best practices → Uploads). Alleen
// JPEG en PNG; het Content-Type van de client moet kloppen met de eerste bytes.

export const MEDIA_TYPES = ['image/jpeg', 'image/png'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/** 10 MB per bestand. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (bytes: Uint8Array, signature: number[]) =>
	bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);

/** Het type volgens de eerste bytes, of `null` als het geen JPEG of PNG is. */
export function sniffImage(bytes: Uint8Array): MediaType | null {
	if (startsWith(bytes, JPEG)) return 'image/jpeg';
	if (startsWith(bytes, PNG)) return 'image/png';
	return null;
}

/** Het Content-Type zonder parameters, als het JPEG of PNG is. */
export function declaredMediaType(header: string | null): MediaType | null {
	const type = (header ?? '').split(';')[0]!.trim().toLowerCase();
	return (MEDIA_TYPES as readonly string[]).includes(type) ? (type as MediaType) : null;
}

export function extensionFor(mediaType: MediaType): 'jpg' | 'png' {
	return mediaType === 'image/png' ? 'png' : 'jpg';
}
