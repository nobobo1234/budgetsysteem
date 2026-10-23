// TER REVIEW (Noah): inloggen met een virtuele passkey.
import { expect, test } from '@playwright/test';
import { setupToken } from './helpers.ts';

test('eerste passkey via setup-token, uitloggen en weer inloggen', async ({
	page,
	browserName
}) => {
	test.skip(browserName !== 'chromium', 'Virtuele authenticators bestaan alleen via Chromium-CDP');

	const cdp = await page.context().newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true
		}
	});

	await page.goto('/setup');
	await page.getByLabel('Setup-token').fill(setupToken());
	await page.getByRole('button', { name: 'Passkey aanmaken' }).click();
	await expect(page.getByRole('heading', { name: 'Schrijf je herstelcode op' })).toBeVisible();
	await expect(page.locator('.code')).toHaveText(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);

	// Een gebruikt setup-token werkt niet nog een keer
	await page.getByRole('link', { name: 'Ik heb hem opgeschreven' }).click();
	await expect(page.getByLabel('Snel invoeren')).toBeVisible();

	await page.goto('/instellingen');
	await page.getByRole('button', { name: 'Uitloggen' }).click();
	await expect(page).toHaveURL(/\/login\?uitgelogd=1$/);

	await page.goto('/');
	await expect(page).toHaveURL(/\/login$/);

	await page.getByRole('button', { name: 'Inloggen met passkey' }).click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByLabel('Snel invoeren')).toBeVisible();
});

test('een onbekende passkey komt er niet in', async ({ page, browserName }) => {
	test.skip(browserName !== 'chromium', 'Virtuele authenticators bestaan alleen via Chromium-CDP');
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true
		}
	});
	await page.goto('/login');
	await page.getByRole('button', { name: 'Inloggen met passkey' }).click();
	await expect(page.getByRole('alert')).not.toBeEmpty();
	await expect(page).toHaveURL(/\/login$/);
});
