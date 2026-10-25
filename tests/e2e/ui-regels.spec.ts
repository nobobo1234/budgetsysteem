import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { MEER_PAGES } from '../../src/lib/morph.ts';
import { TABS } from '../../src/lib/nav.ts';
import { login } from './helpers.ts';

// Spec: Klaar voor UI. Regels die voor elk scherm gelden, zodat een nieuw scherm ze niet vergeet.

test.beforeEach(async ({ context }) => {
	await login(context);
});

/** Een transactie en een vaste last, zodat ook de detailpagina's meedoen. */
function details(): { tx: string; recurring: string } {
	const db = new Database('.e2e/budget.db', { fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	const account = (
		db.prepare("SELECT id FROM accounts WHERE alias = 'sns'").get() as { id: string }
	).id;
	const tx = randomUUID();
	const recurring = randomUUID();
	const name = `Regels ${randomUUID().slice(0, 6)}`;
	db.prepare(
		`INSERT INTO transactions (id, amount_cents, date, counterparty, account_id, source, status)
		 VALUES (?, -1234, date('now', '-3 days'), ?, ?, 'handmatig', 'bevestigd')`
	).run(tx, name, account);
	db.prepare(
		`INSERT INTO recurring (id, match_key, counterparty, interval, expected_day, median_cents,
			min_cents, max_cents, kind, next_date, account_id, status)
		 VALUES (?, ?, ?, 'maand', 3, 1234, 1234, 1234, 'vast', date('now', '+20 days'), ?, 'actief')`
	).run(recurring, `${name.toLowerCase()}|`, name, account);
	db.close();
	return { tx, recurring };
}

/** Alle schermen achter de login; subpagina's zonder eigen tab apart. */
function routes(ids: { tx: string; recurring: string }) {
	const sub = [
		...MEER_PAGES,
		'/te-controleren',
		`/transacties/${ids.tx}`,
		`/vaste-lasten/${ids.recurring}`
	] as string[];
	return { tabs: [...TABS] as string[], sub };
}

// Een link naar een lijst of pagina is een Meer-link, kaart, tegel of rij; een onderstreepte
// link mag alleen midden in een zin staan (in een alinea of een definitie).
async function bareLinks(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		[...document.querySelectorAll<HTMLAnchorElement>('main a[href]')]
			.filter((a) => !a.closest('p, dd, figcaption'))
			.filter((a) => getComputedStyle(a).textDecorationLine.includes('underline'))
			.map((a) => `${a.textContent?.trim()} -> ${a.getAttribute('href')}`)
	);
}

test('elke pagina zonder eigen tab heeft bovenaan een terugknop', async ({ page }) => {
	const { sub } = routes(details());
	for (const path of sub) {
		await page.goto(path);
		const main = page.getByRole('main');
		const back = main.locator('[data-back]');
		await expect(back, path).toHaveCount(1);
		// Bovenaan: boven de paginatitel
		const [b, h] = await Promise.all([
			back.boundingBox(),
			main.getByRole('heading', { level: 1 }).boundingBox()
		]);
		expect(b!.y, path).toBeLessThan(h!.y);
	}
});

test('een pagina met een tegel op Meer heeft een kop die meeschuift', async ({ page }) => {
	for (const path of MEER_PAGES) {
		await page.goto(path);
		await expect(
			page.getByRole('heading', { level: 1 }).and(page.locator('[data-morph-head="titel"]')),
			path
		).toHaveCount(1);
	}
});

test('geen kale links als navigatie', async ({ page }) => {
	const { tabs, sub } = routes(details());
	for (const path of [...tabs, ...sub]) {
		await page.goto(path);
		expect(await bareLinks(page), path).toEqual([]);
	}
});
