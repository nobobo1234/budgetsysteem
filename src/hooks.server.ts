import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit/hooks';
import { building, dev, version } from '$app/env';
import { pruneSessions, sessionCookieName, validateSession } from '#lib/server/auth/session.ts';
import { config } from '#lib/server/config.ts';
import { db } from '#lib/server/db/index.ts';
import {
	SECURITY_HEADERS,
	clientAddress,
	isPublicRoute,
	isSafeMethod,
	unauthorized
} from '#lib/server/guard.ts';
import { log } from '#lib/server/log.ts';
import { requestLimiter } from '#lib/server/ratelimit.ts';
import {
	alertSoon,
	describeError,
	recordError,
	startTelemetry,
	telemetryDb
} from '#lib/server/telemetry/index.ts';

export const init: ServerInit = () => {
	if (building) return;
	// Database openen en migraties draaien bij het starten, niet bij het eerste verzoek
	pruneSessions(db());
	startTelemetry(version);
	log.info('gestart');
};

function json(status: number, message: string): Response {
	return new Response(JSON.stringify({ message }), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
}

export const handle: Handle = async ({ event, resolve }) => {
	const { request } = event;

	if (!requestLimiter.hit(clientAddress(event))) {
		return json(429, 'Te veel verzoeken');
	}

	// Muterende verzoeken alleen vanaf onze eigen origin (aanvulling op de CSRF-controle van SvelteKit)
	if (!isSafeMethod(request.method)) {
		const expected = config().ORIGIN ?? event.url.origin;
		if (request.headers.get('origin') !== expected) return json(403, 'Verzoek geweigerd');
	}

	const token = event.cookies.get(sessionCookieName());
	event.locals.session = token ? validateSession(db(), token) : null;

	if (!event.locals.session && !isPublicRoute(event.route.id)) {
		return unauthorized(request);
	}

	const response = await resolve(event);

	for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
		if (!response.headers.has(name)) response.headers.set(name, value);
	}
	// Persoonlijke gegevens niet in gedeelde caches of de back/forward-cache
	if (!response.headers.has('cache-control')) response.headers.set('cache-control', 'no-store');
	return response;
};

export const handleError: HandleServerError = ({ kind, error, event }) => {
	if (kind === 'app') return error;
	if (kind === 'framework' || kind === 'validation') return error;

	const errorId = crypto.randomUUID();
	// Soort fout, route en de stackframes zonder de foutmelding zelf (die kan data bevatten).
	// Nooit naar de client: die krijgt alleen een errorId.
	const info = describeError(error);
	log.error(
		{
			errorId,
			route: event.route.id,
			method: event.request.method,
			err: {
				name: info.name,
				message: dev && error instanceof Error ? error.message : undefined,
				frames: info.frames.join('\n')
			}
		},
		'onverwachte fout'
	);
	recordError(telemetryDb, {
		id: errorId,
		source: 'verzoek',
		error,
		route: event.route.id,
		method: event.request.method
	});
	// Nieuw soort fout: pushmelding binnen enkele seconden
	alertSoon();
	return { status: 500, message: 'Er ging iets mis.', errorId };
};
