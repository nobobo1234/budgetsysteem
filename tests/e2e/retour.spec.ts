import { expect, test } from '@playwright/test';
import { count, login, value } from './helpers.ts';

test.beforeEach(async ({ context }) => {
	await login(context);
});

// Chromium en WebKit delen één database: elk project een eigen winkel. Alles op eergisteren,
// zodat deze posten niet de "Recent"-lijst van andere tests vullen.
const shop = () => `zalando-${test.info().project.name}`;

const linkedRefunds = (name: string) =>
	count(
		`SELECT count(*) AS n FROM transactions r JOIN transactions o ON o.id = r.correction_of
		 WHERE r.counterparty = ? AND r.amount_cents = 2500 AND o.amount_cents = -7995`,
		name
	);

test('retour via de snelinvoer, losmaken en opnieuw koppelen', async ({ page }) => {
	const name = shop();
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	const input = page.getByLabel('Snel invoeren');

	// Eerst de uitgave
	await input.fill(`79,95 ${name} eergisteren`);
	await page.getByRole('button', { name: 'Opslaan' }).click();
	await expect(input).toHaveValue('');
	await expect
		.poll(() =>
			count(
				'SELECT count(*) AS n FROM transactions WHERE counterparty = ? AND amount_cents = -7995',
				name
			)
		)
		.toBe(1);

	// `+25 retour <winkel>`: de snelinvoer vraagt meteen welke uitgave het was
	await page.reload();
	await page.waitForLoadState('networkidle');
	await input.fill(`+25 retour ${name} eergisteren`);
	await expect(page.locator('#quick-chips')).toContainText('Retour');
	const match = page.getByRole('group', { name: 'Retour van' });
	await expect(match).toBeVisible();
	const option = match.getByRole('radio', { name: new RegExp(name, 'i') });
	// De enige uitgave die past is al gekozen
	await expect(option).toBeChecked();
	await page.getByRole('button', { name: 'Opslaan' }).click();
	await expect(input).toHaveValue('');
	await expect.poll(() => linkedRefunds(name)).toBe(1);

	// Op de detailpagina: verrekend met de uitgave, en los te maken
	const id = value<string>(
		'SELECT id AS v FROM transactions WHERE counterparty = ? AND amount_cents = 2500',
		name
	)!;
	await page.goto(`/transacties/${id}`);
	const section = page.getByRole('region', { name: 'Verrekend met' });
	await expect(section).toContainText(name);
	await expect(section).toContainText('79,95');
	await section.getByRole('button', { name: 'Losmaken' }).click();
	await expect(page.getByText(/Te controleren: hoort dit bij een eerdere boeking/)).toBeVisible();
	await expect.poll(() => linkedRefunds(name)).toBe(0);
	expect(
		count("SELECT count(*) AS n FROM transactions WHERE id = ? AND status = 'te_controleren'", id)
	).toBe(1);

	// De koppellijst stelt de uitgave weer voor
	// (Zijn er ook open posten, dan staan die in dezelfde lijst)
	const list = page.getByRole('group', { name: 'Kies de post of uitgave' });
	await list.getByRole('radio', { name: new RegExp(name, 'i') }).check();
	await page.getByRole('button', { name: 'Koppelen' }).click();
	await expect(page.getByRole('region', { name: 'Verrekend met' })).toBeVisible();
	await expect.poll(() => linkedRefunds(name)).toBe(1);

	// Geen horizontale scroll op telefoonformaat
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth > document.documentElement.clientWidth
	);
	expect(overflow).toBe(false);

	// De uitgave toont wat er terugkwam
	const original = value<string>('SELECT correction_of AS v FROM transactions WHERE id = ?', id)!;
	await page.goto(`/transacties/${original}`);
	const back = page.getByRole('region', { name: 'Teruggekregen' });
	await expect(back).toContainText('25,00');
	await expect(back).toContainText('Er kan nog');
});
