import Anthropic from '@anthropic-ai/sdk';
import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit/hooks';
import { building, dev, version } from '$app/env';
import { pruneSessions, sessionCookieName, validateSession } from '#lib/server/auth/session.ts';
import { config } from '#lib/server/config.ts';
import { db } from '#lib/server/db/index.ts';
import {
	INGEST_ROUTE,
	SECURITY_HEADERS,
	clientAddress,
	isPublicRoute,
	isSafeMethod,
	unauthorized
} from '#lib/server/guard.ts';
import { budgetCheckSoon, startBudgetNotifications } from '#lib/server/budget-notify.ts';
import { scheduleClosingNotifications } from '#lib/server/closing-notify.ts';
import { startJobs } from '#lib/server/jobs.ts';
import { log } from '#lib/server/log.ts';
import { requestLimiter } from '#lib/server/ratelimit.ts';
import { verifyUploadToken } from '#lib/server/receipts/tokens.ts';
import { registerReceiptReader } from '#lib/server/receipts/worker.ts';
import { scheduleRecurringJobs } from '#lib/server/recurring.ts';
import { startRecurringNotifications } from '#lib/server/recurring-notify.ts';
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
	// Achtergrondtaken: de maandjob van vaste lasten draait bij het starten en op elke eerste
	scheduleRecurringJobs(db());
	// Pushmelding zodra de dag van een verwachte vaste last gekomen is
	startRecurringNotifications(db);
	// Pushmelding als een categorie op 90% komt, kort na een wijziging
	startBudgetNotifications(db);
	// Pushmelding om 9:00 als de afsluiting van de vorige maand klaarstaat
	scheduleClosingNotifications(db());
	// Bonnen lezen met Haiku; zonder API-sleutel blijven ze wachten tot die er is
	const apiKey = config().ANTHROPIC_API_KEY;
	if (apiKey) {
		let client: Anthropic | undefined;
		registerReceiptReader(() => (client ??= new Anthropic({ apiKey })));
	} else log.warn('geen ANTHROPIC_API_KEY: bonnen blijven wachten');
	startJobs(db);
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

	const expectedOrigin = config().ORIGIN ?? event.url.origin;

	// Het deelmenu: alleen een upload-token, nooit een sessie. Een iOS-opdracht stuurt geen
	// Origin; stuurt een browser er wel een, dan moet het de onze zijn.
	if (event.route.id === INGEST_ROUTE) {
		event.locals.session = null;
		const origin = request.headers.get('origin');
		if (origin !== null && origin !== expectedOrigin) return json(403, 'Verzoek geweigerd');
		event.locals.uploadToken = verifyUploadToken(db(), request.headers.get('authorization'));
		if (!event.locals.uploadToken) return unauthorized(request);
		return secure(await resolve(event));
	}

	// Muterende verzoeken alleen vanaf onze eigen origin (aanvulling op de CSRF-controle van SvelteKit)
	if (!isSafeMethod(request.method)) {
		if (request.headers.get('origin') !== expectedOrigin) return json(403, 'Verzoek geweigerd');
	}

	// Een upload-token telt hier niet: alleen de sessiecookie
	const token = event.cookies.get(sessionCookieName());
	event.locals.session = token ? validateSession(db(), token) : null;

	if (!event.locals.session && !isPublicRoute(event.route.id)) {
		return unauthorized(request);
	}

	const response = await resolve(event);
	// Na een geslaagde wijziging: zit een categorie nu op 90%?
	if (!isSafeMethod(request.method) && event.locals.session && response.status < 400) {
		budgetCheckSoon();
	}
	return secure(response);
};

function secure(response: Response): Response {
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
		if (!response.headers.has(name)) response.headers.set(name, value);
	}
	// Persoonlijke gegevens niet in gedeelde caches of de back/forward-cache
	if (!response.headers.has('cache-control')) response.headers.set('cache-control', 'no-store');
	return response;
}

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
