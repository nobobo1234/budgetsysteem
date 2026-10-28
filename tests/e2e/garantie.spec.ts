import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { login, run, value } from './helpers.ts';

// Garantie (spec: Garantie → Tests): een voorstel bevestigen tot het product op Garantie staat.

test.beforeEach(async ({ context }) => {
	await login(context);
});

test('een voorstel bevestigen tot het product op Garantie staat', async ({ page }) => {
	// Chromium en WebKit delen één database: elk een eigen winkel
	const store = `Elektrowinkel ${test.info().project.name} ${randomUUID().slice(0, 4)}`;
	const product = `Laptop ${test.info().project.name}`;
	const tx = randomUUID();
	run(
		`INSERT INTO transactions (id, amount_cents, date, counterparty, category_id, account_id,
			source, status)
		 VALUES (?, -64900, date('now', '-5 days'), ?,
			(SELECT id FROM categories WHERE name = 'Elektronica'),
			(SELECT id FROM accounts WHERE alias = 'sns'), 'handmatig', 'bevestigd')`,
		tx,
		store
	);

	await page.goto('/te-controleren');
	const group = page.getByRole('region', { name: 'Garantie bijhouden?' });
	await expect(group).toContainText(store);
	await group.getByRole('textbox', { name: `Welk product kocht je bij ${store}?` }).fill(product);
	await group
		.getByRole('button', { name: `Garantie bijhouden voor ${store}`, exact: true })
		.click();

	// Door naar de pagina van het product, met de zin over het eerste jaar
	await expect(page).toHaveURL(/\/garantie\/[0-9a-f-]{36}$/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(product);
	await expect(page.locator('header .tell')).toContainText('moet nog 11 maanden bewijzen');
	await expect(page.getByText('Maak een foto van de bon')).toBeVisible();

	// Op Garantie staat hij, en het voorstel is weg uit Te controleren
	await page.goto('/garantie');
	await expect(page.getByRole('article', { name: product })).toBeVisible();
	await page.goto('/te-controleren');
	await expect(page.getByRole('main')).not.toContainText(store);
	expect(value<string>('SELECT status AS v FROM warranties WHERE transaction_id = ?', tx)).toBe(
		'actief'
	);
});
