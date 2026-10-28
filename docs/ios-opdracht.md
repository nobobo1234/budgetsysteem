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
de unit-test ernaast controleert de belangrijkste eigenschappen. Of een ondertekend bestand bij die
bron hoort, controleert de app zelf bij het inlezen (zie hieronder).

## Waarom een ondertekend bestand en geen iCloud-link

iOS importeert sinds iOS 15 alleen ondertekende opdrachten. Er zijn twee routes:

- **Ondertekend `.shortcut`-bestand** (gekozen). `shortcuts sign --mode anyone` op een Mac die met iCloud
  is ingelogd vraagt bij Apple een certificaat aan en levert een AEA-archief op. Het script zet dat
  (als base64) in `shortcut-signed.json`, dat je in het datavolume van de app zet; de app serveert het
  zelf. Geen afhankelijkheid van een iCloud-account of een externe link. Het bestand staat niet in de
  repo: het is per domein ondertekend, en elke installatie heeft haar eigen domein. De bron waaruit
  het gemaakt wordt, gaat wel via een PR.
- **iCloud-link** (niet gekozen). Dan moet de opdracht eerst in je eigen bibliotheek staan en deel je
  hem via iCloud. De link wijst naar Apple, niet naar de app, en is niet te reviewen of te versioneren.

In beide gevallen zit het token niet in het bestand: de tekstactie met het token is leeg en heeft een
importvraag, zodat Opdrachten er bij het toevoegen om vraagt. Deel je een opdracht met een importvraag,
dan maakt iOS dat veld leeg; deel de opdracht toch nooit met het token erin.

## Wanneer de app hem aanbiedt

De app zoekt het bestand op `shortcut-signed.json` naast de database (`DATABASE_PATH`), in de
container dus `/data/shortcut-signed.json`. Een andere plek kan met `SHORTCUT_PATH`. Bij elke
aanvraag kijkt de app of het bestand veranderd is (tijd, grootte, inode) en leest het dan opnieuw
in; een nieuw bestand werkt dus meteen, zonder herstart.

- **Geen bestand.** Gewoon "nog niet geïnstalleerd": de download staat uit (404) en Apparaten
  legt uit hoe je hem ondertekent en waar het bestand moet staan. Uploaden met een token werkt wel.
- **Ongeldig bestand.** De app weigert bij elke twijfel: geen geldige JSON, andere of extra velden,
  een URL die niet precies `https://<host>/api/ingest` is, een `sourceHash` die niet bij de huidige
  bron in `shortcut.ts` hoort (bijvoorbeeld na een update van de app die de opdracht wijzigt),
  inhoud die geen ondertekend archief (AEA1) is, of een bestand groter dan 264 kB. Hetzelfde geldt als
  de gebruiker van de app (`node` in de container) het bestand niet kan lezen. Dan staat de download uit (409), meldt Apparaten
  "Opdracht ongeldig" en staat er één regel in de log (`shortcut_invalid` met een reden, of
  `shortcut_unreadable`), zonder de inhoud.
- **Juiste host.** De opdracht stuurt naar de URL waarvoor hij ondertekend is (`url` in het
  bestand). Is dat niet precies `<ORIGIN>/api/ingest` van deze app (een bestand van een andere
  installatie, lokaal, de e2e-tests), dan staat de download uit (409) en meldt Apparaten met welk
  commando je hem voor je eigen domein ondertekent. Zo stuurt een andere installatie nooit bonnen en
  tokens naar het domein van iemand anders. Een niet-ondertekende variant biedt de app niet aan:
  iOS installeert die niet.
- **Herinnering.** Vanaf 30 dagen voor `validUntil` staat er een melding op Apparaten, zegt de tegel
  op Meer "Opdracht opnieuw ondertekenen" en krijgt de tab Meer een stip. De download blijft tot die
  dag werken.
- **Verlopen.** Vanaf `validUntil` staat de download uit. Een opdracht die al op een telefoon staat,
  blijft werken; het certificaat telt alleen bij installeren.

## Ondertekenen en installeren

Nodig bij de eerste installatie, bij een wijziging in `shortcut.ts` (Apparaten meldt dan "Opdracht
ongeldig"), een ander domein, of vóór het certificaat verloopt (`validUntil` in het bestand,
ongeveer een jaar na ondertekenen; Apparaten herinnert je er een maand van tevoren aan). CI kan dit
niet: het vraagt een Mac met iCloud.

1. Op een Mac die met iCloud is ingelogd (`shortcuts sign` vraagt het certificaat bij Apple aan; op
   de server of in CI kan dat niet), in een kopie van de repo met dezelfde versie als de app:

   ```bash
   node scripts/sign-shortcut.ts --origin https://<jouw domein>
   ```

   De origin moet gelijk zijn aan de origin van de app (`ORIGIN`; bij zelf hosten `https://<DOMAIN>`). Alleen `https://` en zonder pad. Zonder `--origin` neemt het script `ORIGIN` uit de
   omgeving; zonder allebei stopt het. Het script meldt welke URL het gebruikt, controleert het
   resultaat zoals de app dat doet en schrijft `shortcut-signed.json` in de huidige map (of naar
   `--uit <pad>`), leesbaar voor iedereen (0644). Met `--bewaar <map>` krijg je ook het
   `.shortcut`-bestand en de bron (JSON) om zelf te bekijken. Het bestand bevat geen token en geen
   geheim, alleen je domein; commit het niet (`.gitignore` sluit het uit).

2. Zet het in het datavolume. Met Docker Compose (in de map met `docker-compose.yml`):

   ```bash
   docker compose cp shortcut-signed.json app:/data/shortcut-signed.json
   ```

   Dat werkt ook met de alleen-lezen container: `/data` is een volume. Het bestand krijgt je eigen
   uid en blijft 0644; de gebruiker `node` in de container moet het kunnen lezen. Wil je dat het van
   `node` is, of staat het bestand op 0600, schrijf het dan via de container zelf:

   ```bash
   docker compose exec -T app sh -c 'cat > /data/shortcut-signed.json.nieuw && mv /data/shortcut-signed.json.nieuw /data/shortcut-signed.json' < shortcut-signed.json
   ```

   Zonder Docker: zet het naast de database (of op `SHORTCUT_PATH`), leesbaar voor de gebruiker van
   de app.

3. Open Apparaten. Er staat geen melding meer en na het aanmaken van een token staat de download
   aan. Een herstart is niet nodig. Bewaar het bestand ook buiten de server: het zit wel in de
   volume-backup, maar opnieuw ondertekenen kan alleen op een Mac.

## Testen

- Op de Mac (macOS 26, Opdrachten 7.0) getest met een variant die naar een lokale testserver stuurt:
  importvraag verschijnt; 5000×3000 wordt 2576×1546, 1320×2868 wordt 1186×2576, 800×600 blijft;
  `Authorization` en `Content-Type: image/jpeg` komen aan; camera-EXIF is weg; drie afbeeldingen in één
  keer gaan alle drie; bij een 401 stopt hij na de eerste met de melding.
- Nog niet op een echte iPhone: downloaden vanuit Safari en vanuit de app op het beginscherm, het
  deelmenu van Foto's (HEIC-foto's, screenshots) en een upload naar productie. Loop dat na voordat de
  bonnenverwerking live gaat.
