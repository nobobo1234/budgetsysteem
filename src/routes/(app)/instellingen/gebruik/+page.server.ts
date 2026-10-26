import { telemetryDb } from '#lib/server/telemetry/index.ts';
import { usageSummary } from '#lib/server/telemetry/usage.ts';
import type { PageServerLoad } from './$types';

// Je eigen gebruik, alleen voor jezelf: dagen met invoer per week, je reeks en de tijd van
// openen tot opslaan. Alleen tellingen en tijden.
export const load: PageServerLoad = () => ({ usage: usageSummary(telemetryDb()) });
