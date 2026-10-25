import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { count, login } from './helpers.ts';

// Vandaag in de tijdzone van de server (playwright.config: TZ Europe/Amsterdam)
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date());

/** Een actieve vaste last met een verwachte post voor vandaag, rechtstreeks in de testdatabase. */
function sharedLast(counterparty: string, cents: number) {
	const db = new Database('.e2e/budget.db', { fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	const account = (
		db.prepare("SELECT id FROM accounts WHERE alias = 'sns'").get() as { id: string }
	).id;
	const category = (
		db.prepare("SELECT id FROM categories WHERE name = 'Internet en telefoon'").get() as {
			id: string;
		}
	).id;
	const recurringId = randomUUID();
	db.prepare(
		`INSERT INTO recurring (id, match_key, counterparty, interval, expected_day, median_cents,
			min_cents, max_cents, kind, next_date, category_id, account_id, status)
		 VALUES (?, ?, ?, 'maand', ?, ?, ?, ?, 'vast', ?, ?, ?, 'actief')`
	).run(
		recurringId,
		`${counterparty.toLowerCase()}|`,
		counterparty,
		Number(today.slice(8, 10)),
		cents,
		cents,
		cents,
		today,
		category,
		account
	);
	db.prepare(
		`INSERT INTO transactions (id, amount_cents, date, counterparty, category_id, category_source,
			account_id, source, status, recurring_id)
		 VALUES (?, ?, ?, ?, ?, 'handmatig', ?, 'verwacht', 'verwacht', ?)`
	).run(randomUUID(), -cents, today, counterparty, category, account, recurringId);
	db.close();
	return recurringId;
}

test.beforeEach(async ({ context }) => {
	await login(context);
});

// De projecten (en herhalingen bij een retry) delen één database: elke test eigen namen
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const suffix = () => `${test.info().project.name} ${randomUUID().slice(0, 4)}`;

test('aandeel toevoegen en de terugbetaling met één tik ontvangen', async ({ page }) => {
	const last = `Wifi ${suffix()}`;
	const person = `Huisgenoot ${suffix()}`;
	const recurringId = sharedLast(last, 6000);

	await page.goto(`/vaste-lasten/${recurringId}`);
	await page.getByRole('button', { name: 'Aandeel toevoegen' }).click();
	await page.getByLabel('Naam', { exact: true }).last().fill(person);
	await page.getByLabel('Bedrag per keer').fill('20');
	await page.getByRole('button', { name: 'Toevoegen' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Aandeel toegevoegd' })).toBeVisible();
	await expect(page.locator('#shares-title').locator('..')).toContainText(/jouw deel €\s40,00/);

	// De post staat klaar op de ontvangstdag (vandaag)
	await page.goto('/terugbetalingen');
	const receive = page.getByRole('button', {
		name: new RegExp(`20,00 van ${escape(person)} ontvangen`)
	});
	await receive.click();
	await expect(receive).toHaveCount(0);
	await expect
		.poll(() =>
			count(
				`SELECT count(*) AS n FROM owed o JOIN people p ON p.id = o.person_id
				 WHERE p.name = ? AND o.share_id IS NOT NULL AND o.status = 'betaald'`,
				person
			)
		)
		.toBe(1);
	// Het vakje van deze maand zegt het in woorden, niet alleen met kleur
	const card = page.getByRole('article').filter({ hasText: person });
	await expect(card.getByRole('list', { name: /Laatste zes maanden/ })).toContainText('Binnen');
});
