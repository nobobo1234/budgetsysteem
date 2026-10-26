import { error } from '@sveltejs/kit';
import { toIsoDate } from '#lib/dates.ts';
import { readJson } from '#lib/server/http.ts';
import { telemetryDb } from '#lib/server/telemetry/index.ts';
import { inFuture, recordUsage, usageBody } from '#lib/server/telemetry/usage.ts';
import type { RequestHandler } from './$types';

// Je eigen gebruik uit de PWA (dag, soort invoer, tijd van openen tot opslaan), alleen na
// login. Eén ongeldige meting en de hele batch wordt geweigerd.
export const POST: RequestHandler = async ({ request }) => {
	const parsed = usageBody.safeParse(await readJson(request, 4096));
	if (!parsed.success) error(400, 'Ongeldige meting');
	const today = toIsoDate(new Date());
	if (inFuture(parsed.data.entries, today)) error(400, 'Ongeldige meting');
	recordUsage(telemetryDb(), parsed.data.entries, today);
	return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
};
