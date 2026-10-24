import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.ts';
import * as schema from './schema.ts';

export type TelemetryDB = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export function telemetryPath(): string {
	const c = config();
	return c.TELEMETRY_DATABASE_PATH ?? join(dirname(c.DATABASE_PATH), 'telemetry.db');
}

export function openTelemetryDatabase(
	path: string,
	migrationsFolder = join(config().MIGRATIONS_DIR, 'telemetry')
): TelemetryDB {
	if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
	const sqlite = new Database(path);
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('busy_timeout = 5000');
	sqlite.pragma('synchronous = NORMAL');
	const db = drizzle(sqlite, { schema }) as TelemetryDB;
	migrate(db, { migrationsFolder });
	return db;
}

let instance: TelemetryDB | undefined;

export function telemetryDb(): TelemetryDB {
	instance ??= openTelemetryDatabase(telemetryPath());
	return instance;
}

/** Alleen voor tests: gebruik een eigen (tijdelijke) telemetrie-database. */
export function useTelemetryDatabase(next: TelemetryDB | undefined): void {
	instance = next;
}
