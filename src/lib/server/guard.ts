// Standaard alles dicht: alleen routes in de map `src/routes/(public)` zijn zonder sessie bereikbaar.
// Een route die niet bestaat (route-ID `null`) is ook dicht, zodat zonder login niet te zien is
// welke routes er zijn.

export const PUBLIC_GROUP = '/(public)';

export function isPublicRoute(routeId: string | null): boolean {
	return routeId !== null && (routeId === PUBLIC_GROUP || routeId.startsWith(`${PUBLIC_GROUP}/`));
}

/**
 * IP-adres van de client, voor rate limiting. In productie zet nginx altijd `X-Real-IP`
 * (ADDRESS_HEADER). Ontbreekt die header, dan komt het verzoek niet via nginx maar van de
 * VPS zelf (de app luistert alleen op 127.0.0.1), zoals de health check. adapter-node gooit
 * dan een fout; die verzoeken delen hier één vaste sleutel.
 */
export function clientAddress(event: { getClientAddress(): string }): string {
	try {
		return event.getClientAddress();
	} catch {
		return 'direct';
	}
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string): boolean {
	return SAFE_METHODS.has(method);
}

/** Antwoord zonder sessie: altijd 401. Een browser die een pagina opent gaat door naar de login. */
export function unauthorized(request: Request): Response {
	const wantsHtml =
		request.method === 'GET' && (request.headers.get('accept') ?? '').includes('text/html');
	const headers = new Headers({
		'cache-control': 'no-store',
		'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
	});
	if (wantsHtml) {
		headers.set('content-type', 'text/html; charset=utf-8');
		return new Response(
			'<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/login"><title>Inloggen</title></head><body><a href="/login">Inloggen</a></body></html>',
			{ status: 401, headers }
		);
	}
	headers.set('content-type', 'application/json');
	return new Response(JSON.stringify({ message: 'Niet ingelogd' }), { status: 401, headers });
}

export const SECURITY_HEADERS: Record<string, string> = {
	'x-content-type-options': 'nosniff',
	// Niet `no-referrer`: dan sturen browsers bij een gewone form-POST `Origin: null` en faalt
	// de CSRF-controle. `same-origin` stuurt naar andere sites evengoed niets mee.
	'referrer-policy': 'same-origin',
	'x-frame-options': 'DENY',
	'cross-origin-opener-policy': 'same-origin',
	'cross-origin-resource-policy': 'same-origin',
	'permissions-policy':
		'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()'
};
