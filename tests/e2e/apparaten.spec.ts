// TER REVIEW (Noah): upload-token aanmaken, één keer tonen, alleen als hash bewaren, alleen
// POST /api/ingest bereiken en met één tik intrekken.
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { count, login } from './helpers.ts';

function open() {
	const db = new Database('.e2e/budget.db', { fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	return db;
}

let revokedPasskeys: string[] = [];

test.beforeEach(async ({ context }) => {
	await login(context);
	const db = open();
	// Net bevestigd, zodat aanmaken geen echte passkey vraagt (die test staat in auth.spec)
	db.prepare("UPDATE sessions SET reauth_at = ? WHERE device_name = 'e2e'").run(
		new Date().toISOString()
	);
	revokedPasskeys = (
		db.prepare('SELECT id FROM passkeys WHERE revoked_at IS NULL').all() as { id: string }[]
	).map((p) => p.id);
	db.prepare('UPDATE passkeys SET revoked_at = ? WHERE revoked_at IS NULL').run(
		new Date().toISOString()
	);
	db.prepare('UPDATE upload_tokens SET revoked_at = ? WHERE revoked_at IS NULL').run(
		new Date().toISOString()
	);
	db.close();
});

test.afterEach(() => {
	const db = open();
	const restore = db.prepare('UPDATE passkeys SET revoked_at = NULL WHERE id = ?');
	for (const id of revokedPasskeys) restore.run(id);
	db.close();
});

test('upload-token aanmaken, gebruiken en intrekken', async ({ page, request, baseURL }) => {
	await page.goto('/instellingen/apparaten');
	await expect(page.getByRole('heading', { level: 1, name: 'Apparaten' })).toBeVisible();
	await expect(page.getByText(/Nog geen telefoon die bonnetjes stuurt/)).toBeVisible();

	await page.getByRole('button', { name: 'Upload-token aanmaken' }).click();
	const sheet = page.getByRole('dialog', { name: 'Upload-token aanmaken' });
	await sheet.getByLabel('Apparaat').fill('iPhone e2e');
	await sheet.getByRole('button', { name: 'Aanmaken' }).click();

	const shown = page.getByRole('textbox', { name: 'Upload-token', exact: true });
	await expect(shown).toHaveValue(/^bon_[A-Za-z0-9_-]{43}$/);
	const token = await shown.inputValue();

	// De meegeleverde opdracht stuurt naar budget.example.nl; deze app draait op localhost,
	// dus geen download maar een melding (de download zelf staat in tests/integration/opdracht)
	await expect(page.getByRole('heading', { name: 'Opdracht voor een ander domein' })).toBeVisible();
	const install = page.getByRole('group', { name: 'Opdracht voor het deelmenu' });
	await expect(install.getByText(/nooit met het token erin/)).toBeVisible();
	await expect(install.getByText(/niet te downloaden/)).toBeVisible();
	await expect(install.getByRole('link', { name: 'Opdracht downloaden' })).toHaveCount(0);
	expect((await page.request.get('/instellingen/apparaten/opdracht')).status()).toBe(409);

	// Alleen de hash staat in de database
	const hash = createHash('sha256').update(token).digest('hex');
	expect(count('SELECT count(*) AS n FROM upload_tokens WHERE token_hash = ?', hash)).toBe(1);
	expect(
		count(
			'SELECT count(*) AS n FROM upload_tokens WHERE token_hash = ? OR name = ? OR id = ?',
			token,
			token,
			token
		)
	).toBe(0);

	// Uploaden zoals de iOS-opdracht: ruwe body, geen Origin, geen cookie
	const jpeg = await sharp({ create: { width: 30, height: 40, channels: 3, background: '#fff' } })
		.jpeg()
		.toBuffer();
	const auth = { authorization: `Bearer ${token}` };
	const before = count("SELECT count(*) AS n FROM receipts WHERE source = 'deelmenu'");
	const upload = await request.post('/api/ingest', {
		headers: { ...auth, 'content-type': 'image/jpeg' },
		data: jpeg
	});
	expect(upload.status()).toBe(202);
	const body = (await upload.json()) as { status: string; id: string };
	expect(Object.keys(body).sort()).toEqual(['id', 'status']);
	expect(body.status).toBe('ontvangen');
	expect(count("SELECT count(*) AS n FROM receipts WHERE source = 'deelmenu'")).toBe(before + 1);
	expect(
		count(
			"SELECT count(*) AS n FROM jobs WHERE kind = 'bon_lezen' AND json_extract(payload, '$.receiptId') = ?",
			body.id
		)
	).toBe(1);
	// De taak wordt meteen opgepakt: de (nagebootste) Haiku leest hem en de bon is niet meer aan
	// het lezen
	await expect
		.poll(() =>
			count(
				"SELECT count(*) AS n FROM receipts WHERE id = ? AND status != 'wordt_gelezen'",
				body.id
			)
		)
		.toBe(1);

	// Een verkeerd bestand komt er niet in
	const fake = await request.post('/api/ingest', {
		headers: { ...auth, 'content-type': 'image/jpeg' },
		data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
	});
	expect(fake.status()).toBe(415);

	// Het token bereikt niets anders
	for (const [method, path] of [
		['GET', '/'],
		['GET', '/transacties'],
		['GET', '/instellingen/apparaten'],
		['POST', '/api/receipts'],
		['POST', '/api/transactions']
	] as const) {
		const response = await request.fetch(path, {
			method,
			headers: { ...auth, origin: baseURL!, 'content-type': 'application/json' },
			data: method === 'GET' ? undefined : {},
			maxRedirects: 0
		});
		expect(response.status(), `${method} ${path}`).toBe(401);
	}

	// Na herladen is het token zelf weg; wel zie je dat het gebruikt is
	await page.reload();
	await expect(page.getByRole('textbox', { name: 'Upload-token', exact: true })).toHaveCount(0);
	const list = page.getByRole('list', { name: 'Upload-tokens' });
	await expect(list.getByText('iPhone e2e')).toBeVisible();
	await expect(list.getByText(/Laatst gebruikt/)).toBeVisible();

	// Intrekken met één tik
	await list.getByRole('button', { name: 'Token van iPhone e2e intrekken' }).click();
	await expect(page.getByText('Token ingetrokken')).toBeVisible();
	await expect(page.getByText(/Nog geen telefoon die bonnetjes stuurt/)).toBeVisible();
	const after = await request.post('/api/ingest', {
		headers: { ...auth, 'content-type': 'image/jpeg' },
		data: jpeg
	});
	expect(after.status()).toBe(401);
});

test('aanmaken zonder passkey-bevestiging wordt geweigerd', async ({ page }) => {
	const db = open();
	db.prepare("UPDATE sessions SET reauth_at = NULL WHERE device_name = 'e2e'").run();
	db.close();
	await page.goto('/instellingen/apparaten');
	await page.getByRole('button', { name: 'Upload-token aanmaken' }).click();
	const sheet = page.getByRole('dialog', { name: 'Upload-token aanmaken' });
	await sheet.getByLabel('Apparaat').fill('Zonder bevestiging');
	await sheet.getByRole('button', { name: 'Aanmaken' }).click();
	await expect(page.getByText(/Voeg eerst een passkey toe/)).toBeVisible();
	expect(count("SELECT count(*) AS n FROM upload_tokens WHERE name = 'Zonder bevestiging'")).toBe(
		0
	);
});

test('Meer heeft een tegel Apparaten', async ({ page }) => {
	await page.goto('/instellingen');
	const tile = page.getByRole('link', { name: /Apparaten/ });
	await expect(tile).toContainText('Deelmenu nog niet ingesteld');
	await tile.click();
	await expect(page).toHaveURL(/\/instellingen\/apparaten$/);
});
