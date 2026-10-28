import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { count, login } from './helpers.ts';

// Vandaag in de tijdzone van de server (playwright.config: TZ Europe/Amsterdam)
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date());

/** Een actieve vaste last met een verwachte post voor vandaag, rechtstreeks in de testdatabase. */
function expectedPost(counterparty: string, kind: 'vast' | 'wisselend', cents: number) {
	const db = new Database('.e2e/budget.db', { fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	const account = (
		db.prepare("SELECT id FROM accounts WHERE alias = 'sns'").get() as { id: string }
	).id;
	const category = (
		db.prepare("SELECT id FROM categories WHERE name = 'Wonen'").get() as { id: string }
	).id;
	const recurringId = randomUUID();
	const transactionId = randomUUID();
	db.prepare(
		`INSERT INTO recurring (id, match_key, counterparty, interval, expected_day, median_cents,
			min_cents, max_cents, kind, next_date, category_id, account_id, status)
		 VALUES (?, ?, ?, 'maand', ?, ?, ?, ?, ?, ?, ?, ?, 'actief')`
	).run(
		recurringId,
		`${counterparty.toLowerCase()}|`,
		counterparty,
		Number(today.slice(8, 10)),
		cents,
		cents,
		cents,
		kind,
		today,
		category,
		account
	);
	db.prepare(
		`INSERT INTO transactions (id, amount_cents, date, counterparty, category_id, category_source,
			account_id, source, status, recurring_id)
		 VALUES (?, ?, ?, ?, ?, 'handmatig', ?, 'verwacht', 'verwacht', ?)`
	).run(transactionId, -cents, today, counterparty, category, account, recurringId);
	db.close();
	return { recurringId, transactionId };
}

function proposal(counterparty: string) {
	const db = new Database('.e2e/budget.db', { fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	const id = randomUUID();
	const next = `${today.slice(0, 7)}-28`;
	db.prepare(
		`INSERT INTO recurring (id, match_key, counterparty, interval, expected_day, median_cents,
			min_cents, max_cents, kind, next_date, spread, status)
		 VALUES (?, ?, ?, 'halfjaar', 28, 9000, 9000, 9000, 'vast', ?, 1, 'voorstel')`
	).run(id, `${counterparty.toLowerCase()}|`, counterparty, next);
	db.close();
	return id;
}

test.beforeEach(async ({ context }) => {
	await login(context);
});

// De projecten (en herhalingen bij een retry) delen één database: elke test een eigen tegenpartij
const suffix = () => `${test.info().project.name} ${randomUUID().slice(0, 4)}`;

/**
 * Te bevestigen op het startscherm, helemaal open. Het toont eerst drie posten, en posten van
 * andere tests staan er soms voor (vanaf de 28e ook het voorstel hieronder, dat dan verloopt).
 */
async function waitingSection(page: Page) {
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	const section = page.getByRole('region', { name: 'Te bevestigen' });
	const more = section.getByRole('button', { name: /^Nog \d+ meer/ });
	if (await more.count()) await more.click();
	return section;
}

test('verwachte post bevestigen met één tik', async ({ page }) => {
	const name = `Woonstichting ${suffix()}`;
	const { transactionId } = expectedPost(name, 'vast', 85000);

	const section = await waitingSection(page);
	await expect(section).toContainText(name);
	await section.getByRole('button', { name: `Bevestig ${name}` }).click();
	await expect(page.getByText(`${name} bevestigd.`)).toBeVisible();
	await expect
		.poll(() =>
			count(
				"SELECT count(*) AS n FROM transactions WHERE id = ? AND status = 'bevestigd'",
				transactionId
			)
		)
		.toBe(1);

	await page.reload();
	await expect(page.getByText(name)).toHaveCount(1); // alleen nog in Recent
	await expect(page.getByRole('region', { name: 'Recent' })).toContainText(name);
});

test('wisselende vaste last: eerst het bedrag aanpassen', async ({ page }) => {
	const name = `Energie ${suffix()}`;
	const { transactionId } = expectedPost(name, 'wisselend', 10000);

	const section = await waitingSection(page);
	await section.getByRole('button', { name: `Bedrag van ${name} invullen en bevestigen` }).click();
	const amount = section.getByLabel(`Bedrag ${name}`);
	await expect(amount).toBeFocused();
	await amount.fill('112,40');
	await section.getByRole('button', { name: 'Bevestigen' }).click();
	await expect(page.getByText(`${name} bevestigd.`)).toBeVisible();
	await expect
		.poll(() =>
			count(
				"SELECT count(*) AS n FROM transactions WHERE id = ? AND status = 'bevestigd' AND amount_cents = -11240",
				transactionId
			)
		)
		.toBe(1);
});

test('voorstel bevestigen: "Is … een vaste last?"', async ({ page }) => {
	const name = `Vereniging ${suffix()}`;
	const id = proposal(name);

	await page.goto('/vaste-lasten');
	const card = page.getByRole('article', { name: `Is ${name} een vaste last?` });
	await expect(card.getByRole('switch', { name: /Uitsmeren/ })).toBeChecked();
	await card.getByRole('button', { name: 'Ja, vaste last' }).click();
	await expect(page.getByText(`${name} staat bij je vaste lasten.`)).toBeVisible();
	await expect(page.getByRole('region', { name: 'Lopend' })).toContainText(name);
	expect(count("SELECT count(*) AS n FROM recurring WHERE id = ? AND status = 'actief'", id)).toBe(
		1
	);
	// Uitgesmeerd: de reservering voor deze maand staat er meteen
	expect(count('SELECT count(*) AS n FROM reservations WHERE recurring_id = ?', id)).toBe(1);

	await page.getByRole('link', { name: new RegExp(name) }).click();
	await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
	await expect(page.getByText(/opzij, afschrijving rond/)).toBeVisible();
});

// Spec: Klaar voor UI, ook voor de nieuwe schermen
for (const path of ['/vaste-lasten']) {
	test(`${path} past op een telefoonscherm en gebruikt geen native select`, async ({ page }) => {
		proposal(`Breed ${suffix()}`);
		await page.goto(path);
		const { inner, scroll } = await page.evaluate(() => ({
			inner: document.documentElement.clientWidth,
			scroll: document.documentElement.scrollWidth
		}));
		expect(scroll).toBeLessThanOrEqual(inner);
		await expect(page.locator('select')).toHaveCount(0);
	});
}

test('detailpagina van een vaste last past op een telefoonscherm', async ({ page }) => {
	const { recurringId } = expectedPost(`Detail ${suffix()}`, 'vast', 1299);
	await page.goto(`/vaste-lasten/${recurringId}`);
	await page.waitForLoadState('networkidle');
	// Eerst lezen, dan bewerken: het formulier opent via "Bewerken"
	await expect(page.getByRole('heading', { name: 'Gegevens' })).toBeVisible();
	await page.getByRole('button', { name: 'Bewerken' }).click();
	await expect(page.getByRole('button', { name: 'Opslaan' })).toBeVisible();
	const { inner, scroll } = await page.evaluate(() => ({
		inner: document.documentElement.clientWidth,
		scroll: document.documentElement.scrollWidth
	}));
	expect(scroll).toBeLessThanOrEqual(inner);
	await expect(page.locator('select')).toHaveCount(0);
});
