import { DISK_ALERT_PERCENT, RESTIC_MAX_AGE_MS } from './alerts.ts';
import type { Health } from './health.ts';

// Wat op de statuspagina aandacht vraagt. Dezelfde grenzen als de pushmeldingen (alerts.ts),
// zodat de pagina en de meldingen hetzelfde zeggen. De leeftijd van Litestream zegt op een
// rustige dag weinig (hij schrijft alleen bij wijzigingen); de achterstand bewaakt alerts.ts,
// hier telt alleen of er een replicatie is.

export function attention(h: Health): string[] {
	const out: string[] = [];
	if (!h.database) out.push('De database is niet bereikbaar.');
	if (h.backups.litestreamAgeSeconds === null) out.push('Geen Litestream-replicatie gevonden.');
	const restic = h.backups.resticAgeSeconds;
	if (restic === null) out.push('Geen restic-backup gevonden.');
	else if (restic * 1000 > RESTIC_MAX_AGE_MS)
		out.push('De laatste restic-backup is ouder dan een dag.');
	if (h.disk === null) out.push('Schijfruimte onbekend.');
	else if (h.disk.usedPercent > DISK_ALERT_PERCENT)
		out.push(`De schijf is voor meer dan ${DISK_ALERT_PERCENT}% vol.`);
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
