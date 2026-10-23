import { defineConfig, devices } from '@playwright/test';

// E2E tegen de gebouwde app (`pnpm build` eerst), met een eigen database per run.
const PORT = 4173;
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
		{ name: 'webkit', use: { ...devices['iPhone 14'] } }
	],
	webServer: {
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
			TZ: 'Europe/Amsterdam'
		}
	}
});
