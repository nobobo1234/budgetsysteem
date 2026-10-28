# Budgetapp

Persoonlijke budgetapp voor één gebruiker, op een eigen server. Snel uitgaven invoeren (ook offline), eenmalig de bankhistorie importeren (CAMT.053 of CSV), budgetten per categorie en vaste lasten als verwachte posten. Bonnetjes kunnen optioneel worden gelezen met Claude Haiku.

## Stack

- SvelteKit (Node-adapter) als PWA, met GSAP voor animaties
- SQLite via better-sqlite3 en Drizzle
- Inloggen met passkeys (SimpleWebAuthn), geen wachtwoorden
- Web Push (VAPID) voor meldingen
- Docker; optioneel Litestream voor replicatie van de database

## Documentatie

- [docs/SELFHOST.md](docs/SELFHOST.md): zelf hosten op je eigen VPS en domein, met Docker Compose en Caddy
- [docs/SPEC.md](docs/SPEC.md): de spec (architectuur, datamodel, beveiliging, design)
- [docs/DEPLOY.md](docs/DEPLOY.md): Noahs eigen productie-opzet (nginx, GitHub Actions, Tailscale)

## Uitrol

Deze repo bevat geen deploy-workflow. Na een groene push op `main` start CI de uitrol in een privé ops-repo, die deze repo op die commit uitcheckt, het image bouwt en via Tailscale naar Noahs VPS uitrolt; zie [docs/DEPLOY.md](docs/DEPLOY.md#github). Wie zelf host, bouwt uit deze repo zoals in [docs/SELFHOST.md](docs/SELFHOST.md).

## Lokaal ontwikkelen

Met Node 24 en pnpm:

```bash
pnpm install
COOKIE_SECURE=false pnpm dev
```

Daarna een setup-token maken met `DATABASE_PATH=data/budget.db pnpm setup-token` en `/setup` openen.

## Beveiliging

Kwetsbaarheden privé melden: zie [SECURITY.md](SECURITY.md).

## Licentie

[AGPL-3.0](LICENSE). Vrij te gebruiken, aan te passen en zelf te hosten. Bied je een aangepaste versie aan anderen aan via het netwerk, dan moet je hun ook de broncode van die versie aanbieden.
