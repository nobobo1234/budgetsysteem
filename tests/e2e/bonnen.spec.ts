import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { count, login, value } from './helpers.ts';

// Bon uploaden tot de review-inbox (spec: Tests en CI, E2E). Haiku is nagebootst
// (tests/e2e/haiku-mock.mjs): elke bon komt terug met een onleesbaar totaal, dus onzeker.

test.beforeEach(async ({ context }) => {
	await login(context);
});

/** Een "foto" van 3200 bij 1800 met EXIF, zoals een telefoon hem maakt. */
async function photo(): Promise<Buffer> {
	return sharp({ create: { width: 3200, height: 1800, channels: 3, background: '#f4f1ea' } })
		.jpeg({ quality: 95 })
		.withExif({ IFD0: { Copyright: 'exif-van-de-telefoon', Make: 'Telefoon' } })
		.toBuffer();
}

test('bon uploaden, lezen, in de review-inbox en verwerken', async ({ page }) => {
	const before = count('SELECT count(*) AS n FROM receipts');
	await page.goto('/bonnen');
	const main = page.getByRole('main');
	await expect(main.getByRole('heading', { level: 1, name: 'Bonnen' })).toBeVisible();

	await main.getByTestId('bon-bestand').setInputFiles({
		name: 'bon.jpg',
		mimeType: 'image/jpeg',
		buffer: await photo()
	});

	// Meteen in de lijst, met de rustige laadstaat
	await expect(
		main.getByRole('listitem').getByRole('status').filter({ hasText: 'Wordt gelezen' })
	).toBeVisible();
	await expect.poll(() => count('SELECT count(*) AS n FROM receipts')).toBe(before + 1);
	const id = value<string>('SELECT id AS v FROM receipts ORDER BY created_at DESC LIMIT 1')!;

	// Verkleind tot 2576 px en zonder EXIF op de server aangekomen
	const fileId = value<string>('SELECT file_id AS v FROM receipts WHERE id = ?', id)!;
	const stored = readFileSync(join('.e2e', 'receipts', `${fileId}.jpg`));
	const meta = await sharp(stored).metadata();
	expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(2576);
	expect(meta.exif).toBeUndefined();
	expect(stored.includes(Buffer.from('exif-van-de-telefoon'))).toBe(false);

	// De laadstaat gaat over in de herkende velden
	// De projecten delen één database: de rij van deze bon, op ID
	const row = main.locator(`a[href="/bonnen/${id}"]`);
	await expect(row).toContainText(/Proefwinkel \d+/, { timeout: 15_000 });
	await expect(row).toContainText('Te controleren');
	const store = value<string>(
		"SELECT json_extract(checked_fields, '$.store') AS v FROM receipts WHERE id = ?",
		id
	)!;
	// Onzeker: er is nog niets geboekt
	expect(value<string>('SELECT status AS v FROM receipts WHERE id = ?', id)).toBe('onzeker');
	expect(
		count('SELECT count(*) AS n FROM receipts WHERE id = ? AND transaction_id IS NULL', id)
	).toBe(1);

	// In de review-inbox, als eerste groep
	await page.goto('/te-controleren');
	const bonnen = page.getByRole('main').getByRole('region', { name: 'Bonnen' });
	await expect(bonnen.getByText(store)).toBeVisible();
	await expect(bonnen.getByText(/Twijfel over het totaal/).first()).toBeVisible();
	await bonnen.getByRole('link', { name: `${store} nakijken` }).click();

	// Op het bonscherm: het totaal ontbreekt, dus het formulier staat open
	await expect(page).toHaveURL(new RegExp(`/bonnen/${id}$`));
	const bon = page.getByRole('main');
	await expect(bon.getByRole('heading', { level: 1, name: store })).toBeVisible();
	await expect(bon.getByText(/twijfelt over het totaal/)).toBeVisible();
	await bon.getByLabel('Totaal').fill('7,37');
	await bon.getByRole('button', { name: 'Opslaan' }).click();

	// Daarna de koppellijst: nieuwe transactie kiezen en verwerken
	await expect(bon.getByRole('heading', { name: 'Waar hoort hij bij?' })).toBeVisible();
	await bon.getByRole('radio', { name: /Nieuwe transactie/ }).check();
	await bon.getByRole('button', { name: 'Verwerken' }).click();
	await expect(page.getByText('Bon verwerkt.')).toBeVisible();
	await expect(bon.getByRole('heading', { name: 'Hoort bij' })).toBeVisible();

	const txId = value<string>('SELECT transaction_id AS v FROM receipts WHERE id = ?', id)!;
	expect(
		count(
			"SELECT count(*) AS n FROM transactions WHERE id = ? AND source = 'bon' AND amount_cents = -737",
			txId
		)
	).toBe(1);

	// Uit de review-inbox
	await page.goto('/te-controleren');
	await expect(page.getByRole('main').getByText(store)).toHaveCount(0);
});

test('/bonnen en een bon passen op een telefoonscherm, zonder native select', async ({ page }) => {
	const before = count('SELECT count(*) AS n FROM receipts');
	await page.goto('/bonnen');
	await page.getByTestId('bon-bestand').setInputFiles({
		name: 'scherm.png',
		mimeType: 'image/png',
		buffer: await sharp({ create: { width: 900, height: 1900, channels: 4, background: '#fff' } })
			.png()
			.toBuffer()
	});
	await expect.poll(() => count('SELECT count(*) AS n FROM receipts')).toBe(before + 1);
	const id = value<string>('SELECT id AS v FROM receipts ORDER BY created_at DESC LIMIT 1')!;
	await expect(page.locator(`a[href="/bonnen/${id}"]`)).toContainText(/Proefwinkel \d+/, {
		timeout: 15_000
	});
	for (const path of ['/bonnen', `/bonnen/${id}`]) {
		await page.goto(path);
		const { inner, scroll } = await page.evaluate(() => ({
			inner: document.documentElement.clientWidth,
			scroll: document.documentElement.scrollWidth
		}));
		expect(scroll, path).toBeLessThanOrEqual(inner);
		await expect(page.locator('select'), path).toHaveCount(0);
	}
});
