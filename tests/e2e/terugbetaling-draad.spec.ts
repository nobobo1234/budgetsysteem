import { expect, test, type Page } from '@playwright/test';
import { count, login, value } from './helpers.ts';

test.beforeEach(async ({ context }) => {
	await login(context);
});

// Chromium en WebKit delen één database: elk project eigen namen en eigen dagen, ver genoeg
// terug om niet in de "Recent"-lijst of de dagen van andere tests te komen.
function setup() {
	const p = test.info().project.name;
	const back = p === 'webkit' ? 60 : 50;
	const day = (n: number) => {
		const d = new Date();
		d.setDate(d.getDate() - n);
		const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
		return { iso, entry: `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}` };
	};
	return {
		shop: `pizzeria-draad-${p}`,
		sanne: `sanne-draad-${p}`,
		tim: `tim-draad-${p}`,
		spent: day(back),
		paid: day(back - 2)
	};
}

async function quick(page: Page, text: string) {
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	const input = page.getByLabel('Snel invoeren');
	await input.fill(text);
	return input;
}

test('een Tikkie in de lijst: label in plaats van categorie, en een draad naar de uitgave', async ({
	page
}) => {
	const { shop, sanne, tim, spent, paid } = setup();

	// Voorgeschoten voor drie, en Sanne betaalt haar deel met een Tikkie
	let input = await quick(page, `45 ${shop} met ${sanne} en ${tim} ${spent.entry}`);
	await expect(page.getByLabel('Voorgeschoten')).toContainText('15,00');
	await page.getByRole('button', { name: 'Opslaan' }).click();
	await expect(input).toHaveValue('');
	await expect
		.poll(() => count('SELECT count(*) AS n FROM transactions WHERE counterparty = ?', shop))
		.toBe(1);
	const pizza = value<string>('SELECT id AS v FROM transactions WHERE counterparty = ?', shop)!;

	input = await quick(page, `+15 tikkie ${paid.entry}`);
	const match = page.getByRole('group', { name: 'Ontvangen voor' });
	await match.getByRole('radio', { name: new RegExp(sanne, 'i') }).check();
	await page.getByRole('button', { name: 'Opslaan' }).click();
	await expect(input).toHaveValue('');
	await expect
		.poll(() =>
			count(
				`SELECT count(*) AS n FROM owed_payments op JOIN owed o ON o.id = op.owed_id
				 WHERE o.source_transaction_id = ?`,
				pizza
			)
		)
		.toBe(1);
	const tikkie = value<string>(
		`SELECT op.transaction_id AS v FROM owed_payments op JOIN owed o ON o.id = op.owed_id
		 WHERE o.source_transaction_id = ?`,
		pizza
	)!;

	// De lijst over die dagen, op telefoonbreedte
	await page.setViewportSize({ width: 375, height: 812 });
	await page.goto(`/transacties?van=${spent.iso}&tot=${paid.iso}`);
	const payRow = page.locator(`li[data-tx-row="${tikkie}"]`);
	const pizzaRow = page.locator(`li[data-tx-row="${pizza}"]`);
	await expect(payRow.locator('[data-refund]')).toHaveText(
		new RegExp(`${sanne} · voor ${shop}`, 'i')
	);
	await expect(payRow).not.toContainText('Geen categorie');
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

	// De draad loopt van de uitgave naar de betaling
	const thread = page.locator(`[data-thread="${pizza}"]`);
	await expect(thread).toHaveCount(1);
	await expect(thread.locator('circle')).toHaveCount(2);

	// Focus op de betaling licht de uitgave aan de andere kant op
	await payRow.getByRole('link').focus();
	await expect(pizzaRow).toHaveAttribute('data-thread-lit', '');
	await expect(thread).toHaveClass(/lit/);

	// Een tik op de draad, tussen de twee rijen in, brengt je naar de uitgave
	const svg = (await page.locator('svg.threads').boundingBox())!;
	const top = (await payRow.boundingBox())!;
	const bottom = (await pizzaRow.boundingBox())!;
	const gutter = Number(await page.locator('svg.threads').getAttribute('width'));
	await page.mouse.click(
		svg.x + gutter - 14,
		(top.y + top.height / 2 + bottom.y + bottom.height / 2) / 2
	);
	await expect(pizzaRow).toHaveAttribute('data-thread-flash', '');
	await expect(page).toHaveURL(/\/transacties\?/);

	// Staat de uitgave niet op de lijst, dan alleen het label en geen draad
	await page.goto(`/transacties?van=${paid.iso}&tot=${paid.iso}`);
	await expect(payRow.locator('[data-refund]')).toContainText(shop);
	await expect(page.locator(`[data-thread="${pizza}"]`)).toHaveCount(0);

	// Detailpagina: van de betaling naar de uitgave, en van de post terug naar de betaling
	await page.goto(`/transacties/${tikkie}`);
	const received = page.getByRole('region', { name: 'Ontvangen voor' });
	await expect(received).toContainText('45,00');
	await received.getByRole('link', { name: new RegExp(shop) }).click();
	await expect(page).toHaveURL(new RegExp(`/transacties/${pizza}$`));
	await page
		.getByRole('region', { name: 'Voorgeschoten' })
		.getByRole('link', { name: new RegExp(sanne, 'i') })
		.click();
	await expect(page).toHaveURL(new RegExp(`/transacties/${tikkie}$`));
});

test('draad zonder beweging bij prefers-reduced-motion, en in het donkere thema', async ({
	page
}) => {
	const { spent, paid } = setup();
	await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
	await page.goto(`/transacties?van=${spent.iso}&tot=${paid.iso}`);
	const thread = page.locator('[data-thread]').first();
	await expect(thread).toHaveCount(1);
	expect(await thread.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
	// De lijn heeft de accentkleur van het donkere thema, niet die van het lichte
	const color = await thread.evaluate((el) => getComputedStyle(el).color);
	await page.emulateMedia({ colorScheme: 'light' });
	expect(await thread.evaluate((el) => getComputedStyle(el).color)).not.toBe(color);
});
