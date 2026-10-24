import { defineConfig } from 'drizzle-kit';

// Aparte telemetrie-database: `pnpm exec drizzle-kit generate --config drizzle.telemetry.config.ts`
export default defineConfig({
	dialect: 'sqlite',
	schema: './src/lib/server/telemetry/schema.ts',
	out: './drizzle/telemetry'
});
