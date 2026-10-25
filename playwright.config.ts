import { defineConfig, devices } from '@playwright/test';

// E2E tegen de gebouwde app (`pnpm build` eerst), met een eigen database per run.
const PORT = 4173;
const HAIKU_PORT = 4199;
export const E2E_DB = '.e2e/budget.db';

export default defineConfig({
	testDir: 'tests/e2e',
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
	use: {
		baseURL: `http://localhost:${PORT}`,
		trace: 'retain-on-failure',
		locale: 'nl-NL',
		timezoneId: 'Europe/Amsterdam'
	},
	projects: [
		{ name: 'chromium', use: { ...devices['Pixel 7'] } },
		// Tests met de tag @chromium draaien alleen in Chromium (virtuele passkeys via CDP,
		// één bundelmeting). Filteren per project in plaats van overslaan in de test zelf.
		{ name: 'webkit', use: { ...devices['iPhone 14'] }, grepInvert: /@chromium/ }
	],
	webServer: [
		{
			// Nagebootste Haiku: de bonlezer gaat hierheen in plaats van naar de echte API
			command: `node tests/e2e/haiku-mock.mjs`,
			url: `http://127.0.0.1:${HAIKU_PORT}/healthz`,
			reuseExistingServer: false,
			env: { HAIKU_MOCK_PORT: String(HAIKU_PORT) }
		},
		{
			// Elke run een verse database
			command: 'rm -rf .e2e && mkdir -p .e2e && node build',
			url: `http://localhost:${PORT}/healthz`,
			reuseExistingServer: false,
			env: {
				PORT: String(PORT),
				HOST: '127.0.0.1',
				ORIGIN: `http://localhost:${PORT}`,
				COOKIE_SECURE: 'false',
				DATABASE_PATH: E2E_DB,
				LOG_LEVEL: 'warn',
				TZ: 'Europe/Amsterdam',
				// Geen echte sleutel: alleen de nagebootste Haiku hieronder neemt hem aan
				ANTHROPIC_API_KEY: 'e2e-nagebootst',
				ANTHROPIC_BASE_URL: `http://127.0.0.1:${HAIKU_PORT}`
			}
		}
	]
});
