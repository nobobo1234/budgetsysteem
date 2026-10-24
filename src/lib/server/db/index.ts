import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.ts';
import * as schema from './schema.ts';
import { seed } from './seed.ts';

export type DB = BetterSQLite3Database<typeof schema> & { $client: Database.Database };
/** Een open database-transactie. */
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
/** Database of transactie: voor functies die binnen en buiten een transactie werken. */
export type Conn = DB | Tx;

export function openDatabase(path: string, migrationsFolder = config().MIGRATIONS_DIR): DB {
	if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
	const sqlite = new Database(path);
	// Vastgelegd bij het openen (spec: SQLite en backups, Litestream-tips)
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('busy_timeout = 5000');
	sqlite.pragma('synchronous = NORMAL');
	sqlite.pragma('foreign_keys = ON');
	const db = drizzle(sqlite, { schema }) as DB;
	migrate(db, { migrationsFolder });
	seed(db);
	return db;
}

let instance: DB | undefined;

export function db(): DB {
	instance ??= openDatabase(config().DATABASE_PATH);
	return instance;
}

/** Alleen voor tests: gebruik een eigen (tijdelijke) database. */
export function useDatabase(next: DB | undefined): void {
	instance = next;
}

export { schema };
