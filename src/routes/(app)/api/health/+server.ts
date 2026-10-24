import { config } from '#lib/server/config.ts';
import { db } from '#lib/server/db/index.ts';
import { json } from '#lib/server/http.ts';
import { telemetryDb } from '#lib/server/telemetry/index.ts';
import { collectHealth, healthPaths } from '#lib/server/telemetry/health.ts';
import type { RequestHandler } from './$types';

// Uitgebreide health check, alleen na login. Publiek is er alleen /healthz ("ok").
export const GET: RequestHandler = () =>
	json(
		collectHealth({
			db,
			telemetry: telemetryDb(),
			paths: healthPaths(config().DATABASE_PATH)
		})
	);
