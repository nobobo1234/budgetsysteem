import { z } from 'zod';

// Runtime-configuratie uit de omgeving. Geheimen staan nooit in de repo (CLAUDE.md).
const schema = z.object({
	NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
	DATABASE_PATH: z.string().min(1).default('data/budget.db'),
	// Aparte telemetrie-database; standaard `telemetry.db` naast DATABASE_PATH
	TELEMETRY_DATABASE_PATH: z.string().min(1).optional(),
	MIGRATIONS_DIR: z.string().min(1).default('drizzle'),
	// Publieke origin, zoals https://finance.mijndomein.nl
	ORIGIN: z.url().optional(),
	// Relying party ID voor passkeys; standaard de host van ORIGIN
	RP_ID: z.string().min(1).optional(),
	// Zet op "false" alleen voor lokale ontwikkeling over http
	COOKIE_SECURE: z
		.enum(['true', 'false'])
		.default('true')
		.transform((v) => v === 'true'),
	// Externe beschikbaarheidscheck: de app pingt deze URL elke paar minuten en de dienst
	// slaat alarm als dat uitblijft. Bevat een geheim (staat alleen in de omgeving op de VPS).
	HEALTHCHECK_PING_URL: z.url({ protocol: /^https$/ }).optional(),
	LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')
});

export type Config = z.infer<typeof schema> & { rpId: string; origin: string };

let cached: Config | undefined;

export function config(): Config {
	if (cached) return cached;
	const parsed = schema.parse(process.env);
	const origin = parsed.ORIGIN ?? 'http://localhost:5173';
	cached = { ...parsed, origin, rpId: parsed.RP_ID ?? new URL(origin).hostname };
	return cached;
}

/** Alleen voor tests. */
export function resetConfig(): void {
	cached = undefined;
}
