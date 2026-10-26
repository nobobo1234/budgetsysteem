import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { count, login, value } from './helpers.ts';

// Een screenshot van de bankapp met meerdere transacties (spec: Verwerking stap 6): hij boekt
// niets vanzelf, staat in Te controleren en wordt op het bonscherm in één keer bevestigd. Haiku
// is nagebootst (tests/e2e/haiku-mock.mjs) en geeft na `POST /volgende` één keer een lijst.

const HAIKU = 'http://127.0.0.1:4199';

test.beforeEach(async ({ context }) => {
	await login(context);
});

test('een lijst-screenshot aanvinken en in één keer bevestigen', async ({ page, request }) => {
	await request.post(`${HAIKU}/volgende`, { data: 'lijst' });
	const before = count('SELECT count(*) AS n FROM receipts');
	await page.goto('/bonnen');
	await page.getByTestId('bon-bestand').setInputFiles({
		name: 'bankapp.png',
		mimeType: 'image/png',
		buffer: await sharp({ create: { width: 1170, height: 2532, channels: 3, background: '#fff' } })
			.png()
			.toBuffer()
	});
	await expect.poll(() => count('SELECT count(*) AS n FROM receipts')).toBe(before + 1);
	const id = value<string>('SELECT id AS v FROM receipts ORDER BY created_at DESC LIMIT 1')!;

	// Gelezen als lijst: in Bonnen met het aantal, en er is niets geboekt
	const row = page.getByRole('main').locator(`a[href="/bonnen/${id}"]`);
	await expect(row).toContainText('3 transacties', { timeout: 15_000 });
	await expect(row).toContainText('Screenshot');
	await expect(row).toContainText('Lijst bevestigen');
	expect(value<string>('SELECT kind AS v FROM receipts WHERE id = ?', id)).toBe('lijst');
	const bonBefore = count("SELECT count(*) AS n FROM transactions WHERE source = 'bon'");

	// In de review-inbox, met een knop naar het bonscherm
	await page.goto('/te-controleren');
	// De projecten delen één database: het item van dit screenshot, op ID
	const item = page
		.getByRole('main')
		.getByRole('region', { name: 'Bonnen' })
		.getByRole('listitem')
		.filter({ has: page.locator(`a[href="/bonnen/${id}"]`) });
	await expect(item.getByText('Een screenshot met 3 transacties.')).toBeVisible();
	await item.getByRole('link', { name: /bevestigen$/ }).click();

	await expect(page).toHaveURL(new RegExp(`/bonnen/${id}$`));
	const main = page.getByRole('main');
	await expect(main.getByRole('heading', { level: 1, name: 'Screenshot' })).toBeVisible();
	await expect(main.getByText('er is nog niets geboekt')).toBeVisible();
	const checks = main.getByRole('checkbox');
	await expect(checks).toHaveCount(3);
	for (const c of await checks.all()) await expect(c).toBeChecked();
	await expect(main.getByText('3 van 3 aangevinkt')).toBeVisible();

	// Het salaris laten we weg; de rest wordt nieuw, op de rekening die we kiezen
	await main.getByRole('checkbox', { name: /Proefwerkgever/ }).uncheck();
	await expect(main.getByText('2 van 3 aangevinkt')).toBeVisible();
	await expect(main.getByText('2 nieuw.')).toBeVisible();
	await expect(main.getByRole('combobox', { name: 'Rekening' })).toBeVisible();
	await main.getByRole('button', { name: 'Bevestigen' }).click();
	await expect(page.getByText('Lijst bevestigd.')).toBeVisible();

	// Daarna alleen lezen: de geboekte regels als rij, de overgeslagen erbij
	await expect(main.getByRole('checkbox')).toHaveCount(0);
	await expect(main.getByText(/overgeslagen/)).toBeVisible();
	await expect(main.locator('a[href^="/transacties/"]')).toHaveCount(2);

	expect(count("SELECT count(*) AS n FROM transactions WHERE source = 'bon'")).toBe(bonBefore + 2);
	expect(
		count(
			`SELECT count(*) AS n FROM receipt_items i JOIN transactions t ON t.id = i.transaction_id
			 WHERE i.receipt_id = ? AND t.source = 'bon'
			   AND ((t.amount_cents < 0 AND t.status = 'bevestigd')
			     OR (t.amount_cents = 0 AND t.orig_currency = 'USD' AND t.status = 'te_controleren'))`,
			id
		)
	).toBe(2);
	expect(
		count(
			"SELECT count(*) AS n FROM receipt_items WHERE receipt_id = ? AND counterparty LIKE 'Proefwerkgever%' AND transaction_id IS NULL",
			id
		)
	).toBe(1);
	expect(value<string>('SELECT handled_at AS v FROM receipts WHERE id = ?', id)).toBeTruthy();

	// Uit de review-inbox
	await page.goto('/te-controleren');
	await expect(page.getByRole('main').locator(`a[href="/bonnen/${id}"]`)).toHaveCount(0);
});

test('een lijst past op een telefoonscherm, zonder native select', async ({ page, request }) => {
	await request.post(`${HAIKU}/volgende`, { data: 'lijst' });
	const before = count('SELECT count(*) AS n FROM receipts');
	await page.goto('/bonnen');
	await page.getByTestId('bon-bestand').setInputFiles({
		name: 'bankapp.png',
		mimeType: 'image/png',
		buffer: await sharp({ create: { width: 900, height: 1900, channels: 3, background: '#fff' } })
			.png()
			.toBuffer()
	});
	await expect.poll(() => count('SELECT count(*) AS n FROM receipts')).toBe(before + 1);
	const id = value<string>('SELECT id AS v FROM receipts ORDER BY created_at DESC LIMIT 1')!;
	await expect(page.locator(`a[href="/bonnen/${id}"]`)).toContainText('3 transacties', {
		timeout: 15_000
	});

	await page.goto(`/bonnen/${id}`);
	await expect(page.getByRole('checkbox')).toHaveCount(3);
	const { inner, scroll } = await page.evaluate(() => ({
		inner: document.documentElement.clientWidth,
		scroll: document.documentElement.scrollWidth
	}));
	expect(scroll).toBeLessThanOrEqual(inner);
	await expect(page.locator('select')).toHaveCount(0);
	// Met het toetsenbord: een regel uit- en weer aanvinken, als de pagina gehydrateerd is
	await page.waitForLoadState('networkidle');
	const first = page.getByRole('checkbox').first();
	const was = await first.isChecked();
	await first.focus();
	await page.keyboard.press('Space');
	await expect(first).toBeChecked({ checked: !was });
	await page.keyboard.press('Space');
	await expect(first).toBeChecked({ checked: was });
});
