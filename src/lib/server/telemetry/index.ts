import { config } from '../config.ts';
import { db } from '../db/index.ts';
import { log } from '../log.ts';
import { telemetryDb } from './db.ts';
import { describeError, pruneTelemetry, recordError, recordStart } from './errors.ts';
import { databaseOk } from './health.ts';
import { startPinger } from './ping.ts';

const DAY = 86_400_000;
let started = false;

/**
 * Bij het starten van de server: start vastleggen, oude telemetrie opruimen (en daarna
 * dagelijks), crashes vastleggen en de externe ping starten. Een kapotte telemetrie-database
 * mag de app niet tegenhouden.
 */
export function startTelemetry(version: string): void {
	if (started) return;
	started = true;

	try {
		const t = telemetryDb();
		pruneTelemetry(t);
		recordStart(t, version);
		setInterval(() => {
			try {
				pruneTelemetry(telemetryDb());
			} catch (e) {
				log.warn({ err: describeError(e) }, 'telemetrie opruimen mislukt');
			}
		}, DAY).unref();
	} catch (e) {
		log.error({ err: describeError(e) }, 'telemetrie niet beschikbaar');
	}

	// Crash buiten een verzoek. De monitor verandert het gedrag van Node niet: het proces stopt
	// daarna gewoon en Docker start de container opnieuw.
	process.on('uncaughtExceptionMonitor', (error, origin) => {
		const id = crypto.randomUUID();
		recordError(telemetryDb, { id, source: 'proces', error });
		log.fatal({ errorId: id, origin, err: describeError(error) }, 'crash');
	});

	const url = config().HEALTHCHECK_PING_URL;
	if (url) startPinger(url, () => databaseOk(db));
}

export { telemetryDb, useTelemetryDatabase } from './db.ts';
export { describeError, recordError } from './errors.ts';
