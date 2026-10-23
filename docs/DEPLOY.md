# Uitrol en beheer

Alles wat buiten de repo op de VPS en in GitHub ingesteld moet worden. Geheimen staan nooit in deze repo.

## GitHub

- **Variables** (Settings → Secrets and variables → Actions → Variables):
  - `APP_ORIGIN`: `https://finance.<jouw-domein>`. SvelteKit 3 legt de origin bij het bouwen vast (`paths.origin`); een `ORIGIN`-variabele bij het starten bestaat niet meer.
  - `VPS_TAILNET_HOST`: naam van de VPS op je tailnet.
  - `TS_OAUTH_CLIENT_ID` en `TS_AUDIENCE`: Tailscale workload identity federation.
- **Environment** `production`: alleen vanaf `main`.
- **Secrets**: `CLAUDE_CODE_OAUTH_TOKEN` voor de review-workflow (niet in `production`).
- **Branch protection** op `main`: PR verplicht, statuschecks `static`, `integration`, `e2e`, `guardrails`, `security`, `docker` verplicht.

## VPS

1. Docker, nginx, certbot, sqlite3, restic en curl installeren. Firewall: alleen 80 en 443 open; SSH alleen via Tailscale.
2. `deploy/` naar `/opt/budget/` kopiëren; `deploy/deploy-budget.sh` naar `/usr/local/bin/deploy-budget`.
3. Gebruiker `deploy` met in sudoers alleen: `deploy ALL=(root) NOPASSWD: /usr/local/bin/deploy-budget`.
4. Tailscale-ACL: `tag:ci` mag alleen poort 22 van de VPS, als gebruiker `deploy`, via Tailscale SSH.
5. Omgevingsbestanden (eigenaar root, `chmod 600`):
   - `/etc/budget/app.env`: `RP_ID=finance.<jouw-domein>`, `ORIGIN=https://finance.<jouw-domein>`, `LOG_LEVEL=info`.
   - `/etc/budget/litestream.env`: `LITESTREAM_BUCKET`, `LITESTREAM_ENDPOINT`, `LITESTREAM_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
   - `/etc/budget/restic.env`: `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE` (plus sleutels voor de opslag).
6. `deploy/nginx/finance.conf` in nginx zetten, domein invullen, certificaat met certbot.
7. Dagelijkse backup: een systemd-timer die `/opt/budget/backup.sh` draait.

## Eerste keer inloggen

1. Na de eerste uitrol: `docker exec -it budget node scripts/setup-token.mjs`.
2. Open `/setup`, plak het token en maak een passkey.
3. Schrijf de herstelcode op papier.
4. Voeg onder Instellingen een passkey op een tweede apparaat toe.

## Herstel testen (elk kwartaal)

1. `restic restore latest --target /tmp/herstel`
2. `sqlite3 /tmp/herstel/var/backups/budget/budget.db 'PRAGMA integrity_check;'` moet `ok` geven.
3. Optioneel: `litestream restore -o /tmp/herstel.db s3://…` en dezelfde controle.

## Lokaal ontwikkelen

```bash
pnpm install
COOKIE_SECURE=false pnpm dev
```

Daarna een setup-token maken met `DATABASE_PATH=data/budget.db pnpm setup-token` en `/setup` openen.
