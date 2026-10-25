import type { Health } from './health.ts';

// Wat op de statuspagina aandacht vraagt. Alleen weergave: meldingen bij een te oude backup of
// een volle schijf horen bij de pushmeldingen.

/** Een backup die ouder is dan een dag (met wat speling voor de dagelijkse timer). */
export const BACKUP_MAX_AGE_SECONDS = 25 * 3600;
/** Boven 80% schijfgebruik (spec: Telemetrie en monitoring). */
export const DISK_MAX_USED_PERCENT = 80;

export function attention(h: Health): string[] {
	const out: string[] = [];
	if (!h.database) out.push('De database is niet bereikbaar.');
	const backups = [
		['Litestream-replicatie', h.backups.litestreamAgeSeconds],
		['restic-backup', h.backups.resticAgeSeconds]
	] as const;
	for (const [name, age] of backups) {
		if (age === null) out.push(`Geen ${name} gevonden.`);
		else if (age > BACKUP_MAX_AGE_SECONDS) out.push(`De laatste ${name} is ouder dan een dag.`);
	}
	if (h.disk === null) out.push('Schijfruimte onbekend.');
	else if (h.disk.usedPercent > DISK_MAX_USED_PERCENT)
		out.push(`De schijf is voor meer dan ${DISK_MAX_USED_PERCENT}% vol.`);
	if (h.starts.restarts7d > 0)
		out.push(
			h.starts.restarts7d === 1
				? 'De app is deze week één keer herstart.'
				: `De app is deze week ${h.starts.restarts7d} keer herstart.`
		);
	if (h.errors.last24h > 0)
		out.push(
			h.errors.last24h === 1
				? 'Eén fout in de laatste 24 uur.'
				: `${h.errors.last24h} fouten in de laatste 24 uur.`
		);
	return out;
}
