import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { login } from './helpers.ts';

// Het vraagveld (spec: Vraagveld, Tests): een vraag stellen en de aannames zien, met een
// nagebootste Haiku (haiku-mock.mjs vertaalt elke vraag naar "uitgegeven aan Boodschappen, deze
// maand"). Het getal en de zin komen uit de app zelf.

test.beforeEach(async ({ context }) => {
	await login(context);
});

/** Een boodschap deze maand, zodat er iets uit te rekenen is. Eén keer per database. */
test.beforeAll(() => {
	const db = new Database('.e2e/budget.db', { fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	if (!db.prepare("SELECT 1 FROM transactions WHERE counterparty = 'Vraag e2e Markt'").get()) {
		const account = (
			db.prepare("SELECT id FROM accounts WHERE alias = 'sns'").get() as { id: string }
		).id;
		const category = (
			db.prepare("SELECT id FROM categories WHERE name = 'Boodschappen'").get() as { id: string }
		).id;
		db.prepare(
			`INSERT INTO transactions (id, amount_cents, date, counterparty, category_id, account_id,
				source, status)
			 VALUES (?, -1234, date('now', 'localtime', 'start of month'), 'Vraag e2e Markt', ?, ?,
				'handmatig', 'bevestigd')`
		).run(randomUUID(), category, account);
	}
	db.close();
});

test('een vraag stellen en de aannames zien', async ({ page }) => {
	await page.goto('/analyses/vraag');
	const tabs = page.getByRole('navigation', { name: 'Analyses' });
	await expect(tabs.getByRole('link', { name: 'Vraag' })).toHaveAttribute('aria-current', 'page');
	await expect(page.getByRole('list', { name: 'Voorbeeldvragen' }).getByRole('button')).toHaveCount(
		3
	);
	await page.waitForLoadState('networkidle');

	await page
		.getByLabel('Wat wil je weten?')
		.fill('Hoeveel gaf ik deze maand uit aan boodschappen?');
	await page.getByRole('button', { name: 'Vragen' }).click();
	// Laadstaat zolang Haiku denkt
	await expect(page.getByText('Haiku vertaalt je vraag')).toBeVisible();

	const answer = page.getByRole('region', { name: 'Antwoord' });
	await expect(answer.getByText(/ aan Boodschappen, 1 /)).toBeVisible();
	const assumptions = answer.getByRole('list').first();
	await expect(assumptions).toContainText(/deze maand = 1 \S+ tot en met/);
	await expect(assumptions).toContainText('boodschappen = de categorie Boodschappen');

	// De gegenereerde vraag, ingeklapt
	await expect(answer.getByText('maat: uitgegeven')).toBeHidden();
	await answer.getByText('Gegenereerde vraag').click();
	await expect(answer.getByText('maat: uitgegeven')).toBeVisible();

	await answer.getByRole('button', { name: 'Klopt niet' }).click();
	await expect(page.getByRole('status')).toHaveText('Gemeld: dit antwoord klopt niet.');
	await expect(answer.getByText('Gemeld als niet kloppend')).toBeVisible();

	// Onder het veld, met één tik opnieuw uit te rekenen
	const history = page.getByRole('region', { name: 'Eerdere vragen' });
	await expect(history).toContainText('Hoeveel gaf ik deze maand uit aan boodschappen?');
	await history.getByRole('button').first().click();
	await expect(answer.getByText(/ aan Boodschappen, 1 /)).toBeVisible();
});
