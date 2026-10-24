import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Willekeurig token uit een cryptografische bron, base64url. 32 bytes = 256 bits. */
export function randomToken(bytes = 32): string {
	return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

const BASE32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Herstelcode van 20 tekens (100 bits) in groepjes van vier, zonder verwarrende tekens. */
export function recoveryCode(): string {
	const bytes = randomBytes(20);
	let out = '';
	for (let i = 0; i < 20; i++) {
		out += BASE32[bytes[i]! & 31];
		if (i % 4 === 3 && i < 19) out += '-';
	}
	return out;
}

/** Hoofdletters, zonder spaties en streepjes, zodat typvariaties niet uitmaken. */
export function normalizeRecoveryCode(input: string): string {
	return input.toUpperCase().replace(/[\s-]/g, '');
}
