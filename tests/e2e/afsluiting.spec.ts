import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { login } from './helpers.ts';

// Maandafsluiting (spec: Analyses → Maandafsluiting): van het signaalkaartje op het startscherm
// naar de afsluiting, afsluiten, en daarna een late boeking die als verschil zichtbaar wordt.

test.beforeEach(async ({ context }) => {
	await login(context);
});

/** De vorige maand, zoals de server hem ziet (Europe/Amsterdam, zie playwright.config.ts). */
function previousMonth(): string {
	const now = new Date();
	const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * De projecten delen één database: haal een eerdere afsluiting van die maand weg en zet er een
 * uitgave en een limiet in, zodat het kaartje er staat.
 */
function prepare(month: string): void {
	const db = new Database('.e2e/budget.db', { fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	db.prepare('DELETE FROM month_closings WHERE month = ?').run(month);
	const account = (
		db.prepare("SELECT id FROM accounts WHERE alias = 'sns'").get() as { id: string }
	).id;
	const category = (
		db.prepare("SELECT id FROM categories WHERE name = 'Boodschappen'").get() as { id: string }
	).id;
	db.prepare(
		`INSERT INTO budgets (id, month, category_id, limit_cents) VALUES (?, ?, ?, 30000)
		 ON CONFLICT (month, category_id) DO UPDATE SET limit_cents = 30000`
	).run(randomUUID(), month, category);
	db.prepare(
		`INSERT INTO transactions (id, amount_cents, date, counterparty, category_id, account_id, source, status)
		 VALUES (?, -2500, ?, 'Afsluiting e2e', ?, ?, 'handmatig', 'bevestigd')`
	).run(randomUUID(), `${month}-10`, category, account);
	db.close();
}

/** Een late boeking na het afsluiten, zoals een import die nog binnenkomt. */
function lateBooking(month: string, cents: number): void {
	const db = new Database('.e2e/budget.db', { fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	const account = (
		db.prepare("SELECT id FROM accounts WHERE alias = 'sns'").get() as { id: string }
	).id;
	const category = (
		db.prepare("SELECT id FROM categories WHERE name = 'Boodschappen'").get() as { id: string }
	).id;
	db.prepare(
		`INSERT INTO transactions (id, amount_cents, date, counterparty, category_id, account_id, source, status)
		 VALUES (?, ?, ?, 'Late boeking e2e', ?, ?, 'import', 'bevestigd')`
	).run(randomUUID(), -cents, `${month}-28`, category, account);
	db.close();
}

const monthTitle = (month: string) => {
	const name = new Intl.DateTimeFormat('nl-NL', { month: 'long' }).format(
		new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)
	);
	return name.charAt(0).toUpperCase() + name.slice(1);
};

test('maandafsluiting: van het signaalkaartje tot afgesloten, met een late boeking', async ({
	page
}) => {
	const month = previousMonth();
	const name = monthTitle(month);
	prepare(month);

	await page.goto('/');
	const card = page.getByRole('link', { name: new RegExp(`^${name} afsluiten`) });
	await expect(card).toBeVisible();
	await card.click();

	await expect(page).toHaveURL(`/afsluiting/${month}`);
	const heading = page.getByRole('heading', { level: 1 });
	await expect(heading).toHaveAccessibleName(`${name} ${month.slice(0, 4)}`);
	await expect(page.locator('main [data-back]')).toHaveCount(1);
	await expect(page.locator('main .tell').first()).toContainText(/^Je (hield|ging|gaf)/);
	await expect(page.getByRole('heading', { name: 'Limiet en uitgaven' })).toBeVisible();

	// Past op een telefoonscherm en gebruikt geen native select
	const { inner, scroll } = await page.evaluate(() => ({
		inner: document.documentElement.clientWidth,
		scroll: document.documentElement.scrollWidth
	}));
	expect(scroll).toBeLessThanOrEqual(inner);
	await expect(page.locator('select')).toHaveCount(0);

	await page.getByRole('button', { name: 'Maand afsluiten' }).click();
	await expect(page.getByRole('status').filter({ hasText: `${name} afgesloten.` })).toBeVisible();
	await expect(page.getByText(/^Afgesloten op/)).toBeVisible();
	await expect(page.getByRole('button', { name: 'Maand afsluiten' })).toHaveCount(0);

	// Het kaartje is weg
	await page.goto('/');
	await expect(page.getByRole('link', { name: new RegExp(`^${name} afsluiten`) })).toHaveCount(0);

	// In de lijst afgesloten maanden, en een late boeking toont het verschil sinds afsluiten
	lateBooking(month, 1200);
	await page.goto('/afsluiting');
	await page.getByRole('link', { name: new RegExp(`^${name} ${month.slice(0, 4)}`) }).click();
	await expect(page).toHaveURL(`/afsluiting/${month}`);
	await expect(
		page.getByText(/Sinds afsluiten veranderd:\s*€\s?12,00\s*meer uitgegeven/)
	).toBeVisible();
});

test('maandafsluiting: met prefers-reduced-motion meteen het eindbeeld', async ({ page }) => {
	const month = previousMonth();
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto(`/afsluiting/${month}`);
	await page.waitForLoadState('networkidle');
	// Geen SplitText: de kop is nog gewone tekst, zonder losse woorden
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(
		`${monthTitle(month)} ${month.slice(0, 4)}`
	);
	expect(await page.locator('main h1 *').count()).toBe(0);
});

test('maandafsluiting: een lopende maand en een onbekende maand', async ({ page }) => {
	const now = new Date();
	const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
	await page.goto(`/afsluiting/${current}`);
	await expect(page.getByText(/loopt nog/).first()).toBeVisible();
	await expect(page.getByRole('button', { name: 'Maand afsluiten' })).toHaveCount(0);

	const response = await page.goto('/afsluiting/2026-13');
	expect(response?.status()).toBe(404);
});
