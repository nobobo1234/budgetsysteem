<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
    <img src="docs/logo-light.svg" alt="Budgetapp" width="560">
  </picture>
</h1>

<p align="center">
  <a href="https://www.bestpractices.dev/projects/16033"><img src="https://www.bestpractices.dev/projects/16033/badge" alt="OpenSSF Best Practices"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/nobobo1234/budgetsysteem"><img src="https://api.scorecard.dev/projects/github.com/nobobo1234/budgetsysteem/badge" alt="OpenSSF Scorecard"></a>
</p>

Persoonlijke budgetapp voor één gebruiker, op een eigen server. Snel uitgaven invoeren (ook offline), eenmalig de bankhistorie importeren (CAMT.053 of CSV), budgetten per categorie en vaste lasten als verwachte posten. Bonnetjes kunnen optioneel worden gelezen met Claude Haiku.

**In English:** a personal budgeting app for a single user, self-hosted on your own server. Quick expense entry (also offline), a one-time import of your bank history (CAMT.053 or CSV), budgets per category and recurring costs as expected transactions, with optional receipt reading by Claude Haiku. The app and its documentation are in Dutch, as it targets Dutch banks, but issues and comments in English are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md#in-english) to contribute and [SECURITY.md](SECURITY.md#english) to report a vulnerability.

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

Met Node 24 (versie in `.nvmrc`) en pnpm:

```bash
pnpm install
COOKIE_SECURE=false pnpm dev
```

Daarna een setup-token maken met `DATABASE_PATH=data/budget.db pnpm setup-token` en `/setup` openen.

## Beveiliging

Kwetsbaarheden privé melden: zie [SECURITY.md](SECURITY.md).

## Licentie

[AGPL-3.0](LICENSE). Vrij te gebruiken, aan te passen en zelf te hosten. Bied je een aangepaste versie aan anderen aan via het netwerk, dan moet je hun ook de broncode van die versie aanbieden.
