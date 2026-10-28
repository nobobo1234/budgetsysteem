# iOS-opdracht "Bon naar Budget"

De opdracht voor het deelmenu van Foto's (spec: Uploaden via het deelmenu, stap 2). De app biedt hem
aan als download op het scherm Apparaten, direct nadat je een upload-token hebt aangemaakt
(`GET /instellingen/apparaten/opdracht`, alleen met sessie).

## Wat hij doet

Per gedeelde afbeelding:

1. Breder of hoger dan 2576 px: verkleinen tot 2576 px aan de lange kant. Kleiner blijft zoals het is.
2. Omzetten naar JPEG, kwaliteit 0,9, zonder metadata (camera, locatie).
3. Als ruwe body naar `POST <origin>/api/ingest` met `Authorization: Bearer <token>` en
   `Content-Type: image/jpeg`. De origin kies je bij het ondertekenen; in de code staat geen domein.
4. Geen `id` in het antwoord: melding "Bon niet verstuurd" met de foutmelding van de server, en stoppen.

Na de laatste afbeelding: een melding "Ontvangen. De bon wordt nu gelezen."

De bron is leesbaar in [`src/lib/server/receipts/shortcut.ts`](../src/lib/server/receipts/shortcut.ts);
de unit-test ernaast controleert de belangrijkste eigenschappen en dat het ondertekende bestand bij
die bron hoort.

## Waarom een ondertekend bestand en geen iCloud-link

iOS importeert sinds iOS 15 alleen ondertekende opdrachten. Er zijn twee routes:

- **Ondertekend `.shortcut`-bestand** (gekozen). `shortcuts sign --mode anyone` op een Mac die met iCloud
  is ingelogd vraagt bij Apple een certificaat aan en levert een AEA-archief op. Dat bestand staat in de
  repo (als base64 in `shortcut-signed.ts`) en de app serveert het zelf. Geen afhankelijkheid van een
  iCloud-account of een externe link, en elke wijziging gaat via een PR.
- **iCloud-link** (niet gekozen). Dan moet de opdracht eerst in je eigen bibliotheek staan en deel je
  hem via iCloud. De link wijst naar Apple, niet naar de app, en is niet te reviewen of te versioneren.

In beide gevallen zit het token niet in het bestand: de tekstactie met het token is leeg en heeft een
importvraag, zodat Opdrachten er bij het toevoegen om vraagt. Deel je een opdracht met een importvraag,
dan maakt iOS dat veld leeg; deel de opdracht toch nooit met het token erin.

## Wanneer de app hem aanbiedt

- **Juiste host.** De opdracht stuurt naar de URL waarvoor hij ondertekend is (`url` in
  `shortcut-signed.ts`). Is dat niet precies `<ORIGIN>/api/ingest` van deze app (een eigen
  installatie, lokaal, de e2e-tests), dan staat de download uit (409) en meldt Apparaten met welk
  commando je hem voor je eigen domein ondertekent. Zo stuurt een andere installatie nooit bonnen en
  tokens naar het domein van iemand anders. Een niet-ondertekende variant biedt de app niet aan:
  iOS installeert die niet.
- **Herinnering.** Vanaf 30 dagen voor `validUntil` staat er een melding op Apparaten, zegt de tegel
  op Meer "Opdracht opnieuw ondertekenen" en krijgt de tab Meer een stip. De download blijft tot die
  dag werken.
- **Verlopen.** Vanaf `validUntil` staat de download uit. Een opdracht die al op een telefoon staat,
  blijft werken; het certificaat telt alleen bij installeren.

## Opnieuw maken en ondertekenen

Nodig bij een wijziging in `shortcut.ts`, een andere host, of vóór het certificaat verloopt
(`validUntil` in `shortcut-signed.ts`, ongeveer een jaar na ondertekenen). CI kan dit niet: het vraagt
een Mac met iCloud. De unit-test faalt zodra bron en ondertekend bestand niet meer bij elkaar horen.

```bash
node scripts/sign-shortcut.ts --origin https://<jouw domein>
```

De origin moet gelijk zijn aan de origin waarmee de app gebouwd is (`ORIGIN`, bij Noah `APP_ORIGIN`
in [DEPLOY.md](DEPLOY.md)); anders staat de download in productie uit. Alleen `https://` en zonder
pad. Zonder `--origin` neemt het script `ORIGIN` uit de omgeving, en zonder allebei de host van het
huidige `shortcut-signed.ts` (opnieuw ondertekenen voor hetzelfde domein). Het script meldt welke
URL het gebruikt. Met `--bewaar <map>` krijg je ook het `.shortcut`-bestand en de bron (JSON) om zelf
te bekijken. Commit daarna `shortcut-signed.ts`.

### Eigen installatie

Host je de app op je eigen domein, dan stuurt de meegeleverde opdracht naar het domein van iemand
anders en staat de download uit. Zo maak je je eigen ondertekende opdracht:

1. Op een Mac die met iCloud is ingelogd (`shortcuts sign` vraagt het certificaat bij Apple aan; op
   de server of in CI kan dat niet), in je eigen kopie van de repo:
   `node scripts/sign-shortcut.ts --origin https://<jouw domein>`.
2. Het script overschrijft `src/lib/server/receipts/shortcut-signed.ts`. Draai `pnpm test:unit`; de
   test controleert dat het bestand bij de bron hoort.
3. Bouw de app opnieuw met dezelfde `ORIGIN` en zet hem neer. Daarna staat de download op Apparaten
   aan. Na ongeveer een jaar (of eerder bij een wijziging in `shortcut.ts`) herhaal je dit; Apparaten
   herinnert je er een maand van tevoren aan.

## Testen

- Op de Mac (macOS 26, Opdrachten 7.0) getest met een variant die naar een lokale testserver stuurt:
  importvraag verschijnt; 5000×3000 wordt 2576×1546, 1320×2868 wordt 1186×2576, 800×600 blijft;
  `Authorization` en `Content-Type: image/jpeg` komen aan; camera-EXIF is weg; drie afbeeldingen in één
  keer gaan alle drie; bij een 401 stopt hij na de eerste met de melding.
- Nog niet op een echte iPhone: downloaden vanuit Safari en vanuit de app op het beginscherm, het
  deelmenu van Foto's (HEIC-foto's, screenshots) en een upload naar productie. Loop dat na voordat de
  bonnenverwerking live gaat.
