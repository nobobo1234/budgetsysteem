// Lighthouse CI als performance-budget (spec: Tests en CI, Pipeline): de loginpagina zonder
// sessie en het startscherm met een testsessie, tegen de gebouwde app (`pnpm build` eerst).
// Assertions staan in lighthouserc.json.
//
// De app draait achter een kleine proxy die gzip doet zoals nginx in productie
// (deploy/nginx/finance.conf), zodat Lighthouse de echte overdrachtsgrootte meet.
// Elke run een verse database in .lhci/; rapporten komen in .lighthouseci/ (nooit publiek
// geüpload).
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createGzip } from 'node:zlib';

// Eigen poorten, los van de e2e-server (4173), zodat ze naast elkaar kunnen draaien
const PORT = 4183;
const APP_PORT = 4184;
const ORIGIN = `http://localhost:${PORT}`;
const DATA = '.lhci';
const DB_PATH = `${DATA}/budget.db`;
// Zoals gzip_types in nginx (text/html staat daar altijd aan)
const COMPRESSIBLE =
	/^(text\/(html|css|javascript)|application\/(javascript|json|manifest\+json)|image\/svg\+xml)/;

rmSync(DATA, { recursive: true, force: true });
rmSync('.lighthouseci', { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

const app = spawn(process.execPath, ['build'], {
	stdio: 'inherit',
	env: {
		...process.env,
		PORT: String(APP_PORT),
		HOST: '127.0.0.1',
		ORIGIN,
		COOKIE_SECURE: 'false',
		DATABASE_PATH: DB_PATH,
		LOG_LEVEL: 'warn',
		TZ: 'Europe/Amsterdam'
	}
});
app.on('exit', (status) => {
	if (status !== null) {
		console.error(`app gestopt met code ${status}`);
		stop(1);
	}
});

const proxy = createServer((req, res) => {
	const upstream = request(
		{ host: '127.0.0.1', port: APP_PORT, method: req.method, path: req.url, headers: req.headers },
		(up) => {
			const gzip =
				COMPRESSIBLE.test(up.headers['content-type'] ?? '') &&
				!up.headers['content-encoding'] &&
				/\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
			const headers = { ...up.headers };
			if (gzip) {
				delete headers['content-length'];
				headers['content-encoding'] = 'gzip';
				headers.vary = 'Accept-Encoding';
			}
			res.writeHead(up.statusCode ?? 502, headers);
			// Niveau 1, zoals de standaard gzip_comp_level van nginx
			(gzip ? up.pipe(createGzip({ level: 1 })) : up).pipe(res);
		}
	);
	upstream.on('error', () => res.writeHead(502).end());
	req.pipe(upstream);
});

function stop(code) {
	proxy.close();
	app.removeAllListeners('exit');
	app.kill();
	process.exit(code);
}

// Nooit eindeloos blijven hangen
setTimeout(() => {
	console.error('Lighthouse duurde langer dan 10 minuten');
	stop(1);
}, 10 * 60_000).unref();

async function waitForApp() {
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`${ORIGIN}/healthz`)).ok) return;
		} catch {
			// nog niet gestart
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error('app niet gestart');
}

/** Testsessie rechtstreeks in de database, zoals in de e2e-tests. */
function testSession() {
	const token = randomBytes(32).toString('base64url');
	const db = new Database(DB_PATH, { fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	db.prepare(
		'INSERT INTO sessions (id_hash, device_name, expires_at, last_used_at) VALUES (?, ?, ?, ?)'
	).run(
		createHash('sha256').update(token).digest('hex'),
		'lighthouse',
		new Date(Date.now() + 3_600_000).toISOString(),
		new Date().toISOString()
	);
	db.close();
	return token;
}

/** lhci als apart proces; asynchroon, want de proxy in dit proces moet blijven antwoorden. */
function lhci(...args) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['node_modules/@lhci/cli/src/cli.js', ...args], {
			stdio: 'inherit',
			timeout: 5 * 60_000
		});
		child.on('error', reject);
		child.on('exit', (status) =>
			status === 0 ? resolve() : reject(new Error(`lhci ${args[0]} faalde (${status})`))
		);
	});
}

let code = 0;
try {
	await new Promise((resolve, reject) => {
		proxy.once('error', reject);
		proxy.listen(PORT, '127.0.0.1', resolve);
	});
	await waitForApp();
	await lhci('collect', `--url=${ORIGIN}/login`);
	const cookie = JSON.stringify({ Cookie: `session=${testSession()}` });
	await lhci('collect', '--additive', `--url=${ORIGIN}/`, `--settings.extraHeaders=${cookie}`);
	await lhci('upload');
	await lhci('assert');
} catch (e) {
	console.error(e instanceof Error ? e.message : e);
	code = 1;
}
stop(code);
