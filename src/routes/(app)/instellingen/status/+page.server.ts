import { config } from '#lib/server/config.ts';
import { db } from '#lib/server/db/index.ts';
import { telemetryDb } from '#lib/server/telemetry/index.ts';
import { collectHealth, healthPaths } from '#lib/server/telemetry/health.ts';
import { attention } from '#lib/server/telemetry/status.ts';
import { aiBudget, aiCallSummary } from '#lib/server/telemetry/ai.ts';
import { receiptReadSummary } from '#lib/server/telemetry/receipts.ts';
import { recentVitals } from '#lib/server/telemetry/vitals.ts';
import type { PageServerLoad } from './$types';

// Statuspagina achter de login: de uitgebreide health check, web-vitals p75 per week, hoe
// Haiku de bonnen leest, de samenvattingen schrijft en vragen vertaalt, en de AI-kosten
// tegenover het maandbudget. Alleen cijfers en tijden, geen persoonsgegevens.
export const load: PageServerLoad = () => {
	const telemetry = telemetryDb();
	const health = collectHealth({ db, telemetry, paths: healthPaths(config().DATABASE_PATH) });
	return {
		checkedAt: new Date().toISOString(),
		health,
		attention: attention(health),
		vitals: recentVitals(telemetry),
		receipts: receiptReadSummary(telemetry),
		summaries: aiCallSummary(telemetry, 'samenvatting'),
		questions: aiCallSummary(telemetry, 'vraag'),
		aiBudget: aiBudget(telemetry)
	};
};
