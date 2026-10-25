import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { count, login } from './helpers.ts';

test.beforeEach(async ({ context }) => {
	await login(context);
});

// Vandaag en eergisteren in de tijdzone van de server (playwright.config: TZ Europe/Amsterdam)
const day = (offset: number) =>
	new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(
		new Date(Date.now() + offset * 86_400_000)
	);

/** Een transactie om te controleren, met een eigen naam per project en poging. */
function reviewItem(): { id: string; name: string } {
	const db = new Database('.e2e/budget.db', { fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	const account = (
		db.prepare("SELECT id FROM accounts WHERE alias = 'sns'").get() as { id: string }
	).id;
	const id = randomUUID();
	const name = `Veeg ${test.info().project.name} ${id.slice(0, 4)}`;
	db.prepare(
		`INSERT INTO transactions (id, amount_cents, date, counterparty, account_id, source, status)
		 VALUES (?, -725, ?, ?, ?, 'handmatig', 'te_controleren')`
	).run(id, day(-2), name, account);
	db.close();
	return { id, name };
}

/** Veeg een rij met de muis (pointer events), zoals een vinger dat doet. */
async function swipe(page: Page, row: Locator, dx: number) {
	const box = (await row.boundingBox())!;
	const y = box.y + box.height / 2;
	const x = box.x + box.width / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y + 1);
	await page.mouse.up();
}

test('swipen: naar rechts bevestigen, naar links een categorie kiezen', async ({ page }) => {
	const { id, name } = reviewItem();
	await page.goto(`/transacties?q=${encodeURIComponent(name)}`);
	await page.waitForLoadState('networkidle');
	const row = page.locator(`[data-tx-row="${id}"]`);
	await expect(row).toContainText('Te controleren');

	await swipe(page, row, 140);
	await expect(page.getByRole('status').filter({ hasText: `${name} bevestigd.` })).toBeVisible();
	await expect
		.poll(() =>
			count("SELECT count(*) AS n FROM transactions WHERE id = ? AND status = 'bevestigd'", id)
		)
		.toBe(1);
	// Een veeg is geen klik: we staan nog op de lijst
	await expect(page).toHaveURL(/\/transacties\?/);

	await swipe(page, row, -140);
	const sheet = page.getByRole('dialog', { name });
	await expect(sheet).toBeVisible();
	await sheet.getByRole('button', { name: 'Boodschappen', exact: true }).click();
	await expect(row).toContainText('Boodschappen');
	expect(
		count(
			`SELECT count(*) AS n FROM transactions t JOIN categories c ON c.id = t.category_id
			 WHERE t.id = ? AND c.name = 'Boodschappen' AND t.category_source = 'handmatig'`,
			id
		)
	).toBe(1);
});

test('transacties: tik op een dag in het staafdiagram filtert op die dag', async ({ page }) => {
	const { name } = reviewItem();
	const date = day(-2);
	await page.goto(`/transacties?maand=${date.slice(0, 7)}`);
	await page.waitForLoadState('networkidle');
	const chart = page.getByRole('group', { name: /Uitgaven per dag/ });
	const bar = chart.getByRole('link', { name: new RegExp(`^${Number(date.slice(8))} `) });
	await bar.click();
	await expect(page).toHaveURL(new RegExp(`dag=${date}`));
	await expect(bar).toHaveAttribute('aria-current', 'true');
	await expect(page.locator('.days')).toContainText(name);
	// Alle dagkoppen zijn die ene dag
	await expect(page.locator('.day')).toHaveCount(1);
	// Nog een tik haalt het filter weer weg
	await bar.click();
	await expect(page).not.toHaveURL(/dag=/);
});
