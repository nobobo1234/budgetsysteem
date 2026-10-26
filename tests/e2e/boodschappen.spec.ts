import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { login, value } from './helpers.ts';

// Boodschappen per productgroep (spec: Analyses → Boodschappen per productgroep): vanaf de
// categorie Boodschappen op Budget naar het overzicht, en een groep aanpassen op de bon. De
// projecten delen één database, dus elke test maakt een eigen winkel met eigen regels.

test.beforeEach(async ({ context }) => {
	await login(context);
});

/** De maand van de testdata: vorige maand, zodat de lijst Recent op het startscherm niet volloopt. */
function lastMonth(): string {
	const d = new Date();
	d.setDate(1);
	d.setMonth(d.getMonth() - 1);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Vorige maand een uitgave in Boodschappen met een verwerkte bon en regels, en één zonder bon. */
function groceries(): { receipt: string; shop: string; top: string; month: string } {
	const db = new Database('.e2e/budget.db', { fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	const one = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T;
	const account = one<{ id: string }>("SELECT id FROM accounts WHERE alias = 'sns'").id;
	const category = one<{ id: string }>("SELECT id FROM categories WHERE name = 'Boodschappen'").id;
	const tag = randomUUID().slice(0, 6);
	const shop = `Proefsuper ${tag}`;
	const top = `Grote kaas ${tag}`;
	// Groot genoeg om bovenaan de duurste regels te staan, ook naast eerdere runs
	const big = 60_000 + Math.floor(Math.random() * 30_000);
	const month = lastMonth();
	const date = `${month}-05`;
	const insertTx = db.prepare(
		`INSERT INTO transactions (id, amount_cents, date, counterparty, category_id, account_id, source)
		 VALUES (?, ?, ?, ?, ?, ?, 'handmatig')`
	);
	const tx = randomUUID();
	const total = big + 249 + 119 - 50;
	insertTx.run(tx, -total, date, shop, category, account);
	insertTx.run(randomUUID(), -2000, date, `Zonder bon ${tag}`, category, account);
	// Een limiet, zodat Boodschappen als balk op Budget staat
	db.prepare(
		`INSERT INTO budgets (id, month, category_id, limit_cents) VALUES (?, ?, ?, 40000)
		 ON CONFLICT (month, category_id) DO NOTHING`
	).run(randomUUID(), date.slice(0, 7), category);

	const receipt = randomUUID();
	const lines = [
		{ description: top, cents: big, kind: 'artikel', group: 'zuivel_eieren' },
		{ description: `Appels ${tag}`, cents: 249, kind: 'artikel', group: 'groente_fruit' },
		{ description: `Chips ${tag}`, cents: 119, kind: 'artikel', group: 'snacks_snoep' },
		{ description: `Bonus ${tag}`, cents: -50, kind: 'bonus', group: null }
	];
	db.prepare(
		`INSERT INTO receipts (id, file_id, source, status, checked_fields, field_confidence, read_at,
			transaction_id, handled_at)
		 VALUES (?, ?, 'app', 'zeker', ?, ?, datetime('now'), ?, datetime('now'))`
	).run(
		receipt,
		randomUUID(),
		JSON.stringify({
			store: shop,
			date,
			totalCents: total,
			currency: 'EUR',
			paymentMethod: 'pin',
			lines,
			linesSumCents: total
		}),
		JSON.stringify(
			Object.fromEntries(
				['winkel', 'datum', 'totaal', 'valuta', 'betaalwijze'].map((f) => [
					f,
					{ status: 'zeker', model: 'zeker', note: '', failures: [], corrected: false }
				])
			)
		),
		tx
	);
	const insertLine = db.prepare(
		`INSERT INTO receipt_lines (id, receipt_id, position, description, kind, amount_cents, product_group)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	);
	lines.forEach((l, i) =>
		insertLine.run(randomUUID(), receipt, i, l.description, l.kind, l.cents, l.group)
	);
	db.close();
	return { receipt, shop, top, month };
}

test('van Boodschappen op Budget naar de verdeling per productgroep', async ({ page }) => {
	const { receipt, top, month } = groceries();
	await page.goto(`/budget?maand=${month}`);
	await page.getByRole('main').getByRole('link', { name: 'Per productgroep' }).first().click();
	await expect(page).toHaveURL(new RegExp(`/analyses/boodschappen\\?maand=${month}$`));

	const main = page.getByRole('main');
	await expect(main.getByRole('heading', { level: 1 })).toContainText('Boodschappen');
	// Terug naar Budget, bovenaan
	await expect(main.locator('[data-back]')).toHaveText(/Budget/);
	// De dekking in woorden: niet alles heeft een bon met regels
	await expect(
		main.getByText(/^\d+% van je boodschappen in \p{L}+ heeft een bon met regels\.$/u)
	).toBeVisible();

	// De verdeling als lijst, met de korting als één regel en het totaal
	const groups = main.getByRole('list', { name: 'Boodschappen per productgroep' });
	await expect(groups.getByRole('listitem').filter({ hasText: 'Zuivel en eieren' })).toBeVisible();
	await expect(groups.getByRole('listitem').filter({ hasText: 'Groente en fruit' })).toBeVisible();
	await expect(groups.getByRole('listitem').filter({ hasText: /Korting/ })).toContainText('−');
	await expect(groups.getByRole('listitem').filter({ hasText: 'Totaal op bonnen' })).toBeVisible();

	// De duurste regel staat bovenaan de duurste regels en leidt naar de bon
	const topList = main.getByRole('region', { name: 'Duurste regels' });
	const row = topList.getByRole('link').filter({ hasText: top });
	await expect(row).toContainText('Zuivel en eieren');
	await row.click();
	await expect(page).toHaveURL(new RegExp(`/bonnen/${receipt}$`));
});

test('een productgroep aanpassen op de bon', async ({ page }) => {
	const { receipt, top } = groceries();
	await page.goto(`/bonnen/${receipt}`);
	const main = page.getByRole('main');
	const toggle = main.getByRole('button', { name: /Regels/ });
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');

	// Een bonus heeft geen groep; een artikel wel
	await expect(main.getByRole('combobox', { name: /^Productgroep van Bonus/ })).toHaveCount(0);
	const select = main.getByRole('combobox', { name: `Productgroep van ${top}: Zuivel en eieren` });
	await select.click();
	await page.getByRole('option', { name: 'Kant-en-klaar', exact: true }).click();
	await expect(page.getByText('Groep aangepast.')).toBeVisible();
	await expect(
		main.getByRole('combobox', { name: `Productgroep van ${top}: Kant-en-klaar` })
	).toBeVisible();
	expect(
		value<string>(
			'SELECT product_group AS v FROM receipt_lines WHERE receipt_id = ? AND position = 0',
			receipt
		)
	).toBe('kant_en_klaar');
});

test('een maand zonder boodschappen heeft een lege staat met een volgende stap', async ({
	page
}) => {
	await page.goto('/analyses/boodschappen?maand=2001-01');
	const main = page.getByRole('main');
	await expect(main.getByText('Geen boodschappen in januari.')).toBeVisible();
	await expect(main.getByRole('link', { name: 'Bon toevoegen' })).toHaveAttribute(
		'href',
		'/bonnen'
	);
});
