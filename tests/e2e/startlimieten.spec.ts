import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { login, run, value } from './helpers.ts';

// Startlimieten uit historie (spec: Analyses → Startlimieten uit historie): vanaf de lege staat
// op Budget naar het voorstel, en de limieten instellen.

test.beforeEach(async ({ context }) => {
	await login(context);
});

/** De maand `delta` maanden van nu, zoals de server hem ziet (Europe/Amsterdam). */
function month(delta: number): string {
	const now = new Date();
	const d = new Date(now.getFullYear(), now.getMonth() + delta, 1);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * De projecten delen één database: geen enkele limiet, historie vanaf zes maanden terug en
 * in Cadeaus elke maand € 40, zodat het voorstel voor Cadeaus vastligt.
 */
function prepare(): string {
	run('DELETE FROM budgets');
	run(
		`INSERT INTO import_batches (id, format, new_count, duplicate_count, period_start)
		 VALUES (?, 'camt053', 0, 0, ?)`,
		randomUUID(),
		`${month(-6)}-01`
	);
	const account = value<string>("SELECT id AS v FROM accounts WHERE alias = 'sns'")!;
	const gifts = value<string>("SELECT id AS v FROM categories WHERE name = 'Cadeaus'")!;
	run('DELETE FROM transactions WHERE category_id = ?', gifts);
	for (let i = 1; i <= 6; i++)
		run(
			`INSERT INTO transactions (id, amount_cents, date, counterparty, category_id, account_id, source, status)
			 VALUES (?, -4000, ?, 'Startlimieten e2e', ?, ?, 'handmatig', 'bevestigd')`,
			randomUUID(),
			`${month(-i)}-12`,
			gifts,
			account
		);
	return gifts;
}

test('startlimieten: vanaf de lege staat op Budget limieten instellen', async ({ page }) => {
	const gifts = prepare();

	await page.goto('/budget');
	const start = page.getByRole('link', { name: 'Voorstel uit historie' });
	await expect(start).toBeVisible();
	await start.click();

	await expect(page).toHaveURL(/\/budget\/startlimieten$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Startlimieten' })).toBeVisible();
	const field = page.getByRole('textbox', { name: 'Limiet Cadeaus' });
	await expect(field).toHaveValue('40');
	await field.fill('45');

	await page.getByRole('button', { name: /^Limieten instellen/ }).click();
	await expect(page.getByRole('status').filter({ hasText: 'ingesteld' })).toBeVisible();
	expect(
		value<number>(
			'SELECT limit_cents AS v FROM budgets WHERE month = ? AND category_id = ?',
			month(0),
			gifts
		)
	).toBe(4500);

	// Terug op Budget: geen lege staat meer maar de verdeling, en Cadeaus heeft een balk
	await page.goto('/budget');
	await expect(page.getByRole('heading', { name: 'Deze maand' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Limiet Cadeaus aanpassen' })).toBeVisible();
});
