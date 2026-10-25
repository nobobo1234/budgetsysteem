import { expect, test } from '@playwright/test';
import { count, login } from './helpers.ts';

test.beforeEach(async ({ context }) => {
	await login(context);
});

// Chromium en WebKit delen één database: elk project zijn eigen namen. Alles op eergisteren,
// zodat deze posten niet de "Recent"-lijst van andere tests vullen.
const names = () => {
	const p = test.info().project.name;
	return { sanne: `sanne-${p}`, tim: `tim-${p}` };
};

test('voorschieten via de snelinvoer, en ontvangen met de koppellijst', async ({ page }) => {
	const { sanne, tim } = names();
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	const input = page.getByLabel('Snel invoeren');

	// €10 met twee anderen: jij 3,33, de eerste 3,34, de tweede 3,33
	await input.fill(`10 etentje met ${sanne} en ${tim} eergisteren`);
	const chips = page.locator('#quick-chips');
	await expect(chips).toContainText('Jouw deel');
	await expect(chips).toContainText('3,33');
	const share = page.getByLabel('Voorgeschoten');
	await expect(share).toContainText('3,34');
	await page.getByRole('button', { name: 'Opslaan' }).click();
	await expect(input).toHaveValue('');
	await expect
		.poll(() =>
			count(
				`SELECT count(*) AS n FROM owed o JOIN people p ON p.id = o.person_id
				 WHERE lower(p.name) IN (lower(?), lower(?)) AND o.status = 'open'`,
				sanne,
				tim
			)
		)
		.toBe(2);

	// Het overzicht: totaal en een kaart per persoon
	await page.goto('/te-krijgen');
	const card = page.getByRole('article').filter({ hasText: new RegExp(sanne, 'i') });
	await expect(card).toContainText('3,34');

	// Sanne betaalt: de koppellijst stelt haar post voor
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	await input.fill(`+3,34 tikkie ${sanne} eergisteren`);
	const match = page.getByRole('group', { name: 'Ontvangen voor' });
	await expect(match).toBeVisible();
	const option = match.getByRole('radio', { name: new RegExp(sanne, 'i') });
	await option.check();
	await page.getByRole('button', { name: 'Opslaan' }).click();
	await expect(input).toHaveValue('');
	await expect
		.poll(() =>
			count(
				`SELECT count(*) AS n FROM owed o JOIN people p ON p.id = o.person_id
				 WHERE lower(p.name) = lower(?) AND o.status = 'betaald'`,
				sanne
			)
		)
		.toBe(1);
});

test('voor 3 zonder namen: wie nog meer, of later kiezen', async ({ page }) => {
	const p = test.info().project.name;
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	await page.getByLabel('Snel invoeren').fill(`30 pizza-${p} voor 3 eergisteren`);
	await expect(page.getByLabel('Voorgeschoten')).toContainText('Nog onbekend');
	await expect(page.getByText(/Wie nog meer\?/)).toBeVisible();
	await page.getByRole('button', { name: 'Opslaan' }).click();
	await expect
		.poll(() =>
			count(
				`SELECT count(*) AS n FROM owed o JOIN transactions t ON t.id = o.source_transaction_id
				 WHERE t.counterparty = ? AND o.person_id IS NULL`,
				`pizza-${p}`
			)
		)
		.toBe(2);
	await page.goto('/te-krijgen');
	await expect(page.getByRole('heading', { name: 'Nog niet gekozen' })).toBeVisible();
});

test('nog te betalen: een losse post toevoegen', async ({ page }) => {
	const p = test.info().project.name;
	await page.goto('/te-krijgen');
	await page.getByRole('button', { name: 'Nieuwe post' }).click();
	await page.getByRole('radio', { name: 'Ik moet nog' }).check();
	await page.getByRole('textbox', { name: 'Naam' }).fill(`eva-${p}`);
	await page.getByRole('textbox', { name: 'Bedrag' }).fill('12,50');
	await page.getByRole('textbox', { name: 'Waarvoor' }).fill('Bioscoop');
	await page.getByRole('button', { name: 'Toevoegen' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Post toegevoegd' })).toBeVisible();
	const card = page.getByRole('article').filter({ hasText: new RegExp(`eva-${p}`, 'i') });
	await expect(card).toContainText('12,50');
	await expect(card).toContainText('Jij betaalt');
});
