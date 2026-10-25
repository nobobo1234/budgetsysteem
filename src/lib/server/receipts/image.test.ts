// TER REVIEW (Noah): handtekening van uploads.
import { describe, expect, it } from 'vitest';
import { declaredMediaType, extensionFor, sniffImage } from './image.ts';

const bytes = (...b: number[]) => new Uint8Array(b);

describe('sniffImage', () => {
	it('herkent JPEG en PNG aan de eerste bytes', () => {
		expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0, 0))).toBe('image/jpeg');
		expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
	});

	it('weigert al het andere, ook een afgekapte handtekening', () => {
		expect(sniffImage(bytes())).toBeNull();
		expect(sniffImage(bytes(0xff, 0xd8))).toBeNull();
		expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a))).toBeNull();
		expect(sniffImage(new TextEncoder().encode('GIF89a'))).toBeNull();
		expect(sniffImage(new TextEncoder().encode('<svg'))).toBeNull();
		expect(sniffImage(new TextEncoder().encode('RIFF....WEBP'))).toBeNull();
	});
});

describe('declaredMediaType', () => {
	it('accepteert alleen image/jpeg en image/png, met parameters en hoofdletters', () => {
		expect(declaredMediaType('image/jpeg')).toBe('image/jpeg');
		expect(declaredMediaType('Image/PNG; charset=binary')).toBe('image/png');
		expect(declaredMediaType('image/jpg')).toBeNull();
		expect(declaredMediaType('image/svg+xml')).toBeNull();
		expect(declaredMediaType('multipart/form-data')).toBeNull();
		expect(declaredMediaType(null)).toBeNull();
	});

	it('kiest de extensie bij het type', () => {
		expect(extensionFor('image/jpeg')).toBe('jpg');
		expect(extensionFor('image/png')).toBe('png');
	});
});
