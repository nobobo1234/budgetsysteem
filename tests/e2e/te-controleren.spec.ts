import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { count, login } from './helpers.ts';

// Review-inbox: van het signaalkaartje naar de lijst, en per soort de actie.

test.beforeEach(async ({ context }) => {
	await login(context);
});

// De projecten (en herhalingen bij een retry) delen één database: elke test eigen namen
const suffix = () => `${test.info().project.name} ${randomUUID().slice(0, 4)}`;

/** Een boeking op te controleren, een gemiste vaste last en een Tikkie van drie weken. */
function seed(tag: string) {
	const db = new Database('.e2e/budget.db', { fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	const account = (
		db.prepare("SELECT id FROM accounts WHERE alias = 'sns'").get() as { id: string }
	).id;
	const ids = {
		tx: randomUUID(),
		recurring: randomUUID(),
		expected: randomUUID(),
		person: randomUUID(),
		owed: randomUUID()
	};
	const names = {
		tx: `Controle ${tag}`,
		recurring: `Sportschool ${tag}`,
		person: `Kim ${tag}`
	};
	db.prepare(
		`INSERT INTO transactions (id, amount_cents, date, counterparty, account_id, source, status)
		 VALUES (?, -2350, date('now', '-12 days'), ?, ?, 'import', 'te_controleren')`
	).run(ids.tx, names.tx, account);
	db.prepare(
		`INSERT INTO recurring (id, match_key, counterparty, interval, expected_day, median_cents,
			min_cents, max_cents, kind, next_date, account_id, status)
		 VALUES (?, ?, ?, 'maand', 1, 2999, 2999, 2999, 'vast', date('now', '+20 days'), ?, 'actief')`
	).run(ids.recurring, `${names.recurring.toLowerCase()}|`, names.recurring, account);
	db.prepare(
		`INSERT INTO transactions (id, amount_cents, date, counterparty, account_id, source, status,
			recurring_id)
		 VALUES (?, -2999, date('now', '-9 days'), ?, ?, 'verwacht', 'verwacht', ?)`
	).run(ids.expected, names.recurring, account, ids.recurring);
	db.prepare('INSERT INTO people (id, name) VALUES (?, ?)').run(ids.person, names.person);
	db.prepare(
		`INSERT INTO owed (id, person_id, amount_cents, direction, description, date)
		 VALUES (?, ?, 1800, 'te_krijgen', 'Pizza', date('now', '-21 days'))`
	).run(ids.owed, ids.person);
	db.close();
	return { ids, names };
}

test('van het signaalkaartje naar de review-inbox, en per soort de actie', async ({ page }) => {
	const { ids, names } = seed(suffix());

	await page.goto('/');
	await page.getByRole('link', { name: /te controleren/ }).click();
	await expect(page).toHaveURL(/\/te-controleren$/);
	const main = page.getByRole('main');
	await expect(main.getByRole('heading', { level: 1, name: 'Te controleren' })).toBeVisible();
	// Het getal van het kaartje schuift mee naar de kop; de terugknop staat erboven
	await expect(main.locator('[data-morph-head="bedrag"]')).toHaveCount(1);
	const [back, title] = await Promise.all([
		main.locator('[data-back]').boundingBox(),
		main.getByRole('heading', { level: 1 }).boundingBox()
	]);
	expect(back!.y).toBeLessThan(title!.y);

	// Een boeking die klopt
	const bookings = main.getByRole('region', { name: 'Boekingen' });
	await bookings.getByRole('button', { name: `${names.tx} klopt` }).click();
	await expect(page.getByText(`${names.tx} klopt.`)).toBeVisible();
	await expect(bookings.getByText(names.tx)).toHaveCount(0);
	expect(
		count("SELECT count(*) AS n FROM transactions WHERE id = ? AND status = 'bevestigd'", ids.tx)
	).toBe(1);

	// Gemist: deze keer niet afgeschreven
	const missed = main.getByRole('region', { name: 'Gemist of opgezegd?' });
	const row = missed.getByRole('listitem').filter({ hasText: names.recurring });
	await row.getByRole('button', { name: 'Niet afgeschreven' }).click();
	await row.getByRole('button', { name: 'Deze keer niet' }).click();
	await expect(page.getByText(`${names.recurring} deze keer overgeslagen.`)).toBeVisible();
	await expect(missed.getByText(names.recurring)).toHaveCount(0);
	expect(count('SELECT count(*) AS n FROM transactions WHERE id = ?', ids.expected)).toBe(0);

	// Herinneren laten staan: weg uit de inbox, de post blijft open
	const remind = main.getByRole('region', { name: 'Herinneren' });
	await remind.getByRole('button', { name: `Post van ${names.person} laten staan` }).click();
	await expect(remind.getByText(names.person)).toHaveCount(0);
	expect(count("SELECT count(*) AS n FROM owed WHERE id = ? AND status = 'open'", ids.owed)).toBe(
		1
	);
	await page.reload();
	await expect(main.getByText(names.person)).toHaveCount(0);
});

test('past op een telefoonscherm en gebruikt geen native select', async ({ page }) => {
	seed(suffix());
	await page.setViewportSize({ width: 375, height: 812 });
	await page.goto('/te-controleren');
	await expect(page.getByRole('region', { name: 'Herinneren' })).toBeVisible();
	const { inner, scroll } = await page.evaluate(() => ({
		inner: document.documentElement.clientWidth,
		scroll: document.documentElement.scrollWidth
	}));
	expect(scroll).toBeLessThanOrEqual(inner);
	await expect(page.locator('select')).toHaveCount(0);
});

test('met het toetsenbord bereikbaar, met zichtbare focus', async ({ page }) => {
	const { names } = seed(suffix());
	await page.goto('/te-controleren');
	const button = page.getByRole('button', { name: `${names.tx} klopt` });
	await button.focus();
	await expect(button).toBeFocused();
	const focus = await button.evaluate((el) => ({
		visible: el.matches(':focus-visible'),
		outline: getComputedStyle(el).outlineStyle
	}));
	expect(focus).toEqual({ visible: true, outline: 'solid' });
	// Tikdoel minstens 44 px hoog
	expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});
