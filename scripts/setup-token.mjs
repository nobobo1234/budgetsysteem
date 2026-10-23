// Maakt een eenmalig setup-token voor de eerste passkey (of als laatste redmiddel op de server).
// Alleen uit te voeren op de server zelf, bijvoorbeeld:
//   docker exec -it budget node scripts/setup-token.mjs
// Het token wordt hier één keer getoond en staat in de database alleen als hash.
import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';

const path = process.env.DATABASE_PATH ?? 'data/budget.db';
const MINUTES = 15;

const db = new Database(path, { fileMustExist: true });
db.pragma('busy_timeout = 5000');
const table = db
	.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'setup_tokens'")
	.get();
if (!table) {
	console.error('De database is nog niet gemigreerd. Start de app eerst één keer.');
	process.exit(1);
}

const token = randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(token).digest('hex');
const expires = new Date(Date.now() + MINUTES * 60 * 1000).toISOString();
db.prepare('INSERT INTO setup_tokens (token_hash, expires_at) VALUES (?, ?)').run(hash, expires);
db.close();

console.log(`Setup-token (${MINUTES} minuten geldig, één keer te gebruiken):\n\n  ${token}\n`);
console.log('Open /setup in de app en plak het token daar.');
