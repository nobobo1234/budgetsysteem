import { expect, test } from '@playwright/test';
import { login } from './helpers.ts';

test.beforeEach(async ({ context }) => {
	await login(context);
});

// De projecten delen één database: daarom eerst het startsaldo zelf zetten (op vandaag), zodat het
// verwachte saldo vaststaat, ongeacht wat andere tests eerder importeerden of invoerden.
test('saldocheck: startsaldo, saldo invullen en het verschil zien', async ({ page }) => {
	await page.goto('/instellingen');
	await page.getByRole('link', { name: 'Saldocheck' }).click();
	await expect(page.getByRole('heading', { name: 'Saldocheck', level: 1 })).toBeVisible();

	const card = page.getByRole('region', { name: 'Revolut' });
	const adjust = card.getByText('Aanpassen');
	if (await adjust.isVisible()) await adjust.click();
	const anchor = card.locator('form[action="?/anchor"]');
	await anchor.getByLabel('Saldo aan het eind van de dag').fill('250,00');
	await anchor.getByRole('button', { name: 'Startsaldo opslaan' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Startsaldo opgeslagen' })).toBeVisible();
	await expect(card.getByText('Verwacht vandaag')).toBeVisible();
	await expect(card).toContainText('zelf ingevuld');

	// Bij de bank staat 12,50 minder: een vergeten uitgave
	await card.getByText('Saldo invullen').click();
	const check = card.locator('form[action="?/check"]');
	await check.getByLabel('Saldo volgens de bank').fill('237,50');
	await check.getByRole('button', { name: 'Vergelijken' }).click();
	await expect(card).toContainText(/12,50\s*verschil/);
	await expect(card).toContainText('minder dan de app verwacht');
	await expect(check).toBeHidden();

	// Naar de transacties van die rekening in die periode, met het filter zichtbaar
	await card.getByRole('link', { name: /^Transacties/ }).click();
	await expect(page).toHaveURL(/\/transacties\?rekening=[0-9a-f-]+&van=\d{4}-\d{2}-\d{2}&tot=/);
	await expect(page.getByRole('link', { name: /Filter Revolut .* weghalen/ })).toBeVisible();
	await page.goBack();

	// Het juiste saldo: klopt
	await card.getByText('Saldo invullen').click();
	await check.getByLabel('Saldo volgens de bank').fill('250');
	await check.getByRole('button', { name: 'Vergelijken' }).click();
	await expect(card).toContainText('Klopt op');
	await expect(card.getByRole('link', { name: 'Export importeren' })).toHaveCount(0);
});

test('saldocheck: een onleesbaar bedrag geeft een fout bij het veld', async ({ page }) => {
	await page.goto('/saldocheck');
	const card = page.getByRole('region', { name: 'Revolut' });
	await card.getByText('Saldo invullen').click();
	const check = card.locator('form[action="?/check"]');
	await check.getByLabel('Saldo volgens de bank').fill('12,345');
	await check.getByRole('button', { name: 'Vergelijken' }).click();
	await expect(check.getByRole('alert')).toHaveText('Dat bedrag kan ik niet lezen.');
	await expect(check.getByLabel('Saldo volgens de bank')).toHaveAttribute('aria-invalid', 'true');
});
