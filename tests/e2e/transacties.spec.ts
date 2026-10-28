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

/** Genoeg uitgaven op één dag met een eigen naam, zodat de lijst ook gefilterd langer is dan het scherm. */
function longDay(date: string): string {
	const db = new Database('.e2e/budget.db', { fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	const account = (
		db.prepare("SELECT id FROM accounts WHERE alias = 'sns'").get() as { id: string }
	).id;
	const name = `Blijf ${test.info().project.name} ${randomUUID().slice(0, 4)}`;
	const insert = db.prepare(
		`INSERT INTO transactions (id, amount_cents, date, counterparty, account_id, source)
		 VALUES (?, -350, ?, ?, ?, 'handmatig')`
	);
	for (let i = 0; i < 30; i++) insert.run(randomUUID(), date, name, account);
	db.close();
	return name;
}

/** Scrollpositie nadat de navigatie klaar is en SvelteKit scroll en focus had kunnen herstellen. */
const settledScroll = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<number>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(scrollY))))
			)
	);

test('transacties: zoeken laat scroll en focus staan', async ({ page }) => {
	const name = longDay(day(-2));
	await page.goto('/transacties');
	await page.waitForLoadState('networkidle');
	await page.evaluate(() => scrollTo(0, 60));
	const before = await settledScroll(page);
	expect(before).toBe(60);

	const search = page.getByRole('searchbox', { name: 'Zoeken' });
	await search.fill(name);
	await search.press('Enter');
	await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(name).replace(/%20/g, '\\+')}`));
	await expect(page.locator('.summary')).toContainText('30 transacties');

	expect(await settledScroll(page)).toBe(before);
	await expect(search).toBeFocused();
});

test('staafdiagram: een tik op een dag laat scroll en focus staan', async ({ page }) => {
	const date = day(-2);
	longDay(date);
	await page.goto(`/transacties?maand=${date.slice(0, 7)}`);
	await page.waitForLoadState('networkidle');
	const chart = page.getByRole('group', { name: /Uitgaven per dag/ });
	await page.evaluate(() =>
		scrollTo(0, scrollY + document.querySelector('.chart')!.getBoundingClientRect().top - 40)
	);
	const before = await settledScroll(page);
	expect(before).toBeGreaterThan(0);

	// Een tik: de scroll blijft staan
	const bar = chart.getByRole('link', { name: new RegExp(`^${Number(date.slice(8))} `) });
	await bar.tap();
	await expect(page).toHaveURL(new RegExp(`dag=${date}`));
	await expect(bar).toHaveAttribute('aria-current', 'true');
	expect(await settledScroll(page)).toBe(before);

	// Met het toetsenbord: de focus blijft op de staaf (een tik geeft in Safari geen focus)
	await bar.focus();
	await bar.press('Enter');
	await expect(page).not.toHaveURL(/dag=/);
	await expect(bar).not.toHaveAttribute('aria-current');
	expect(await settledScroll(page)).toBe(before);
	await expect(bar).toBeFocused();
});

test('staafdiagram: elke staaf even breed en op dezelfde lijn, ook met een label', async ({
	page
}) => {
	const month = day(0).slice(0, 7);
	const db = new Database('.e2e/budget.db', { fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	const account = (
		db.prepare("SELECT id FROM accounts WHERE alias = 'sns'").get() as { id: string }
	).id;
	// Uitgaven op dagen met een label (1, 15, 22) en zonder (2, 16)
	for (const d of ['01', '02', '15', '16', '22'])
		db.prepare(
			`INSERT INTO transactions (id, amount_cents, date, counterparty, account_id, source)
			 VALUES (?, -1500, ?, 'Staaf', ?, 'handmatig')`
		).run(randomUUID(), `${month}-${d}`, account);
	db.close();

	await page.goto(`/transacties?maand=${month}`);
	await page.waitForLoadState('networkidle');
	const tracks = await page
		.getByRole('group', { name: /Uitgaven per dag/ })
		.locator('.track')
		.evaluateAll((els) =>
			els.map((el) => {
				const r = el.getBoundingClientRect();
				return { width: Math.round(r.width * 10) / 10, bottom: Math.round(r.bottom * 10) / 10 };
			})
		);
	expect(tracks.length).toBeGreaterThanOrEqual(28);
	expect(new Set(tracks.map((t) => t.width)).size).toBe(1);
	expect(new Set(tracks.map((t) => t.bottom)).size).toBe(1);
});

test('transacties: een interne overboeking staat als één rij', async ({ page }) => {
	const date = day(-1);
	const db = new Database('.e2e/budget.db', { fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	const account = (alias: string) =>
		(db.prepare('SELECT id FROM accounts WHERE alias = ?').get(alias) as { id: string }).id;
	// Een eigen bedrag per project en poging, zodat paren van eerdere runs niet meedoen
	const cents = 10_000 + Math.floor(Math.random() * 89_999);
	const out = randomUUID();
	const inc = randomUUID();
	const insert = db.prepare(
		`INSERT INTO transactions (id, amount_cents, date, counterparty, account_id, source, category_source)
		 VALUES (?, ?, ?, ?, ?, 'import', 'intern')`
	);
	insert.run(out, -cents, date, 'Revolut', account('sns'));
	insert.run(inc, cents, date, 'Geld toevoegen', account('rev'));
	db.close();

	await page.goto(`/transacties?van=${date}&tot=${date}`);
	await page.waitForLoadState('networkidle');
	const row = page.locator(`[data-tx-row="${out}"]`);
	await expect(row).toContainText('SNS');
	await expect(row).toContainText('Revolut');
	await expect(row).toContainText('overgeboekt');
	await expect(page.locator(`[data-tx-row="${inc}"]`)).toHaveCount(0);

	// De detailpagina wijst naar de andere kant
	await row.getByRole('link').click();
	await expect(page).toHaveURL(new RegExp(`/transacties/${out}`));
	const section = page.getByRole('region', { name: 'Overgeboekt' });
	await expect(section.getByRole('link', { name: /Binnen op Revolut/ })).toHaveAttribute(
		'href',
		`/transacties/${inc}`
	);
});

/** `n` transacties met een eigen naam per project en poging, elk op een eigen dag in 2019. */
function manyRows(n: number): { prefix: string; ids: string[] } {
	const db = new Database('.e2e/budget.db', { fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	const account = (
		db.prepare("SELECT id FROM accounts WHERE alias = 'sns'").get() as { id: string }
	).id;
	const prefix = `Bijladen ${test.info().project.name} ${randomUUID().slice(0, 4)}`;
	const insert = db.prepare(
		`INSERT INTO transactions (id, amount_cents, date, counterparty, account_id, source, status)
		 VALUES (?, -100, ?, ?, ?, 'import', ?)`
	);
	const ids = Array.from({ length: n }, (_, i) => {
		const id = randomUUID();
		const date = new Date(Date.UTC(2019, 11, 31 - i)).toISOString().slice(0, 10);
		const status = i === 60 ? 'te_controleren' : 'bevestigd';
		insert.run(id, date, `${prefix} ${String(i).padStart(3, '0')}`, account, status);
		return id;
	});
	db.close();
	return { prefix, ids };
}

test('transacties: laadt per 50 bij en houdt dat vast bij vegen en terug', async ({ page }) => {
	const { prefix, ids } = manyRows(120);
	await page.goto(`/transacties?q=${encodeURIComponent(prefix)}`);
	await page.waitForLoadState('networkidle');
	const rows = page.locator('[data-tx-row]');
	await expect(rows).toHaveCount(50);
	await expect(page.getByText('50 van 120')).toBeVisible();

	// Naar beneden scrollen laadt automatisch de volgende 50, en het aantal komt in de URL
	await page.getByRole('link', { name: 'Ouder · nog 70' }).scrollIntoViewIfNeeded();
	await expect(rows).toHaveCount(100);
	await expect(page).toHaveURL(/aantal=100/);

	// Een veeg ververst de lijst, maar houdt de 100
	const review = page.locator(`[data-tx-row="${ids[60]}"]`);
	await review.scrollIntoViewIfNeeded();
	await swipe(page, review, 140);
	await expect(page.getByRole('status').filter({ hasText: 'bevestigd.' })).toBeVisible();
	await expect(rows).toHaveCount(100);

	// Naar de detailpagina en terug: dezelfde rijen, en de rij weer in beeld
	const target = page.locator(`[data-tx-row="${ids[55]}"]`);
	await target.getByRole('link').click();
	await expect(page).toHaveURL(new RegExp(`/transacties/${ids[55]}`));
	// Eerst de detailpagina helemaal laten staan; WebKit slaat een terug tijdens de overgang over
	await expect(page.getByRole('heading', { level: 1, name: `${prefix} 055` })).toBeVisible();
	await page.goBack();
	await expect(page).toHaveURL(/aantal=100/);
	await expect(rows).toHaveCount(100);
	await expect(target).toBeInViewport();

	// Een nieuwe zoekopdracht begint weer bij 50
	const search = page.getByRole('searchbox', { name: 'Zoeken' });
	await search.fill(prefix);
	await search.press('Enter');
	await expect(page).not.toHaveURL(/aantal=/);
	await expect(rows).toHaveCount(50);

	// Tot het einde: geen knop meer
	await page.getByRole('link', { name: /Ouder/ }).scrollIntoViewIfNeeded();
	await expect(rows).toHaveCount(100);
	await page.getByRole('link', { name: /Ouder/ }).scrollIntoViewIfNeeded();
	await expect(rows).toHaveCount(120);
	await expect(page.getByRole('link', { name: /Ouder/ })).toHaveCount(0);
	await expect(page.getByText('120 van 120')).toBeVisible();
});
