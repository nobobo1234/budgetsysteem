# Bijdragen

Dit is een persoonlijke budgetapp van één persoon, gebouwd voor één gebruiker. Je mag hem vrij gebruiken en zelf hosten, maar de richting volgt [docs/SPEC.md](docs/SPEC.md).

- **Issues zijn welkom**: fouten, vragen over zelf hosten en ideeën. Gebruik de formulieren bij **New issue**.
- **Pull requests graag pas na overleg in een issue.** Zo voorkom je werk dat niet in de spec past.
- **Beveiligingsproblemen** meld je privé, zie [SECURITY.md](SECURITY.md).

## Lokaal ontwikkelen

Node-versie staat in [`.nvmrc`](.nvmrc); gebruik alleen pnpm.

```bash
pnpm install
pnpm lint
pnpm check
pnpm test:unit
pnpm test:integration
pnpm test:e2e
```

## Afspraken

De volledige werkafspraken staan in [CLAUDE.md](CLAUDE.md) en gelden voor mensen en AI-tools. Kort:

- Geen echte bankdata, IBANs of bonnetjes in code, fixtures, issues of PR's. Fixtures zijn geanonimiseerd met test-IBANs uit [scripts/test-ibans.txt](scripts/test-ibans.txt).
- Bedragen als hele centen (integer), queries via Drizzle met parameters, nooit `{@html}` met tekst van gebruikers of AI.
- Tests worden niet verwijderd of afgezwakt om CI groen te krijgen.
- Een nieuwe dependency krijgt een korte motivatie in de PR.
- PR's worden gesquasht; de PR-titel wordt het commitbericht.
