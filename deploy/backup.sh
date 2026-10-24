#!/usr/bin/env bash
# Versleutelde backup met restic naar opslag buiten de VPS, naast de doorlopende
# Litestream-replicatie. Dagelijks via een systemd-timer, en vóór elke uitrol.
# RESTIC_REPOSITORY en RESTIC_PASSWORD_FILE staan in /etc/budget/restic.env (niet in de repo).
set -euo pipefail

TAG="${1:-dagelijks}"
WORK="/var/backups/budget"
mkdir -p "$WORK"
chmod 700 "$WORK"

# Consistente kopie via de SQLite-backup-API in de container (geen kopie van een half bestand)
docker exec budget node -e "
  const Database = require('better-sqlite3');
  const db = new Database('/data/budget.db', { readonly: true });
  db.backup('/data/backup.db').then(() => db.close());
"
docker cp budget:/data/backup.db "$WORK/budget.db"
docker exec budget rm -f /data/backup.db

# Eerst controleren, dan pas wegschrijven
sqlite3 "$WORK/budget.db" 'PRAGMA integrity_check;' | grep -qx ok

set -a
# shellcheck disable=SC1091
source /etc/budget/restic.env
set +a
restic backup --tag "$TAG" "$WORK/budget.db"
# Markering voor de health check van de app (leeftijd van de laatste geslaagde backup)
docker exec budget touch /data/.restic-laatste-backup
restic forget --tag dagelijks --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
rm -f "$WORK/budget.db"
