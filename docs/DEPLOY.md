# Uitrol en beheer

Alles wat buiten de repo op de VPS en in GitHub ingesteld moet worden. Geheimen staan nooit in deze repo.

## GitHub

- **Variables** (Settings → Secrets and variables → Actions → Variables):
  - `APP_ORIGIN`: `https://budget.example.nl`. SvelteKit 3 legt de origin bij het bouwen vast (`paths.origin`); een `ORIGIN`-variabele bij het starten bestaat niet meer.
  - `VPS_TAILNET_HOST`: naam van de VPS op je tailnet.
  - `TS_OAUTH_CLIENT_ID` en `TS_AUDIENCE`: Tailscale workload identity federation.
- **Environment** `production`: alleen vanaf `main`.
- **Secrets**: `CLAUDE_CODE_OAUTH_TOKEN` voor de review-workflow (niet in `production`).
- **Ruleset** op `main`: PR verplicht, statuschecks `static`, `integration`, `e2e`, `guardrails`, `security`, `docker` verplicht.

## VPS

De commando's op de VPS zijn voor bash (fish kent geen heredocs). Uitgaande van Debian of Ubuntu, met Docker (en de compose-plugin), nginx en Tailscale al geïnstalleerd en de VPS al op je tailnet. Domein: `budget.example.nl`. Geheimen vul je in met `sudoedit` op de server, nooit in een chat of in deze repo.

### 1. Pakketten

```bash
sudo apt-get update
sudo apt-get install -y sqlite3 restic curl certbot unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

### 2. Tailscale-tag en SSH

Eerst in de tailnet-policy (Tailscale-adminconsole → Access controls) de tags aanmaken en `tag:ci` beperken tot SSH naar de VPS als `deploy`. Samenvoegen met wat er al staat, en een algemene `"*:*"`-regel weghalen of beperken tot je eigen gebruiker:

```json
{
	"tagOwners": {
		"tag:ci": [],
		"tag:vps": []
	},
	"acls": [{ "action": "accept", "src": ["tag:ci"], "dst": ["tag:vps:22"] }],
	"ssh": [{ "action": "accept", "src": ["tag:ci"], "dst": ["tag:vps"], "users": ["deploy"] }]
}
```

Dan op de VPS (de VPS wordt daarmee een getagde node; Tailscale kan om opnieuw inloggen vragen):

```bash
sudo tailscale up --ssh --advertise-tags=tag:vps
```

Controleer vanaf je laptop dat SSH via Tailscale werkt (`ssh <jouw-gebruiker>@vps`) voordat je stap 9 doet, anders sluit je jezelf buiten.

### 3. Gebruiker `deploy`

Zonder wachtwoord en niet in de groep `docker` (die is gelijk aan root). Hij mag alleen het deploy-script draaien:

```bash
sudo useradd --create-home --shell /bin/bash deploy
sudo passwd --lock deploy
echo 'deploy ALL=(root) NOPASSWD: /usr/local/bin/deploy-budget' | sudo tee /etc/sudoers.d/deploy-budget
sudo chmod 0440 /etc/sudoers.d/deploy-budget
sudo visudo -c
```

### 4. Bestanden uit de repo

Vanaf je laptop, in de repo:

```bash
scp deploy/docker-compose.yml deploy/litestream.yml deploy/backup.sh deploy/deploy-budget.sh deploy/nginx/finance.conf vps:/tmp/
```

Op de VPS, van root en niet door `deploy` te wijzigen:

```bash
sudo install -d -o root -g root -m 0755 /opt/budget
sudo install -o root -g root -m 0644 /tmp/docker-compose.yml /tmp/litestream.yml /opt/budget/
sudo install -o root -g root -m 0755 /tmp/backup.sh /opt/budget/backup.sh
sudo install -o root -g root -m 0755 /tmp/deploy-budget.sh /usr/local/bin/deploy-budget
sudo install -d -o root -g root -m 0755 /var/lib/budget
```

### 5. Omgevingsbestanden

```bash
sudo install -d -o root -g root -m 0700 /etc/budget
sudo tee /etc/budget/app.env >/dev/null <<'EOF'
ORIGIN=https://budget.example.nl
RP_ID=budget.example.nl
LOG_LEVEL=info
EOF
sudo tee /etc/budget/litestream.env >/dev/null <<'EOF'
LITESTREAM_BUCKET=
LITESTREAM_ENDPOINT=
LITESTREAM_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
LITESTREAM_HEARTBEAT_URL=
EOF
sudo tee /etc/budget/restic.env >/dev/null <<'EOF'
RESTIC_REPOSITORY=
RESTIC_PASSWORD_FILE=/etc/budget/restic-password
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
BACKUP_PING_URL=
EOF
sudo sh -c 'chmod 0600 /etc/budget/*.env'
```

Vul de lege waarden in:

```bash
sudoedit /etc/budget/litestream.env
sudoedit /etc/budget/restic.env
```

`RESTIC_REPOSITORY` heeft de vorm `s3:https://<endpoint>/<bucket>/budget`. Gebruik een andere bucket (of andere sleutels) dan voor Litestream.

De ping-URL's voor de externe checks (`LITESTREAM_HEARTBEAT_URL`, `BACKUP_PING_URL` en `HEALTHCHECK_PING_URL` in `app.env`) vul je in bij Monitoring; leeg laten mag, dan staat die check uit.

### 6. Restic-wachtwoord en repository

```bash
sudo sh -c 'umask 077 && openssl rand -base64 32 > /etc/budget/restic-password'
sudo cat /etc/budget/restic-password
```

Bewaar dit wachtwoord ook buiten de VPS (wachtwoordmanager). Zonder dit wachtwoord zijn de backups niet terug te zetten. Daarna de repository aanmaken:

```bash
sudo bash -c 'set -a; source /etc/budget/restic.env; restic init'
```

### 7. Dagelijkse backup

```bash
sudo tee /etc/systemd/system/budget-backup.service >/dev/null <<'EOF'
[Unit]
Description=Budget: versleutelde backup met restic
After=docker.service

[Service]
Type=oneshot
ExecStart=/opt/budget/backup.sh dagelijks
EOF
sudo tee /etc/systemd/system/budget-backup.timer >/dev/null <<'EOF'
[Unit]
Description=Budget: dagelijkse backup

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now budget-backup.timer
```

De backup slaat over tot de app voor het eerst draait; tot die tijd faalt de service met "No such container: budget".

### 8. nginx en certificaat

Eerst een DNS-record (A, en AAAA bij IPv6) voor `budget.example.nl` naar de VPS. Kijk of je al een default server hebt; zo ja, laat dan het eerste `server`-blok (met `return 444`) uit de config weg:

```bash
grep -rn default_server /etc/nginx/
```

Nginx weigert de volledige config zolang het certificaat niet bestaat. Daarom eerst alleen poort 80 voor de challenge:

```bash
sudo install -d -m 0755 /var/www/certbot
sudo tee /etc/nginx/sites-available/budget.conf >/dev/null <<'EOF'
server {
    listen 80;
    server_name budget.example.nl;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}
EOF
sudo ln -s /etc/nginx/sites-available/budget.conf /etc/nginx/sites-enabled/budget.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/certbot -d budget.example.nl --deploy-hook 'systemctl reload nginx'
```

Daarna de volledige config met het juiste domein:

```bash
sed 's/finance\.mijndomein\.nl/budget.example.nl/g' /tmp/finance.conf | sudo tee /etc/nginx/sites-available/budget.conf >/dev/null
sudo nginx -t && sudo systemctl reload nginx
```

### 9. Firewall en SSH

Alleen als SSH via Tailscale werkt (stap 2). Docker publiceert de app alleen op 127.0.0.1, dus die gaat niet om de firewall heen.

```bash
sudo ufw default deny incoming
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow in on tailscale0
sudo ufw enable
printf 'PermitRootLogin no\nPasswordAuthentication no\n' | sudo tee /etc/ssh/sshd_config.d/90-budget.conf
sudo sshd -t && sudo systemctl reload ssh
```

### 10. Eerste uitrol

Merge de PR naar `main`. De deploy-workflow bouwt het image, komt via Tailscale binnen als `deploy` en draait `deploy-budget`. Dat start de app en daarna Litestream. Controleer op de VPS:

```bash
sudo docker ps --filter name=budget
curl -fsS http://127.0.0.1:3000/healthz
sudo docker logs budget-litestream --tail 20
```

## Monitoring

Telemetrie staat in een aparte database, `/data/telemetry.db` naast de hoofddatabase, en wordt na 90 dagen opgeruimd. Hij wordt niet door Litestream gerepliceerd: verlies is vervelend, niet erg.

- **Fouten.** Elke onverwachte fout komt in de tabel `errors` onder het `errorId` dat je in de app ziet, zonder foutmelding of invoer. Bekijken: `sudo docker exec budget node -e "const D=require('better-sqlite3');console.table(new D('/data/telemetry.db',{readonly:true}).prepare('select at,name,route,method from errors order by at desc limit 20').all())"`.
- **Health check.** Publiek geeft `/healthz` alleen `ok`. Na inloggen geeft `/api/health` de leeftijd van de laatste Litestream-sync en restic-backup, de schijfruimte van het datavolume, het aantal starts en herstarts (een start van een versie die al eerder draaide) en het aantal fouten.

### Externe checks

Een dienst die alarm slaat als een ping uitblijft, zoals [healthchecks.io](https://healthchecks.io) (gratis tot 20 checks). Maak drie checks:

| Check      | Periode   | Marge      | Waar de URL komt                                           | Wie pingt                                                                         |
| ---------- | --------- | ---------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| App        | 5 minuten | 10 minuten | `HEALTHCHECK_PING_URL` in `/etc/budget/app.env`            | De app, bij het starten en elke 5 minuten, alleen als de database bereikbaar is   |
| Replicatie | 5 minuten | 10 minuten | `LITESTREAM_HEARTBEAT_URL` in `/etc/budget/litestream.env` | Litestream, alleen na een geslaagde sync (vanaf 0.5.6; het image staat op 0.5.17) |
| Backup     | 1 dag     | 2 uur      | `BACKUP_PING_URL` in `/etc/budget/restic.env`              | `backup.sh` na een geslaagde backup, en `<url>/fail` als hij misgaat              |

De ping-URL's zijn geheimen: wie ze kent, kan een check groen houden terwijl er iets stuk is. Ze staan alleen in de omgevingsbestanden op de VPS, nooit in de repo. Zet tweestapsverificatie aan op je account bij de dienst.

```bash
sudoedit /etc/budget/app.env
sudoedit /etc/budget/litestream.env
sudoedit /etc/budget/restic.env
```

Daarna de app en Litestream opnieuw aanmaken, zodat ze de nieuwe omgeving lezen, en één backup draaien om de backup-check te starten (`backup.sh` leest `restic.env` bij elke run):

```bash
sudo BUDGET_IMAGE="ghcr.io/nobobo1234/budgetsysteem@$(cat /var/lib/budget/current-digest)" docker compose -f /opt/budget/docker-compose.yml up -d --force-recreate app litestream
sudo systemctl start budget-backup.service
```

Controleer in het dashboard van de dienst dat alle drie de checks binnen een paar minuten groen worden. Een alternatief voor de app-check is Uptime Kuma op een ander apparaat dat `https://budget.example.nl/healthz` opvraagt; dat ziet alleen niet of Litestream of restic stilvalt.

## Wijzigingen in `deploy/`

De deploy-workflow rolt alleen het image uit. De bestanden uit stap 4 staan als kopie op de VPS en worden niet automatisch bijgewerkt. Verandert een PR iets in `deploy/`, kopieer de bestanden dan na de merge opnieuw, vanaf je laptop:

```bash
scp deploy/docker-compose.yml deploy/litestream.yml deploy/backup.sh deploy/deploy-budget.sh vps:/tmp/
```

En op de VPS:

```bash
sudo install -o root -g root -m 0644 /tmp/docker-compose.yml /tmp/litestream.yml /opt/budget/
sudo install -o root -g root -m 0755 /tmp/backup.sh /opt/budget/backup.sh
sudo install -o root -g root -m 0755 /tmp/deploy-budget.sh /usr/local/bin/deploy-budget
```

Is `litestream.yml` of `docker-compose.yml` veranderd, maak de containers dan opnieuw aan zoals bij Externe checks. `backup.sh` en `deploy-budget` gelden vanaf de volgende run. Een gewijzigde `nginx/finance.conf` installeer je zoals in stap 8.

## Eerste keer inloggen

1. Na de eerste uitrol: `sudo docker exec -it budget node scripts/setup-token.mjs`.
2. Open `https://budget.example.nl/setup`, plak het token en maak een passkey.
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
