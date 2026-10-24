#!/usr/bin/env bash
# Versleutelde backup met restic naar opslag buiten de VPS, naast de doorlopende
# Litestream-replicatie. Dagelijks via een systemd-timer, en vóór elke uitrol.
# RESTIC_REPOSITORY en RESTIC_PASSWORD_FILE staan in /etc/budget/restic.env (niet in de repo),
# net als BACKUP_PING_URL (optioneel, een geheim): de externe check krijgt een ping na een
# geslaagde backup en `<url>/fail` als het misgaat.
set -euo pipefail

TAG="${1:-dagelijks}"
WORK="/var/backups/budget"

set -a
# shellcheck disable=SC1091
source /etc/budget/restic.env
set +a

# Ping zonder de URL in de uitvoer; een mislukte ping laat de backup zelf niet falen
ping_check() {
  [[ -n "${BACKUP_PING_URL:-}" ]] || return 0
  curl -fsS --max-time 10 --retry 3 -o /dev/null "${BACKUP_PING_URL}$1" 2>/dev/null \
    || echo "Ping naar de externe check mislukt" >&2
}
trap 'ping_check /fail' ERR

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

restic backup --tag "$TAG" "$WORK/budget.db"
# Markering voor de health check van de app (leeftijd van de laatste geslaagde backup)
docker exec budget touch /data/.restic-laatste-backup
restic forget --tag dagelijks --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
rm -f "$WORK/budget.db"
ping_check ""
