import Database from 'better-sqlite3';
import { randomInt, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { login, value } from './helpers.ts';

// Koppellijst bij een bankimport: een boeking die je misschien al zelf invoerde, wacht in de
// review-inbox tot je kiest. Geanonimiseerd, met de test-IBAN van de eigen rekening.

test.beforeEach(async ({ context }) => {
	await login(context);
});

const iso = (daysAgo: number) =>
	new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
const sns = (isoDate: string) => isoDate.split('-').reverse().join('-');

/** Een eigen invoer, en een SNS-export met twee boekingen die er allebei op lijken. */
function seed() {
	// De projecten (en herhalingen) delen één database: eigen namen en volgnummers
	// Alleen letters: cijfers zou de nette naam (displayName) als filiaalnummer weglaten
	const letters = Array.from({ length: 5 }, () => String.fromCharCode(97 + randomInt(26)));
	const tag = `${test.info().project.name} ${letters.join('')}`;
	const date = iso(3);
	const db = new Database('.e2e/budget.db', { fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	const account = (
		db.prepare("SELECT id FROM accounts WHERE alias = 'sns'").get() as { id: string }
	).id;
	const own = randomUUID();
	db.prepare(
		`INSERT INTO transactions (id, amount_cents, date, counterparty, account_id, source, note)
		 VALUES (?, -4500, ?, ?, ?, 'handmatig', 'Etentje')`
	).run(own, date, `Café ${tag}`, account);
	db.close();
	const refs = { cafe: String(randomInt(10_000_000, 99_999_999)), kapper: '' };
	refs.kapper = String(Number(refs.cafe) + 1);
	// Kolommen zoals tests/fixtures/sns.csv, zonder saldo (dan geen startsaldo)
	const line = (name: string, amount: string, day: string, ref: string) =>
		[
			sns(day),
			'NL12SNSB0123456789',
			'',
			name,
			'EUR',
			'',
			'EUR',
			amount,
			sns(day),
			sns(day),
			'8810',
			'BEA',
			ref,
			'',
			`Betaalautomaat ${sns(day)}`,
			'1',
			''
		].join(',');
	const csv = [
		// €1 fooi: lijkt erop, maar niet duidelijk genoeg om vanzelf samen te voegen
		line(`Cafe ${tag}`, '-46.00', date, refs.cafe),
		// Zelfde bedrag een dag later bij een andere winkel: mogelijk, maar het is een nieuwe
		line(`Kapper ${tag}`, '-45.00', iso(2), refs.kapper)
	].join('\n');
	return { own, csv: Buffer.from(`${csv}\n`), tag };
}

async function importCsv(page: Page, csv: Buffer) {
	await page.goto('/import');
	await page
		.getByLabel('Bankbestand')
		.setInputFiles({ name: 'sns.csv', mimeType: 'text/csv', buffer: csv });
	await page.getByRole('button', { name: 'Importeren' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Import klaar' })).toBeVisible();
}

const idOf = (tag: string, name: string) =>
	value<string>(
		"SELECT id AS v FROM transactions WHERE counterparty = ? AND source = 'import'",
		`${name} ${tag}`
	)!;

test('import naar de review-inbox: samenvoegen met je invoer of een nieuwe transactie', async ({
	page
}) => {
	const { own, csv, tag } = seed();
	await importCsv(page, csv);

	// Het verslag zegt hoeveel er wachten, en leidt naar de review-inbox
	const waiting = page.getByRole('link', { name: /2 boekingen wachten op de koppellijst/ });
	await expect(waiting).toBeVisible();
	await waiting.click();
	await expect(page).toHaveURL(/\/te-controleren$/);

	const bookings = page.getByRole('main').getByRole('region', { name: 'Boekingen' });
	const item = (id: string) =>
		bookings.getByRole('listitem').filter({ has: page.locator(`a[href="/transacties/${id}"]`) });

	// De kapper hoort er niet bij: een nieuwe transactie
	const kapper = item(idOf(tag, 'Kapper'));
	await expect(kapper.getByText(/Al zelf ingevoerd\?/)).toBeVisible();
	const submit = kapper.getByRole('button', { name: /samenvoegen met je invoer/ });
	// Geen voorselectie zonder duidelijke voorsprong: eerst kiezen
	await expect(submit).toBeDisabled();
	await kapper.getByRole('radio', { name: /Nieuwe transactie/ }).check();
	await kapper.getByRole('button', { name: /bewaren als nieuwe transactie/ }).click();
	await expect(page.getByText(/staat als nieuwe transactie\./)).toBeVisible();
	await expect(kapper).toHaveCount(0);

	// Het café wel: de bank boekte €1 meer (fooi)
	const cafeId = idOf(tag, 'Cafe');
	const cafe = item(cafeId);
	// De projecten delen één database: er kan ook invoer van een ander project in de lijst staan
	const mine = cafe.getByRole('radio', { name: new RegExp(`Café ${tag}`, 'i') });
	await expect(mine).toHaveAccessibleName(/1,00 meer, zoals een fooi/);
	await expect(mine).toHaveAccessibleName(/Waarschijnlijk/);
	await expect(mine).not.toBeChecked();
	await mine.check();
	await cafe.getByRole('button', { name: /samenvoegen met je invoer/ }).click();
	await expect(page.getByText(/samengevoegd met je invoer\./)).toBeVisible();
	await expect(cafe).toHaveCount(0);

	// Eén transactie: je invoer met het bedrag en de referentie van de bank
	expect(value<number>('SELECT amount_cents AS v FROM transactions WHERE id = ?', own)).toBe(-4600);
	expect(value<string>('SELECT note AS v FROM transactions WHERE id = ?', own)).toBe('Etentje');
	expect(value<number>('SELECT count(*) AS v FROM transactions WHERE id = ?', cafeId)).toBe(0);

	// Op de detailpagina staat het verschil
	await page.goto(`/transacties/${own}`);
	await expect(page.getByText('1,00 meer (fooi of kosten)')).toBeVisible();
});

test('de koppellijst past op een telefoonscherm, zonder native select', async ({ page }) => {
	const { csv } = seed();
	await importCsv(page, csv);
	await page.setViewportSize({ width: 375, height: 812 });
	await page.goto('/te-controleren');
	await expect(page.getByRole('radio', { name: /Nieuwe transactie/ }).first()).toBeVisible();
	const { inner, scroll } = await page.evaluate(() => ({
		inner: document.documentElement.clientWidth,
		scroll: document.documentElement.scrollWidth
	}));
	expect(scroll).toBeLessThanOrEqual(inner);
	await expect(page.locator('select')).toHaveCount(0);
	// Met het toetsenbord: een keuzerondje kiezen en de knop bereiken
	const radio = page.getByRole('radio', { name: /Nieuwe transactie/ }).first();
	await radio.focus();
	await page.keyboard.press('Space');
	await expect(radio).toBeChecked();
});
