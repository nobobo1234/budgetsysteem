// Lighthouse als performance-budget (spec: Tests en CI, Pipeline): de loginpagina zonder
// sessie en het startscherm met een testsessie, tegen de gebouwde app (`pnpm build` eerst).
// Per pagina drie runs; het budget hieronder geldt voor de mediaan, zoals eerder met lhci.
//
// De app draait achter een kleine proxy die gzip doet zoals nginx in productie
// (deploy/nginx/finance.conf), zodat Lighthouse de echte overdrachtsgrootte meet.
// Elke run een verse database in .lhci/; rapporten komen in .lighthouseci/ (nooit publiek
// geüpload).
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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
// Zoals gzip_comp_level in nginx
const GZIP_LEVEL = 5;
const REPORTS = '.lighthouseci/rapporten';
const RUNS = 3;

/**
 * Het budget, over de mediaan van de runs. `error` laat de check falen, `warn` meldt alleen.
 * Eerste JS-bundel < 100 kB gzip (CLAUDE.md: Performance).
 */
const BUDGET = [
	{ name: 'JS (overdracht)', level: 'error', max: 102_400, value: (lhr) => scriptSize(lhr) },
	{ name: 'Total Blocking Time', level: 'error', max: 200, value: numeric('total-blocking-time') },
	{
		name: 'Largest Contentful Paint',
		level: 'warn',
		max: 2500,
		value: numeric('largest-contentful-paint')
	},
	{
		name: 'Cumulative Layout Shift',
		level: 'error',
		max: 0.1,
		value: numeric('cumulative-layout-shift')
	},
	{
		name: 'Performance-score',
		level: 'warn',
		min: 0.9,
		value: (lhr) => lhr.categories.performance?.score
	}
];

function numeric(id) {
	return (lhr) => lhr.audits[id]?.numericValue;
}

function scriptSize(lhr) {
	const items = lhr.audits['resource-summary']?.details?.items ?? [];
	return items.find((item) => item.resourceType === 'script')?.transferSize;
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor((sorted.length - 1) / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid] + sorted[mid + 1]) / 2;
}

rmSync(DATA, { recursive: true, force: true });
rmSync('.lighthouseci', { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
mkdirSync(REPORTS, { recursive: true });

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
			(gzip ? up.pipe(createGzip({ level: GZIP_LEVEL })) : up).pipe(res);
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

/**
 * Eén Lighthouse-run als apart proces; asynchroon, want de proxy in dit proces moet blijven
 * antwoorden. Schrijft een JSON- en HTML-rapport en geeft het JSON-rapport terug.
 */
function lighthouse(url, name, extraArgs = []) {
	const output = `${REPORTS}/${name}`;
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				'node_modules/lighthouse/cli/index.js',
				url,
				'--only-categories=performance',
				'--chrome-flags=--headless=new',
				'--output=json',
				'--output=html',
				`--output-path=${output}`,
				'--quiet',
				// Nooit Sentry laden of iets naar Google sturen, ook niet lokaal na een eerdere keuze
				'--no-enable-error-reporting',
				...extraArgs
			],
			{ stdio: 'inherit', timeout: 5 * 60_000 }
		);
		child.on('error', reject);
		child.on('exit', (status) =>
			status === 0
				? resolve(JSON.parse(readFileSync(`${output}.report.json`, 'utf8')))
				: reject(new Error(`lighthouse ${name} faalde (${status})`))
		);
	});
}

/** Regels voor de job-samenvatting in GitHub Actions, gevuld door assertBudget. */
const summary = [];

/** Toetst de mediaan van de runs aan het budget; geeft het aantal overschrijdingen met `error`. */
function assertBudget(page, lhrs) {
	let errors = 0;
	for (const check of BUDGET) {
		const values = lhrs.map(check.value).filter((v) => typeof v === 'number');
		if (values.length === 0) {
			console.error(`✗ ${page}: ${check.name} ontbreekt in het rapport`);
			summary.push(`| ${page} | ${check.name} | – | | ✗ |`);
			errors++;
			continue;
		}
		const value = median(values);
		const ok = check.max !== undefined ? value <= check.max : value >= check.min;
		const limit = check.max !== undefined ? `max ${check.max}` : `min ${check.min}`;
		const rounded = Math.round(value * 1000) / 1000;
		const line = `${page}: ${check.name} ${rounded} (${limit})`;
		const mark = ok ? '✓' : check.level === 'warn' ? '⚠' : '✗';
		summary.push(`| ${page} | ${check.name} | ${rounded} | ${limit} | ${mark} |`);
		if (ok) console.log(`✓ ${line}`);
		else if (check.level === 'warn') console.warn(`⚠ ${line}`);
		else {
			console.error(`✗ ${line}`);
			errors++;
		}
	}
	return errors;
}

function writeSummary() {
	if (!process.env.GITHUB_STEP_SUMMARY || summary.length === 0) return;
	const table = [
		`### Lighthouse (mediaan van ${RUNS} runs)`,
		'',
		'| pagina | meting | waarde | budget | |',
		'| --- | --- | --: | --- | --- |',
		...summary,
		''
	].join('\n');
	appendFileSync(process.env.GITHUB_STEP_SUMMARY, table + '\n');
}

let code = 0;
try {
	await new Promise((resolve, reject) => {
		proxy.once('error', reject);
		proxy.listen(PORT, '127.0.0.1', resolve);
	});
	await waitForApp();
	const cookie = JSON.stringify({ Cookie: `session=${testSession()}` });
	const pages = [
		{ page: 'login', url: `${ORIGIN}/login`, args: [] },
		{ page: 'start', url: `${ORIGIN}/`, args: [`--extra-headers=${cookie}`] }
	];
	let errors = 0;
	for (const { page, url, args } of pages) {
		const lhrs = [];
		for (let run = 1; run <= RUNS; run++) {
			lhrs.push(await lighthouse(url, `${page}-${run}`, args));
		}
		errors += assertBudget(page, lhrs);
	}
	if (errors > 0) throw new Error(`${errors} overschrijding(en) van het performance-budget`);
} catch (e) {
	console.error(e instanceof Error ? e.message : e);
	code = 1;
}
writeSummary();
stop(code);
