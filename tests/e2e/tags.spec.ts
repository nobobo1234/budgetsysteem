import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { login, run, value } from './helpers.ts';

test.beforeEach(async ({ context }) => {
	await login(context);
});

// Chromium en WebKit delen één database: elk project een eigen periode, ver van de datums van
// andere tests, zodat een tag niets anders meeneemt.
const PERIOD = { chromium: '2024-03', webkit: '2024-04' } as const;

function seed(month: string) {
	const account = value<string>("SELECT id AS v FROM accounts WHERE alias = 'sns'")!;
	const category = (name: string) =>
		value<string>('SELECT id AS v FROM categories WHERE name = ?', name)!;
	const insert = (cents: number, day: string, name: string, categoryId: string) => {
		const id = randomUUID();
		run(
			`INSERT INTO transactions (id, amount_cents, date, counterparty, category_id, account_id,
				source, status)
			 VALUES (?, ?, ?, ?, ?, ?, 'handmatig', 'bevestigd')`,
			id,
			cents,
			`${month}-${day}`,
			name,
			categoryId,
			account
		);
		return id;
	};
	return {
		dinner: insert(-4250, '12', 'Time Out Market', category('Uit eten en bezorgen')),
		tram: insert(-1800, '13', 'Carris', category('Vervoer')),
		after: insert(-999, '14', 'Thuisbezorgd', category('Uit eten en bezorgen'))
	};
}

test('een tag aanmaken en zien wat hij kostte', async ({ page }) => {
	const month = PERIOD[test.info().project.name as keyof typeof PERIOD];
	const name = `Lissabon ${test.info().project.name}`;
	seed(month);

	await page.goto('/tags');
	await page.getByRole('button', { name: 'Nieuwe tag' }).click();
	const sheet = page.getByRole('dialog', { name: 'Nieuwe tag' });
	await sheet.getByLabel('Naam').fill(name);
	await sheet.getByLabel('Van').fill(`${month}-11`);
	// Op de tekst tikken, zoals op de telefoon; de schakelaar zelf ligt onder de baan
	const open = sheet.getByRole('switch', { name: /Loopt door/ });
	await expect(open).toBeChecked();
	await sheet.getByText(/^Loopt door/).click();
	await expect(open).not.toBeChecked();
	await sheet.getByLabel('Tot en met').fill(`${month}-13`);
	await sheet.getByRole('button', { name: 'Aanmaken' }).click();

	// Naar de tag: het totaal telt wat er in die dagen uitging, de 14e niet
	await expect(page).toHaveURL(/\/tags\/[0-9a-f-]{36}$/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
	const amount = page.locator('header .amount');
	await expect(amount).toContainText('60,50');
	await expect(page.getByLabel(`Verdeling van ${name} per categorie`)).toContainText('Vervoer');
	await expect(page.getByRole('main')).not.toContainText('Thuisbezorgd');

	// Op de transactie de tag uitzetten: het totaal daalt
	await page.getByRole('link', { name: /Carris/ }).click();
	const chip = page.getByRole('button', { name: new RegExp(name) });
	await expect(chip).toHaveAttribute('aria-pressed', 'true');
	await chip.click();
	await expect(chip).toHaveAttribute('aria-pressed', 'false');

	await page.goBack();
	await page.reload();
	await expect(amount).toContainText('42,50');
	await expect(page.getByText('Uitgezet')).toBeVisible();

	// En op Tags staat hij met zijn totaal
	await page.goto('/tags');
	const card = page.getByRole('article', { name });
	await expect(card).toContainText('42,50');
});
