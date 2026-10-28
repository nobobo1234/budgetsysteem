## Wat en waarom

<!-- Wat verandert er, en welk issue of welke sectie van docs/SPEC.md hoort erbij? -->

## Testen

<!-- Welke tests zijn toegevoegd of aangepast, en hoe heb je het zelf geprobeerd? -->

## Checklist

- [ ] Geen tests verwijderd, overgeslagen of afgezwakt
- [ ] Geen echte bankdata, IBANs of bonnetjes in code, fixtures of deze PR
- [ ] Nieuwe dependency? Bestaat, onderhouden, ouder dan 7 dagen, motivatie hieronder
- [ ] Wijzigingen aan CODEOWNERS-bestanden (`.github/`, `Dockerfile`, `package.json`, lockfile, `pnpm-workspace.yaml`, `CLAUDE.md`, `deploy/`) apart genoemd
- [ ] Package toegevoegd aan `allowBuilds`? Apart genoemd
- [ ] Tests voor login, token-scope of upload-validatie gemarkeerd als "ter review"
- [ ] Nieuwe migratie of omgevingsvariabele? Genoemd, zodat zelfhosters het weten
