import { expect, test } from '@playwright/test';
import { count, countTelemetry, login } from './helpers.ts';

test.beforeEach(async ({ context }) => {
	await login(context);
});

test('snelinvoer: chips tijdens het typen, opslaan en meteen in de lijst', async ({ page }) => {
	await page.goto('/');
	const input = page.getByLabel('Snel invoeren');
	await input.fill('12,50 ah gisteren');
	const chips = page.locator('#quick-chips');
	await expect(chips).toContainText('12,50');
	await expect(chips).toContainText('Albert Heijn');
	// Eigen select (knop met rol combobox): de regel heeft een categorie gekozen
	await expect(page.getByRole('combobox', { name: 'Categorie' })).not.toHaveText('Geen categorie');

	await page.getByRole('button', { name: 'Opslaan' }).click();
	await expect(input).toHaveValue('');
	const recent = page.getByRole('region', { name: 'Recent' });
	await expect(recent).toContainText('Albert Heijn');
	await expect(recent).not.toContainText('Wordt opgeslagen');

	await page.reload();
	await expect(page.getByRole('region', { name: 'Recent' })).toContainText('Albert Heijn');
});

test('offline invoeren en synchroniseren zodra er verbinding is', async ({ page, context }) => {
	await page.goto('/');
	// Pas offline als de app gehydrateerd is; de chunks moeten binnen zijn
	await page.waitForLoadState('networkidle');
	const before = count(
		"SELECT count(*) AS n FROM transactions WHERE counterparty = 'Offline Bakker'"
	);

	await context.setOffline(true);
	await page.getByLabel('Snel invoeren').fill('3,10 Offline Bakker');
	await page.getByRole('button', { name: 'Opslaan' }).click();
	await expect(page.getByText('Wordt opgeslagen')).toBeVisible();
	await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible();
	expect(
		count("SELECT count(*) AS n FROM transactions WHERE counterparty = 'Offline Bakker'")
	).toBe(before);

	await context.setOffline(false);
	await page.evaluate(() => window.dispatchEvent(new Event('online')));
	await expect(page.getByText('Wordt opgeslagen')).toHaveCount(0);
	await expect
		.poll(() =>
			count("SELECT count(*) AS n FROM transactions WHERE counterparty = 'Offline Bakker'")
		)
		.toBe(before + 1);
});

test('import: overzicht, en dezelfde export opnieuw levert niets dubbel op', async ({ page }) => {
	await page.goto('/import');
	await page.getByLabel('Bankbestand').setInputFiles('tests/fixtures/camt053-v02.xml');
	await page.getByRole('button', { name: 'Importeren' }).click();
	const result = page.getByRole('status').filter({ hasText: 'Import klaar' });
	await expect(result).toBeVisible();
	const first = Number(await result.locator('dd').first().textContent());

	await page.getByLabel('Bankbestand').setInputFiles('tests/fixtures/camt053-v02.xml');
	await page.getByRole('button', { name: 'Importeren' }).click();
	await expect(result.locator('dd').first()).toHaveText('0');
	await expect(result.locator('dd').nth(1)).toHaveText(String(first === 0 ? 5 : first));

	// Eén klik maakt een regel. De projecten delen één database, dus elk een eigen tegenpartij.
	const [name, pattern] =
		test.info().project.name === 'chromium'
			? ['ALBERT HEIJN 1403 UTRECHT', 'albert heijn utrecht']
			: ['Spotify AB', 'spotify ab'];
	const row = page.getByRole('listitem').filter({ hasText: name });
	// Eigen select: de knop opent een lijst; het zoekveld in die lijst is ook een combobox
	const select = row.getByRole('combobox', { name: `Categorie voor ${name}`, exact: true });
	await select.click();
	await page.getByRole('option', { name: 'Boodschappen', exact: true }).click();
	await expect(select).toHaveText('Boodschappen');
	await row.getByRole('button', { name: 'Regel maken' }).click();
	await expect(page.getByText(`Regel voor "${pattern}" gemaakt`)).toBeVisible();
});

test('budget instellen en zien wat er nog vrij is', async ({ page }) => {
	await page.goto('/budget');
	const item = page.getByRole('listitem').filter({ has: page.getByLabel('Limiet Boodschappen') });
	await item.getByLabel('Limiet Boodschappen').fill('300');
	await item.getByRole('button', { name: 'Opslaan' }).click();
	await expect(item.getByRole('meter')).toBeVisible();

	await page.goto('/');
	await expect(page.getByRole('region', { name: /Nog vrij in/ })).toBeVisible();
});

test('transacties zoeken', async ({ page }) => {
	await page.goto('/transacties?q=Albert');
	await expect(page.getByRole('list').first()).toContainText('Albert');
	await page.getByRole('searchbox', { name: 'Zoeken' }).fill('bestaat-zeker-niet');
	await page.getByRole('button', { name: 'Zoeken' }).click();
	await expect(page.getByText(/Niets gevonden/)).toBeVisible();
});

// Een te breed element laat een telefoon de hele pagina uitzoomen
for (const path of [
	'/',
	'/transacties',
	'/budget',
	'/import',
	'/categorieen',
	'/regels',
	'/instellingen',
	'/instellingen/status',
	'/saldocheck'
]) {
	test(`${path} past op een telefoonscherm`, async ({ page }) => {
		await page.goto(path);
		const { inner, scroll } = await page.evaluate(() => ({
			inner: document.documentElement.clientWidth,
			scroll: document.documentElement.scrollWidth
		}));
		expect(scroll).toBeLessThanOrEqual(inner);
	});

	// Spec: Klaar voor UI. Keuzes gaan via de eigen Select, nooit via een native <select>.
	test(`${path} gebruikt geen native select`, async ({ page }) => {
		await page.goto(path);
		await expect(page.locator('select')).toHaveCount(0);
	});
}

// Regel maken met alleen de eigen selects: veld kiezen, categorie zoeken door te typen. Op
// telefoonformaat is de keuzelijst een sheet, op desktop een uitklaplijst: beide testen.
for (const [size, viewport] of [
	['telefoon', null],
	['desktop', { width: 1280, height: 800 }]
] as const) {
	test(`regel toevoegen via de selects op /regels (${size})`, async ({ page }) => {
		if (viewport) await page.setViewportSize(viewport);
		await page.goto('/regels');
		await page.getByRole('button', { name: 'Nieuwe regel' }).click();
		const field = page.getByRole('combobox', { name: 'Veld', exact: true });
		await field.click();
		// De lijst heeft echt hoogte: alle opties staan erin en zijn zichtbaar
		const listbox = page.getByRole('listbox', { name: 'Veld' });
		await expect(listbox.getByRole('option')).toHaveCount(3);
		expect((await listbox.boundingBox())!.height).toBeGreaterThan(3 * 40);
		await page.getByRole('option', { name: 'Omschrijving bevat' }).click();
		await expect(field).toHaveText('Omschrijving bevat');

		const pattern = `e2e-${size}-${test.info().project.name}`;
		await page.getByRole('textbox', { name: 'Patroon' }).fill(pattern);
		const category = page.getByRole('combobox', { name: 'Categorie', exact: true });
		await category.click();
		const search = page.getByRole('combobox', { name: 'Zoek in Categorie' });
		await search.click();
		await search.pressSequentially('boods');
		// Tijdens het typen blijven de passende opties zichtbaar
		const option = page.getByRole('option', { name: 'Boodschappen', exact: true });
		await expect(option).toBeVisible();
		expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(40);
		await option.click();
		await expect(category).toHaveText('Boodschappen');

		await page.getByRole('button', { name: 'Regel toevoegen' }).click();
		await expect(page.getByRole('status').filter({ hasText: 'Regel opgeslagen' })).toBeVisible();
		await expect(page.locator('.rules')).toContainText(pattern);
	});
}

// Schermwissel met View Transitions (spec: Beweging): de navigatie komt altijd aan, ook met
// gedeelde elementen tussen de lijst en de detailpagina
test('van de lijst naar een transactie en terug', async ({ page }) => {
	await page.goto('/transacties');
	await page.waitForLoadState('networkidle');
	const row = page.locator('.days a').first();
	const name = (await row.locator('[data-tx-name]').textContent())!.trim();
	await row.click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
	await page.getByRole('link', { name: 'Transacties' }).first().click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Transacties');
	// Na de overgang blijven er geen namen op de rijen achter
	await expect(page.locator('[data-tx-name][style*="view-transition-name"]')).toHaveCount(0);
});

// Performance-budget (spec: Design en interactie, Techniek): eerste JS-bundel onder 100 kB gzip.
// Eén meting is genoeg, dus alleen in Chromium.
test(
	'de eerste JavaScript-bundel blijft onder 100 kB gzip',
	{ tag: '@chromium' },
	async ({ page }) => {
		const { gzipSync } = await import('node:zlib');
		const bodies: Promise<Buffer>[] = [];
		page.on('response', (r) => {
			if (r.request().resourceType() === 'script' || r.url().endsWith('.js')) bodies.push(r.body());
		});
		await page.goto('/');
		await page.waitForLoadState('networkidle');
		const sizes = await Promise.all(bodies);
		const total = sizes.reduce((sum, b) => sum + gzipSync(b).length, 0);
		console.log(
			`Eerste JS-bundel: ${(total / 1024).toFixed(1)} kB gzip in ${sizes.length} bestanden`
		);
		expect(total).toBeLessThan(100 * 1024);
	}
);

// Web-vitals worden na de eerste weergave geladen, gaan bij het verlaten van de pagina naar
// /api/vitals en staan daarna als p75 per week op de statuspagina.
test('web-vitals komen op de statuspagina', async ({ page }) => {
	const before = countTelemetry('SELECT count(*) AS n FROM web_vitals');
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	// requestIdleCallback heeft een timeout van 3 s; zonder (WebKit) is het 1 s
	await page.waitForTimeout(3500);
	await page.goto('/budget');
	await expect
		.poll(() => countTelemetry('SELECT count(*) AS n FROM web_vitals'))
		.toBeGreaterThan(before);

	await page.goto('/instellingen');
	await page.getByRole('link', { name: 'Status' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Status');
	await expect(page.getByRole('heading', { name: 'Backups' })).toBeVisible();
	const vitals = page.getByRole('table');
	await expect(vitals).toBeVisible();
	await expect(vitals.getByRole('row')).not.toHaveCount(1);

	// Met de tabel erop past de pagina ook op het smalste scherm (375 px)
	await page.setViewportSize({ width: 375, height: 812 });
	const { inner, scroll } = await page.evaluate(() => ({
		inner: document.documentElement.clientWidth,
		scroll: document.documentElement.scrollWidth
	}));
	expect(scroll).toBeLessThanOrEqual(inner);
});
