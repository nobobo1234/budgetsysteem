import { error, type RequestEvent } from '@sveltejs/kit';
import { securityEvent } from './audit.ts';
import { hasRecentReauth } from './auth/session.ts';
import { db } from './db/index.ts';
import { authLimiter } from './ratelimit.ts';

const MAX_JSON_BYTES = 64 * 1024;

/** Leest een JSON-body met een groottelimiet. Bij twijfel weigeren. */
export async function readJson(request: Request, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
	if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) {
		error(415, 'Verwacht JSON');
	}
	const length = Number(request.headers.get('content-length') ?? '0');
	if (length > maxBytes) error(413, 'Te groot');
	const text = await request.text();
	if (text.length > maxBytes) error(413, 'Te groot');
	try {
		return JSON.parse(text) as unknown;
	} catch {
		error(400, 'Ongeldige JSON');
	}
}

export function json(data: unknown, status = 200): Response {
	return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}

/** Rate limit voor inloggen, herstelcode en setup, per IP. */
export function limitAuth(event: RequestEvent): void {
	if (!authLimiter.hit(event.getClientAddress())) {
		securityEvent(db(), 'rate_limit');
		error(429, 'Te veel pogingen. Probeer het over een kwartier opnieuw.');
	}
}

export function requireSession(event: RequestEvent) {
	const session = event.locals.session;
	if (!session) error(401, 'Niet ingelogd');
	return session;
}

/** Gevoelige acties vragen altijd opnieuw om je passkey. */
export function requireReauth(event: RequestEvent) {
	const session = requireSession(event);
	if (!hasRecentReauth(session)) error(403, 'Bevestig eerst met je passkey');
	return session;
}
