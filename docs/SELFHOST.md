# Zelf hosten

De app op je eigen VPS en domein, met Docker Compose en Caddy. Caddy regelt het certificaat (Let's Encrypt) en stuurt alles door naar de app; de app zelf is niet direct vanaf internet bereikbaar. Eén installatie is voor één persoon.

Alles staat in de map [`selfhost/`](../selfhost/). Noahs eigen productie (nginx, deploy-workflow) staat los daarvan in [`DEPLOY.md`](DEPLOY.md).

## Wat je nodig hebt

- Een VPS met Docker Engine en de compose-plugin (`docker compose version` moet werken) en git. Het image wordt op de VPS zelf gebouwd.
- Een domein of subdomein, zoals `budget.jouwdomein.nl`, met een A-record (en een AAAA-record als de VPS IPv6 heeft) naar de VPS. Passkeys werken alleen over https op een echte domeinnaam, niet op een IP-adres.
- Poort 80 en 443 (TCP, en 443/UDP voor HTTP/3) open naar internet, en geen andere webserver op die poorten. Caddy heeft poort 80 nodig voor Let's Encrypt en de doorverwijzing naar https.

## Installeren

1. Code ophalen:

   ```bash
   git clone https://github.com/nobobo1234/budgetsysteem.git budget
   cd budget/selfhost
   ```

2. Instellingen maken. Vul in `.env` minstens `DOMAIN` in (zonder `https://`):

   ```bash
   cp env.example .env
   chmod 600 .env
   nano .env
   ```

   Laat optionele regels uit (met `#` ervoor). Een lege waarde als `RP_ID=` laat de app weigeren te starten.

3. Bouwen en starten:

   ```bash
   docker compose up -d --build
   ```

4. Controleren. Caddy haalt bij de eerste start het certificaat op; dat duurt meestal minder dan een minuut.

   ```bash
   docker compose ps
   curl -fsS https://budget.jouwdomein.nl/healthz
   ```

   `ok` betekent dat de app draait en bereikbaar is.

5. Je eerste passkey maken (hieronder).

Alle `docker compose`-opdrachten in deze handleiding draai je in de map `selfhost/`.

## Eerste passkey

Er zijn geen wachtwoorden. Je eerste passkey maak je met een eenmalig setup-token:

```bash
docker compose exec app node scripts/setup-token.mjs
```

1. Het token is 15 minuten geldig en werkt één keer. Krijg je "De database is nog niet gemigreerd", wacht dan tot `docker compose ps` de app als `healthy` toont.
2. Open `https://budget.jouwdomein.nl/setup`, plak het token en maak een passkey.
3. Schrijf de herstelcode op papier.
4. Voeg onder Instellingen een passkey op een tweede apparaat toe.

Ben je al je passkeys en de herstelcode kwijt, dan is een nieuw setup-token het laatste redmiddel.

## Bijwerken

```bash
git pull && docker compose up -d --build
```

Database-migraties draaien vanzelf bij het starten. Oude images ruim je op met `docker image prune`.

## Backups

Alles staat in het Docker-volume `budgetapp_data`: de database, de telemetrie-database en de foto's van bonnen.

### Volume-backup

Even stoppen, zodat de database in één consistente toestand op schijf staat, en dan inpakken met het image van de app zelf:

```bash
mkdir -p ~/budget-backups
docker compose stop app
docker run --rm --user root --entrypoint tar \
  -v budgetapp_data:/data:ro -v ~/budget-backups:/backup \
  budgetapp:local -czf /backup/budget-$(date +%F).tar.gz -C /data .
docker compose start app
```

Zet het bestand daarna buiten de VPS, bijvoorbeeld met `scp` naar je eigen computer. Het bevat al je financiële gegevens: bewaar het versleuteld.

Terugzetten (dit vervangt alles in het volume):

```bash
docker compose stop app
docker run --rm --user root --entrypoint sh \
  -v budgetapp_data:/data -v ~/budget-backups:/backup budgetapp:local \
  -c 'find /data -mindepth 1 -delete && tar -xzf /backup/budget-2026-01-31.tar.gz -C /data && chown -R node:node /data'
docker compose start app
```

### Litestream (optioneel)

Litestream repliceert de database doorlopend naar S3-compatibele opslag (Backblaze B2, Cloudflare R2, AWS S3). Vul de `LITESTREAM_*`-regels en `AWS_*`-sleutels in `.env` in, zet `COMPOSE_PROFILES=backup` aan en start opnieuw:

```bash
docker compose up -d
docker compose logs litestream --tail 20
```

Litestream repliceert alleen de database, niet de foto's van bonnen. Houd daarom ook de volume-backup aan. Terugzetten gaat met `litestream restore`; zie de [Litestream-documentatie](https://litestream.io).

Op Meer → Status (en met pushmeldingen aan ook één keer als melding) meldt de app dat er geen restic-backup is gemaakt, en zonder Litestream ook dat Litestream niets heeft gerepliceerd. Restic hoort bij Noahs eigen opzet (`deploy/backup.sh`), niet bij deze; die melding kun je negeren.

## Pushmeldingen (optioneel)

Pushmeldingen hebben een VAPID-sleutelpaar nodig. Maak het in de draaiende container en zet het direct in `.env`:

```bash
docker compose exec -T app node --input-type=module < vapid-keys.mjs >> .env
docker compose up -d
```

Bewaar een kopie van beide sleutels: een nieuw paar maakt bestaande abonnementen ongeldig. Daarna in de app, op een iPhone vanuit de app op je beginscherm: Meer → Meldingen → Meldingen aanzetten.

## Bonnetjes lezen (optioneel)

Bonnen worden gelezen door Claude Haiku via de Anthropic API. Zonder sleutel werkt de rest van de app gewoon; bonnen blijven dan op "wordt gelezen" staan en worden alsnog gelezen zodra er een sleutel is.

1. Maak in de [Claude Console](https://platform.claude.com) een aparte workspace met een eigen sleutel en een lage maandelijkse uitgavenlimiet.
2. Zet `ANTHROPIC_API_KEY=...` in `.env` (met de editor, niet via `echo`, zodat hij niet in je shell-geschiedenis komt).
3. `docker compose up -d`.

Bonnen vanaf je iPhone versturen via het deelmenu: zie [ios-opdracht.md](ios-opdracht.md).

## Problemen

- **Passkey werkt niet of wordt niet aangeboden.** Een passkey hoort bij precies één domein (`RP_ID`, standaard `DOMAIN`). Open de app alleen via `https://` en die naam, niet via het IP-adres of een andere naam. Verander je later van domein: pas `DOMAIN` aan, bouw opnieuw (`docker compose up -d --build`; de origin zit in het image) en maak met een nieuw setup-token een nieuwe passkey. De oude passkeys werken dan niet meer.
- **"Verzoek geweigerd" bij opslaan.** De app accepteert wijzigingen alleen vanaf `https://DOMAIN`. Zelfde oorzaak als hierboven.
- **Geen certificaat.** Kijk in `docker compose logs caddy`. Meestal wijst de DNS-record (nog) niet naar de VPS, staat poort 80 of 443 dicht in een firewall van de VPS of de hostingprovider, of draait er al een andere webserver op die poorten. Verwijder het volume `budgetapp_caddy-data` niet: Let's Encrypt heeft limieten op het aantal nieuwe certificaten.
- **De app start niet.** Kijk in `docker compose logs app`. Een `ZodError` noemt de variabele uit `.env` die niet klopt, vaak een lege waarde.
- **"Te veel verzoeken" terwijl je alleen bent.** De app remt per IP-adres. Komt IPv6-verkeer bij Docker binnen zonder IPv6 in de netwerken van Docker, dan ziet de app voor al dat verkeer hetzelfde adres. Haal dan de AAAA-record weg of zet IPv6 aan in Docker.
