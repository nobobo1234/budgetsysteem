// TER REVIEW (Noah): de echte server geeft zonder sessie 401 op afgeschermde routes.
import { expect, test } from '@playwright/test';

const closed = [
	['GET', '/'],
	['GET', '/transacties'],
	['GET', '/transacties/0b7f3c52-6a2e-4c8e-9a43-1f2d3e4c5b6a'],
	['GET', '/budget'],
	['GET', '/vaste-lasten'],
	['GET', '/vaste-lasten/0b7f3c52-6a2e-4c8e-9a43-1f2d3e4c5b6a'],
	['GET', '/import'],
	['GET', '/categorieen'],
	['GET', '/regels'],
	['GET', '/instellingen'],
	['GET', '/tags'],
	['POST', '/tags?/create'],
	['GET', '/tags/0b7f3c52-6a2e-4c8e-9a43-1f2d3e4c5b6a'],
	['POST', '/tags/0b7f3c52-6a2e-4c8e-9a43-1f2d3e4c5b6a?/toggle'],
	['POST', '/transacties/0b7f3c52-6a2e-4c8e-9a43-1f2d3e4c5b6a?/tag'],
	['GET', '/te-krijgen'],
	['GET', '/personen'],
	['GET', '/terugbetalingen'],
	['GET', '/te-controleren'],
	['POST', '/te-controleren?/leave'],
	['POST', '/te-controleren?/confirmReceipt'],
	['GET', '/bonnen'],
	['GET', '/bonnen/0b7f3c52-6a2e-4c8e-9a43-1f2d3e4c5b6a'],
	['POST', '/bonnen/0b7f3c52-6a2e-4c8e-9a43-1f2d3e4c5b6a?/settle'],
	['POST', '/bonnen/0b7f3c52-6a2e-4c8e-9a43-1f2d3e4c5b6a?/delete'],
	['POST', '/bonnen/0b7f3c52-6a2e-4c8e-9a43-1f2d3e4c5b6a?/group'],
	['GET', '/analyses/boodschappen'],
	['GET', '/api/receipts/0b7f3c52-6a2e-4c8e-9a43-1f2d3e4c5b6a/image'],
	['POST', '/terugbetalingen?/received'],
	['POST', '/vaste-lasten/0b7f3c52-6a2e-4c8e-9a43-1f2d3e4c5b6a?/addShare'],
	['POST', '/te-krijgen?/add'],
	['POST', '/personen?/addIban'],
	['GET', '/instellingen/status'],
	['GET', '/saldocheck'],
	['GET', '/instellingen/meldingen'],
	['GET', '/instellingen/beveiliging'],
	['POST', '/instellingen/beveiliging?/recoveryCode'],
	['GET', '/instellingen/apparaten'],
	['POST', '/instellingen/apparaten?/create'],
	['POST', '/instellingen/apparaten?/revoke'],
	['POST', '/api/receipts'],
	['POST', '/api/ingest'],
	['GET', '/instellingen/rekeningen'],
	['POST', '/instellingen/rekeningen?/account'],
	['GET', '/__data.json'],
	['GET', '/bestaat-niet'],
	['POST', '/api/transactions'],
	['POST', '/transacties?/confirm'],
	['POST', '/transacties?/category'],
	['POST', '/api/vitals'],
	['POST', '/?/confirmExpected'],
	['POST', '/vaste-lasten?/confirm'],
	['POST', '/api/auth/passkeys/options'],
	['POST', '/instellingen?/logout'],
	['POST', '/saldocheck?/check'],
	['POST', '/instellingen/meldingen?/toggle'],
	['POST', '/api/push/subscription'],
	['DELETE', '/api/push/subscription']
] as const;

for (const [method, path] of closed) {
	test(`${method} ${path} zonder sessie geeft 401`, async ({ request, baseURL }) => {
		const response = await request.fetch(path, {
			method,
			headers: { origin: baseURL!, 'content-type': 'application/json' },
			data: method === 'GET' ? undefined : {},
			maxRedirects: 0
		});
		expect(response.status()).toBe(401);
	});
}

test('publiek: login en healthz, met security headers', async ({ request }) => {
	expect(await (await request.get('/healthz')).text()).toBe('ok');
	const login = await request.get('/login');
	expect(login.status()).toBe(200);
	const csp = login.headers()['content-security-policy'] ?? '';
	expect(csp).toContain("frame-ancestors 'none'");
	expect(csp).toMatch(/script-src 'self' 'nonce-/);
	expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
	expect(login.headers()['x-content-type-options']).toBe('nosniff');
	expect(login.headers()['referrer-policy']).toBe('same-origin');
});

test('POST vanaf een andere origin wordt geweigerd', async ({ request }) => {
	const response = await request.post('/api/auth/login/options', {
		headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
		data: {}
	});
	expect(response.status()).toBe(403);
});
