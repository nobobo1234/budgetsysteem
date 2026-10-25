import { error } from '@sveltejs/kit';
import { readJson } from '#lib/server/http.ts';
import { telemetryDb } from '#lib/server/telemetry/index.ts';
import { recordVitals, vitalsBody } from '#lib/server/telemetry/vitals.ts';
import type { RequestHandler } from './$types';

// Web-vitals uit de PWA, alleen na login. Eén ongeldige meting en de hele batch wordt geweigerd.
export const POST: RequestHandler = async ({ request }) => {
	const parsed = vitalsBody.safeParse(await readJson(request, 4096));
	if (!parsed.success) error(400, 'Ongeldige meting');
	recordVitals(telemetryDb(), parsed.data.metrics);
	return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
};
