import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import type { BrowserContext } from '@playwright/test';

const DB_PATH = '.e2e/budget.db';

function open() {
	const db = new Database(DB_PATH, { fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	return db;
}

/** Sessie rechtstreeks in de testdatabase, zodat tests zonder passkey kunnen inloggen. */
export async function login(context: BrowserContext): Promise<void> {
	const token = randomBytes(32).toString('base64url');
	const db = open();
	db.prepare(
		'INSERT INTO sessions (id_hash, device_name, expires_at, last_used_at) VALUES (?, ?, ?, ?)'
	).run(
		createHash('sha256').update(token).digest('hex'),
		'e2e',
		new Date(Date.now() + 86_400_000).toISOString(),
		new Date().toISOString()
	);
	db.close();
	await context.addCookies([
		{ name: 'session', value: token, url: 'http://localhost:4173', httpOnly: true, sameSite: 'Lax' }
	]);
}

export function setupToken(): string {
	const token = randomBytes(32).toString('base64url');
	const db = open();
	db.prepare('INSERT INTO setup_tokens (token_hash, expires_at) VALUES (?, ?)').run(
		createHash('sha256').update(token).digest('hex'),
		new Date(Date.now() + 15 * 60_000).toISOString()
	);
	db.close();
	return token;
}

export function count(sql: string, ...params: unknown[]): number {
	const db = open();
	const row = db.prepare(sql).get(...params) as { n: number };
	db.close();
	return row.n;
}
