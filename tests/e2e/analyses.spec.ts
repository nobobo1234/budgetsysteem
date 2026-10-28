import Database from 'better-sqlite3';
import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers.ts';

// Analyses als vierde tab (spec: Schermen, Analyses); Import staat sindsdien als tegel op Meer.

const PAGES = ['/analyses', '/analyses/trend', '/analyses/jaar', '/analyses/vraag'];

/**
 * Uitgaven deze maand en de twee maanden ervoor, zodat er iets te analyseren is. Eén keer per
 * run: na een mislukte test start Playwright een nieuwe worker, die beforeAll opnieuw draait.
 */
function spending() {
	const db = new Database('.e2e/budget.db', { fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	if (db.prepare("SELECT 1 FROM transactions WHERE counterparty = 'Analyse Bakker'").get()) {
		db.close();
		return;
	}
	const account = (
		db.prepare("SELECT id FROM accounts WHERE alias = 'sns'").get() as { id: string }
	).id;
	const category = (name: string) =>
		(db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: string }).id;
	const insert = db.prepare(
		`INSERT INTO transactions (id, amount_cents, date, counterparty, category_id, account_id,
			source, status)
		 VALUES (lower(hex(randomblob(16))), ?, date('now', 'start of month', ?), ?, ?, ?,
			'handmatig', 'bevestigd')`
	);
	// Groot genoeg om bovenaan de grootste uitgaven te staan, ook met de data van andere tests
	for (const [cents, offset, who, cat] of [
		[-250000, '+0 days', 'Analyse Bakker', 'Boodschappen'],
		[-1890, '-1 months', 'Analyse Bakker', 'Boodschappen'],
		[-2500, '-2 months', 'Analyse Kapper', 'Drogist en verzorging']
	] as const)
		insert.run(cents, offset, who, category(cat), account);
	db.close();
}

test.beforeAll(() => spending());

test.beforeEach(async ({ context }) => {
	await login(context);
});

/** Op het smalste telefoonscherm (375 px): geen horizontale scroll en geen native select. */
async function fitsPhone(page: Page, path: string) {
	await page.setViewportSize({ width: 375, height: 812 });
	await page.goto(path);
	await page.waitForLoadState('networkidle');
	const { inner, scroll } = await page.evaluate(() => ({
		inner: document.documentElement.clientWidth,
		scroll: document.documentElement.scrollWidth
	}));
	expect(scroll, path).toBeLessThanOrEqual(inner);
	await expect(page.locator('select'), path).toHaveCount(0);
}

test('de vierde tab is Analyses; Import is een tegel op Meer', async ({ page }) => {
	await page.goto('/');
	const nav = page.getByRole('navigation', { name: 'Hoofdmenu' });
	await expect(nav.getByRole('link')).toHaveText([
		/Overzicht/,
		/Transacties/,
		/Budget/,
		/Analyses/,
		/Meer/
	]);
	await page.waitForLoadState('networkidle');
	await nav.getByRole('link', { name: 'Analyses' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Analyses');
	await expect(nav.getByRole('link', { name: 'Analyses' })).toHaveAttribute('aria-current', 'page');

	// Trend en Jaar horen bij dezelfde tab
	const tabs = page.getByRole('navigation', { name: 'Analyses' });
	await tabs.getByRole('link', { name: 'Trend' }).click();
	await expect(tabs.getByRole('link', { name: 'Trend' })).toHaveAttribute('aria-current', 'page');
	await expect(nav.getByRole('link', { name: 'Analyses' })).toHaveAttribute('aria-current', 'page');

	await page.goto('/instellingen');
	await page.waitForLoadState('networkidle');
	await page.getByRole('link', { name: /^Importeren/ }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Importeren');
	await expect(nav.getByRole('link', { name: /^Meer/ })).toHaveAttribute('aria-current', 'page');
	await page.getByRole('main').locator('[data-back]').click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Meer');
});

test('maand: verwachting, grafiek en dezelfde cijfers als tekst', async ({ page }) => {
	await page.goto('/analyses');
	await expect(page.getByRole('region', { name: /^Verwacht uitgegeven eind/ })).toBeVisible();
	// De grafiek wordt na de eerste weergave geladen; de tabel staat er meteen
	await expect(page.locator('.uplot canvas').first()).toBeAttached();
	const table = page.getByRole('table', { name: /opgeteld per dag/ });
	await expect(table).toBeAttached();
	await expect(table.getByRole('row').nth(1)).toBeAttached();
	await expect(page.getByRole('heading', { name: 'Per categorie' })).toBeVisible();
	await expect(page.getByRole('main')).toContainText('Boodschappen');
	await expect(
		page.getByRole('link', { name: /Analyse Bakker/ }).filter({ hasText: '1 keer' })
	).toBeVisible();

	// Een vorige maand heeft geen verwachting, wel wat er uitgegeven is
	await page.getByRole('link', { name: 'Vorige' }).click();
	await expect(page.getByRole('region', { name: /^Uitgegeven in/ })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Volgende' })).toBeVisible();
});

test('trend: een andere categorie kiezen via de eigen select', async ({ page }) => {
	await page.goto('/analyses/trend');
	await page.waitForLoadState('networkidle');
	await expect(page.getByRole('table', { name: /Uitgaven per maand over twaalf/ })).toBeAttached();
	const select = page.getByRole('combobox', { name: 'Categorie', exact: true });
	await select.click();
	await page.getByRole('option', { name: 'Drogist en verzorging' }).click();
	await expect(select).toHaveText('Drogist en verzorging');
	await expect(
		page.getByRole('table', { name: 'Drogist en verzorging per maand over twaalf maanden' })
	).toBeAttached();
});

test('jaar: totaal, per categorie en de grootste uitgaven', async ({ page }) => {
	await page.goto('/analyses/jaar');
	await expect(page.getByRole('region', { name: /^Uitgegeven in \d{4}$/ })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Per categorie' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Grootste uitgaven' })).toBeVisible();
});

for (const path of PAGES) {
	test(`${path} past op 375 px, zonder native select`, async ({ page }) => {
		await fitsPhone(page, path);
	});
}
