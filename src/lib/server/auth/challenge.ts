import type { Cookies } from '@sveltejs/kit';
import { config } from '../config.ts';
import { randomToken } from './crypto.ts';

// Eenmalige WebAuthn-challenges, alleen in het geheugen van dit proces (één container,
// één gebruiker). Gekoppeld aan een cookie, vijf minuten geldig, na gebruik weg.

export type ChallengePurpose = 'login' | 'setup' | 'register' | 'reauth';

interface Entry {
	challenge: string;
	purpose: ChallengePurpose;
	expires: number;
	/** Extra binding, zoals de hash van het setup-token */
	binding?: string;
}

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 500;
const store = new Map<string, Entry>();

function cookieName(): string {
	return config().COOKIE_SECURE ? '__Host-challenge' : 'challenge';
}

function prune(now: number): void {
	for (const [key, entry] of store) if (entry.expires < now) store.delete(key);
	// Begrensd, zodat niemand het geheugen kan vullen; de oudste gaan eerst
	while (store.size >= MAX_ENTRIES) {
		const oldest = store.keys().next().value;
		if (oldest === undefined) break;
		store.delete(oldest);
	}
}

export function storeChallenge(
	cookies: Cookies,
	challenge: string,
	purpose: ChallengePurpose,
	binding?: string
): void {
	const now = Date.now();
	prune(now);
	const id = randomToken(24);
	store.set(id, { challenge, purpose, expires: now + TTL_MS, binding });
	cookies.set(cookieName(), id, {
		path: '/',
		httpOnly: true,
		secure: config().COOKIE_SECURE,
		sameSite: 'strict',
		maxAge: TTL_MS / 1000
	});
}

/** Haalt de challenge op en verwijdert hem meteen: elke challenge werkt maar één keer. */
export function consumeChallenge(
	cookies: Cookies,
	purpose: ChallengePurpose
): { challenge: string; binding?: string } | null {
	const id = cookies.get(cookieName());
	cookies.delete(cookieName(), { path: '/', secure: config().COOKIE_SECURE });
	if (!id) return null;
	const entry = store.get(id);
	store.delete(id);
	if (!entry || entry.purpose !== purpose || entry.expires < Date.now()) return null;
	return { challenge: entry.challenge, binding: entry.binding };
}
