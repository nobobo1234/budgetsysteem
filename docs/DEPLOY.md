# Uitrol en beheer

Alles wat buiten de repo op de VPS en in GitHub ingesteld moet worden. Geheimen staan nooit in deze repo.

## GitHub

De uitrol is gesplitst in twee repo's, naar het voorbeeld van GitLab (publiek `gitlab`, uitrol vanaf het interne `ops.gitlab.net`) en Sentry (publiek `sentry`, privé `getsentry`):

- **Publieke repo** `nobobo1234/budgetsysteem`: code, CI, `selfhost/`, `deploy/` (de bestanden voor de VPS) en de docs. Geen deploy-workflow, en CI kent geen origin, VPS of Tailscale-gegevens.
- **Privé ops-repo**: alleen de deploy-workflow en de secrets die naar de eigen infra wijzen. Het image is privé en gekoppeld aan die repo.

### Hoe een uitrol loopt

1. Een PR wordt gemerged naar `main` van de publieke repo. Na een groene `static` op die push (en alleen als er meer dan docs veranderde) start de job `dispatch-deploy` met een `workflow_dispatch` de workflow `deploy.yml` in de ops-repo, met de commit-SHA als invoer.
2. De ops-repo checkt de publieke repo uit op die SHA en controleert dat de commit op `main` staat (`git merge-base --is-ancestor`). Een andere branch of een commit uit een fork wordt geweigerd.
3. Het image wordt vers gebouwd voor arm64, met `ORIGIN` uit een secret, en gepusht naar het privé-package.
4. De deploy-job komt via Tailscale binnen als `deploy` en draait `deploy-budget <digest>` (zie stap 2 en 3 hieronder).
5. Tot slot controleert de job dat `/healthz` via het eigen domein `ok` geeft.

Handmatig uitrollen of terugrollen: in de ops-repo Actions → Deploy → Run workflow, met de volledige SHA van een commit op `main` van de publieke repo.

### Publieke repo

- **Environment** `ops-dispatch`: alleen vanaf `main`, met twee secrets:
  - `OPS_DISPATCH_TOKEN`: fine-grained personal access token met alleen toegang tot de ops-repo en alleen de permissie Actions: Read and write. Het mag dus geen code lezen, geen secrets zien en niets in de publieke repo doen. Verloopt na hooguit een jaar; zet een herinnering.
  - `OPS_REPO`: `<eigenaar>/<naam>` van de ops-repo. Een secret, zodat de naam niet in de publieke logs staat.
- **Secrets**: `CLAUDE_CODE_OAUTH_TOKEN` voor de review-workflow (niet in `ops-dispatch`).
- **Ruleset** op `main`: PR verplicht, statuschecks `static`, `integration`, `e2e`, `guardrails`, `security`, `docker` verplicht.
- **Actions**: goedkeuring vereist voor workflows uit fork-PR's van alle externe bijdragers; standaardrechten van `GITHUB_TOKEN` alleen lezen.
- **Security**: secret scanning met push protection, private vulnerability reporting (zie `SECURITY.md`), Dependabot alerts.

### Ops-repo

De instellingen staan in de README van de ops-repo zelf. In het kort: de origin, de naam van de VPS op het tailnet en de Tailscale-gegevens staan daar als secrets, de Tailscale-gegevens alleen in een environment `production` die alleen vanaf `main` mag. De trust credential in Tailscale hoort bij die environment van de ops-repo, nooit bij de publieke repo.

Ook wat geen geheim is staat als secret: GitHub maskeert secrets in de logs, maar alleen bij een exacte match. Afgeleide waarden (de host zonder `https://`) maskeert de workflow zelf met `::add-mask::`.

## VPS

De commando's op de VPS zijn voor bash (fish kent geen heredocs). Uitgaande van Debian of Ubuntu, met Docker (en de compose-plugin), nginx en Tailscale al geïnstalleerd en de VPS al op je tailnet. Overal hieronder staat `budget.example.nl`: vervang dat door je eigen domein. Geheimen vul je in met `sudoedit` op de server, nooit in een chat of in deze repo.

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

Merge de PR naar `main`. De deploy-workflow in de ops-repo bouwt het image, komt via Tailscale binnen als `deploy` en draait `deploy-budget`. Dat start de app en daarna Litestream. Controleer op de VPS:

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

### Pushmeldingen

Pushmeldingen (Web Push) hebben een VAPID-sleutelpaar nodig. Zonder sleutels werkt de app gewoon; op Meer → Meldingen staat dan dat ze nog niet zijn ingesteld. Telemetrie-meldingen (nieuw soort fout, backup te oud, schijf boven 80%) en beveiligingsmeldingen gaan via dezelfde weg.

| Variabele           | Waar                  | Inhoud                                                                     |
| ------------------- | --------------------- | -------------------------------------------------------------------------- |
| `VAPID_PUBLIC_KEY`  | `/etc/budget/app.env` | Publieke sleutel, 87 tekens base64url (niet geheim)                        |
| `VAPID_PRIVATE_KEY` | `/etc/budget/app.env` | Privésleutel, 43 tekens base64url (**geheim**)                             |
| `VAPID_SUBJECT`     | `/etc/budget/app.env` | Contact voor de push-diensten, `mailto:…` of `https://…`; standaard ORIGIN |

De sleutels maak je één keer op de VPS, in de draaiende container, en ze gaan direct het omgevingsbestand in zonder op je scherm te komen:

```bash
sudo docker exec budget node -e "
  const { generateKeyPairSync } = require('node:crypto');
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
  console.log('VAPID_PUBLIC_KEY=' + raw.toString('base64url'));
  console.log('VAPID_PRIVATE_KEY=' + privateKey.export({ format: 'jwk' }).d);
" | sudo tee -a /etc/budget/app.env >/dev/null
echo 'VAPID_SUBJECT=https://budget.example.nl' | sudo tee -a /etc/budget/app.env >/dev/null
sudo BUDGET_IMAGE="ghcr.io/nobobo1234/budgetsysteem@$(cat /var/lib/budget/current-digest)" docker compose -f /opt/budget/docker-compose.yml up -d --force-recreate app
```

- Bewaar een kopie van beide sleutels in je wachtwoordmanager. Een nieuw sleutelpaar maakt alle bestaande abonnementen ongeldig: dan zet je meldingen op elk apparaat opnieuw aan.
- De sleutels zijn alleen nodig op de VPS; de deploy-workflow geeft ze niet door, dus in GitHub Secrets hoeven ze niet.
- Daarna op je iPhone, vanuit de app op je beginscherm: Meer → Meldingen → Meldingen aanzetten, en Testmelding sturen.
- Drempels: restic-backup ouder dan 26 uur (dezelfde marge als de externe backup-check), Litestream meer dan een uur achter op de laatste wijziging aan de database, schijf boven 80% (weer in orde onder 78%). Elke soort meldt één keer tot hij weer in orde is.

### Bonnetjes (Claude Haiku)

Het lezen van bonnen loopt via de Anthropic API. Zonder sleutel werkt de rest van de app gewoon: bonnen komen binnen, maar blijven op "wordt gelezen" staan, en in het log staat bij het starten `geen ANTHROPIC_API_KEY: bonnen blijven wachten`. Na een herstart met sleutel worden de wachtende bonnen alsnog gelezen.

| Variabele           | Waar                  | Inhoud                                  |
| ------------------- | --------------------- | --------------------------------------- |
| `ANTHROPIC_API_KEY` | `/etc/budget/app.env` | API-sleutel uit de Console (**geheim**) |

Maak in de [Claude Console](https://platform.claude.com) een aparte workspace voor deze app, met een eigen sleutel en een maandelijkse uitgavenlimiet. Een bon kost ongeveer een tiende cent, dus een lage limiet volstaat en beperkt de schade als de sleutel ooit uitlekt. Zet de sleutel met de editor in het omgevingsbestand, zodat hij niet in je shell-geschiedenis komt, en maak de app opnieuw aan:

```bash
sudoedit /etc/budget/app.env
sudo BUDGET_IMAGE="ghcr.io/nobobo1234/budgetsysteem@$(cat /var/lib/budget/current-digest)" docker compose -f /opt/budget/docker-compose.yml up -d --force-recreate app
```

- De sleutel is alleen nodig op de VPS; de deploy-workflow geeft hem niet door, dus in GitHub Secrets hoeft hij niet.
- Controleren: stuur een bon via de app of het deelmenu. Binnen een minuut staat hij op zeker, controleren of onzeker, en je krijgt een pushmelding. Op Meer → Status zie je per aanroep tokens, kosten en duur.
- Een nieuwe sleutel: maak hem in de Console aan, zet hem in `app.env`, maak de app opnieuw aan, en trek daarna de oude in.
- Identity federation (zonder vaste sleutel) vraagt een OIDC-identiteit van de workload; een losse VPS heeft die niet, dus hier blijft het een sleutel met uitgavenlimiet.

### Opdracht voor het deelmenu

De ondertekende iOS-opdracht staat niet in de repo maar in het datavolume (`/data/shortcut-signed.json`); de app leest hem zonder herstart. Ondertekenen kan alleen op een Mac (docs/ios-opdracht.md):

```bash
node scripts/sign-shortcut.ts --origin https://budget.example.nl --uit data/shortcut-signed.json
scp data/shortcut-signed.json vps:/tmp/shortcut-signed.json
```

Op de VPS:

```bash
sudo docker cp /tmp/shortcut-signed.json budget:/data/shortcut-signed.json && rm /tmp/shortcut-signed.json
```

Het bestand moet leesbaar zijn voor `node` (0644 is genoeg). Opnieuw ondertekenen na een wijziging in `src/lib/server/receipts/shortcut.ts` (Apparaten meldt dan "Opdracht ongeldig") en vóór `validUntil`, ongeveer een jaar na ondertekenen.

## Wijzigingen in `deploy/`

De deploy-workflow (in de ops-repo) rolt alleen het image uit. De bestanden uit stap 4 staan als kopie op de VPS en worden niet automatisch bijgewerkt. Verandert een PR iets in `deploy/`, kopieer de bestanden dan na de merge opnieuw, vanaf je laptop:

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
