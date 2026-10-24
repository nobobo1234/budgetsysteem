# Budgetapp – spec v1

Oct 23, 2026 · @Noah

## Doel en uitgangspunten

Eén persoonlijke budgetapp op je eigen VPS, waarin je een uitgave in een paar seconden invoert en op elk apparaat direct ziet hoeveel je deze maand nog vrij hebt.

- **Snel boven alles.** De app opent vanaf je beginscherm zonder wachten, opslaan voelt direct en je wacht nooit op AI. Doel: app open binnen 1 seconde, serverantwoord p95 onder 50 ms.
- **Privé.** De database staat alleen op je eigen server en is nooit rechtstreeks online bereikbaar. Naar de AI gaat alleen wat nodig is.
- **Werkt zonder AI.** Regels en code doen het meeste werk. AI vult aan en zegt het als het twijfelt.
- **Handmatig eerst.** Na één bankimport voer je zelf in. De app maakt dat zo licht mogelijk, met snelle invoer en vaste lasten als verwachte posten.

## Beslissingen

Alle keuzes liggen vast; wat nog aangeleverd moet worden staat bij Open punten.

| Onderwerp | Keuze |
| --- | --- |
| Gebruikers | Alleen jij |
| Bank | SNS, eenmalige import van de historie (CAMT.053), daarna zelf aanvullen |
| Revolut | Eigen rekening in de app; opwaarderen vanuit SNS telt als interne overboeking, niet als uitgave |
| Valuta | Alles in euro; bij dollar via Revolut optioneel het oorspronkelijke bedrag erbij |
| Budget | Simpele limiet per categorie per maand; vaste lasten die niet elke maand komen worden per maand gereserveerd |
| Categorieën | Startlijst door Claude bepaald, zelf aan te passen (zie Datamodel) |
| Toegang | Publiek via finance.mijndomein.nl achter je bestaande nginx, met passkeys en sessies van 30 dagen per apparaat; SSH alleen via Tailscale |
| Hosting | Docker op je bestaande VPS; code in een privé GitHub-repo |
| AI | Claude Haiku 5.5 voor bonnetjes en screenshots, eerst getest op je eigen bonnetjes |
| Stack | SvelteKit + SQLite, met GSAP voor animaties; Fraunces en Inter, accent smaragd #0F7B5F |

## Architectuur en stack

Eén Docker-container met app en database op je VPS, met je bestaande nginx als enige ingang vanaf internet.

&#91;embedded content: architectuur · één open poort op de VPS\]

Je apparaten praten alleen via HTTPS met nginx; database en bonnetjes zijn alleen via de app bereikbaar, en beheer loopt via Tailscale.

| Onderdeel | Keuze | Waarom |
| --- | --- | --- |
| Frontend + backend | SvelteKit (Node) als PWA | Eén codebase, snel, installeerbaar op je beginscherm |
| Database | SQLite in WAL-mode, better-sqlite3 + Drizzle | Geen netwerkpoort, queries in microseconden, backup is één bestand |
| Achtergrondtaken | `jobs`-tabel in SQLite | Geen Redis of aparte queue nodig |
| Login | Passkeys via SimpleWebAuthn | Niet te raden of te phishen |
| Grafieken | uPlot | Licht en snel op een telefoon |
| Offline | Service worker + IndexedDB-wachtrij | Invoer werkt ook zonder verbinding |
| Proxy | nginx (bestaand) | Draait al op je VPS; TLS via Let's Encrypt (certbot) |
| Backups | Litestream + restic | Doorlopend en versleuteld buiten de VPS |

Docker publiceert de app alleen op 127.0.0.1, zodat hij niet om nginx en de firewall heen bereikbaar is.

### Achter je bestaande nginx

De app past in je huidige opzet: een container die alleen lokaal luistert, en één nieuw server-blok in nginx.

- **Container.** Publiceert alleen op `127.0.0.1:3000`. Draait nginx zelf in een container, dan zitten beide in hetzelfde Docker-netwerk en publiceert de app geen poort.
- **TLS.** Certificaat via Let's Encrypt (certbot), automatisch vernieuwd; poort 80 stuurt alleen door naar HTTPS. HSTS staat in nginx.
- **Doorgestuurde headers.** nginx zet `X-Forwarded-Proto` en `X-Real-IP` zelf en overschrijft wat de client meestuurt. In de app: `ORIGIN=https://finance.mijndomein.nl` en `ADDRESS_HEADER=x-real-ip`. Dat is alleen veilig omdat nginx de header altijd overschrijft ([SvelteKit adapter-node](https://svelte.dev/docs/kit/adapter-node)). Zonder dit werken de CSRF-controle en de rate limiting op IP niet goed.
- **Groottes.** `client_max_body_size 12m` voor uploads, `25m` alleen op de import-route.
- **Eerste rem.** `limit_req` op `/login` en `/api/ingest`; de app heeft daarnaast zijn eigen limieten.
- **Compressie.** gzip of brotli in nginx in plaats van in Node; volgens de SvelteKit-docs is dat sneller.
- **Overig.** `server_tokens off`. Een default server die onbekende hostnamen direct afkapt (`return 444`), zodat scanners die je VPS op IP benaderen niets zien. De CSP komt uit SvelteKit, niet dubbel uit nginx.

## Beveiliging

De database kan niet zomaar online komen: SQLite heeft geen netwerkpoort en het bestand zit buiten elke webroute. Lekken kan alleen via een fout in de app of een overgenomen server, en daar richten de maatregelen zich op.

### Wat passkeys wel en niet doen

Een passkey maakt het inloggen zelf vrijwel onaanvalbaar. Hij kan niet geraden, hergebruikt of gephisht worden, en de geheime sleutel verlaat je apparaat nooit. De server bewaart alleen een publieke sleutel, waar een aanvaller niets mee kan.

Wat een passkey niet oplost:

- een route in de app die per ongeluk zonder login bereikbaar is;
- een lek in de app of een library;
- een overgenomen server, bijvoorbeeld via SSH of andere software op dezelfde VPS;
- een ontgrendelde telefoon met een actieve sessie in verkeerde handen.

Met de lagen hieronder is de database voor een app met één gebruiker in de praktijk goed beschermd. De zwakste plek is dan niet de login, maar andere software op dezelfde VPS en verouderde dependencies.

### Lagen

1. **Netwerk.** Alleen poort 443 (nginx) en poort 80 (doorsturen naar HTTPS en certificaatvernieuwing) staan open. De app luistert op 127.0.0.1 en de database heeft geen poort.
2. **Login.** Standaard alles dicht: elke route vereist een sessie, behalve de loginpagina zelf. Een automatische test controleert bij elke build dat elke route zonder sessie 401 geeft.
3. **Sessies.** Cookie met \_\_Host--prefix, Secure, HttpOnly en SameSite=Lax, met een willekeurige sessie-ID van 128 bits die bij elke login wordt vernieuwd. Een sessie duurt 30 dagen per apparaat. Exporteren, een upload-token aanmaken, passkeys beheren en verwijderen vragen altijd opnieuw om je passkey. Een overzicht van actieve apparaten waarmee je er één intrekt als je telefoon kwijt is.
4. **Herstel.** Een passkey op minstens twee apparaten, plus een herstelcode op papier.
5. **Bestanden.** Bonnetjes alleen op te vragen via hun ID na login, nooit via een pad uit invoer. EXIF-data (zoals locatie) gaat eraf bij uploaden.
6. **Container.** Draait niet als root, read-only bestandssysteem behalve de datavolumes, geen extra rechten.
7. **Server.** SSH alleen via Tailscale met keys, geen root-login, automatische beveiligingsupdates, firewall met alleen 443 open.
8. **Backups.** Versleuteld met restic naar opslag buiten de VPS, plus Litestream voor doorlopende replicatie. Terugzetten één keer per kwartaal testen.
9. **AI.** De API-key staat alleen op de server. Naar Haiku gaat alleen de foto; analyses krijgen geaggregeerde cijfers zonder IBANs.

Het upload-token voor het deelmenu kan alleen uploaden en niets lezen (zie Bonnetjes en koppelen). Rate limiting op de login en dependency-updates (bijvoorbeeld via Renovate of Dependabot) maken het af. Versleuteling van het databasebestand zelf voegt weinig toe: het helpt alleen als iemand de schijf of een backup steelt, en die backups zijn al versleuteld.

## Toetsing aan OWASP

Het plan dekt de OWASP Top 10:2025 grotendeels al; de toetsing voegt vooral XXE-bescherming bij de XML-import, strengere supply-chain-instellingen, foutafhandeling die dichtvalt en vaste afspraken voor AI-gegenereerde code toe.

### OWASP Top 10:2025

| Categorie | Staat al in de spec | Komt erbij |
| --- | --- | --- |
| A01 Broken Access Control | Alles dicht behalve login; test dat elke route zonder sessie 401 geeft | Alle ID's zijn willekeurige UUID's; een test dat het upload-token geen enkele andere route bereikt |
| A02 Security Misconfiguration | Alleen 443 open, container niet als root | Security headers: CSP via de ingebouwde `csp`-optie van SvelteKit, HSTS, `X-Content-Type-Options: nosniff`, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`; geen stacktraces in productie |
| A03 Software Supply Chain Failures | Dependency-audit, Trivy | pnpm met wachttijd op nieuwe versies, alleen goedgekeurde install-scripts, SBOM per build, base image vastgezet op digest, actions vastgezet op commit-SHA (zie Best practices) |
| A04 Cryptographic Failures | HTTPS via nginx, versleutelde backups | Tokens en herstelcodes alleen als hash opgeslagen; sessie-ID minstens 128 bits uit een cryptografische bron |
| A05 Injection | Queries via Drizzle | **XXE:** de CAMT-parser staat geen DTD's of externe entiteiten toe en weigert bestanden boven 20 MB; nooit `{@html}` met tekst van gebruiker of AI |
| A06 Insecure Design | Lagenmodel | Een korte abuse-case-lijst in de repo: gelekt upload-token, gestolen telefoon, kwaadaardige bon, gelekte backup |
| A07 Authentication Failures | Passkeys, rate limiting | Eisen uit de OWASP Passkey Cheat Sheet (zie Best practices) |
| A08 Software or Data Integrity Failures | Deploy via image | Eén keer bouwen en hetzelfde image uitrollen; wijzigingen aan CI, Dockerfile en `CLAUDE.md` vereisen expliciete review |
| A09 Security Logging & Alerting Failures | Audit-log | Beveiligingsgebeurtenissen loggen (login, mislukte login, nieuwe passkey, token gebruikt, rate limit) én een pushmelding bij de belangrijkste; nooit IBANs, tokens of sessie-ID's in logs |
| A10 Mishandling of Exceptional Conditions | — | Eén centrale foutafhandelaar (`handleError`); bij twijfel weigeren in plaats van doorlaten; een import is één database-transactie die bij een fout volledig terugrolt; overal limieten |

Bron: [OWASP Top 10:2025](https://owasp.org/Top10/2025/0x00_2025-Introduction/), met name [A03](https://top10.owasp.org/2025/A03_2025-Software_Supply_Chain_Failures/) en [A10](https://top10.owasp.org/2025/A10_2025-Mishandling_of_Exceptional_Conditions/).

### OWASP Top 10 voor LLM-toepassingen (2026)

| Risico (2026) | Waar het speelt | Maatregel |
| --- | --- | --- |
| LLM01 Prompt Injection | Instructies op een bon of in een screenshot; de 2026-editie noemt instructies in afbeeldingen nu expliciet | Haiku krijgt geen tools en mag alleen het vaste JSON-schema teruggeven. Een injectie kan zo hooguit verkeerde waarden opleveren, en die vangen de controles en de review-inbox op |
| LLM02 Sensitive Information Disclosure | Wat naar de API gaat | Alleen de foto; geen IBANs of transactielijsten in prompts |
| LLM03 Excessive Agency | Vraagveld en MCP-server | Aparte read-only databaseverbinding, alleen views zonder IBANs, maximaal 1000 rijen en 2 seconden per query; geen schrijfacties behalve "categorie aanpassen" via de MCP-server |
| LLM06 Unbounded Consumption | Kosten van de API | Max-tokens per aanroep, uploadlimiet per uur, een maandbudget in de app en een bestedingslimiet in de Anthropic Console |
| LLM07 Misinformation | Haiku leest een totaal of datum verkeerd | Alleen velden die zowel het model als de controles zeker noemen worden direct geboekt; de rest wacht op jou |
| LLM08 Hidden Context Exposure | Systeemprompt en configuratie | Geen geheimen of interne configuratie in prompts |
| LLM10 Improper Output Handling | AI-uitvoer in de app | Valideren met een schema (zoals Zod), behandelen als onbetrouwbare invoer, nooit als HTML renderen of in SQL plakken |

Bron: [OWASP GenAI LLM Top 10 2026](https://genai.owasp.org/resource/owasp-genai-llm-top-10-2026/) (3 augustus 2026), rangorde via [Cloud Security Alliance](https://labs.cloudsecurityalliance.org/research/csa-research-note-owasp-llm-top10-2026-incident-weighted-202/). Niet genoemd: Supply Chain, Data and Model Poisoning en Vector and Embedding Weaknesses, omdat de app geen eigen model of RAG gebruikt.

### Waar AI-gegenereerde code de mist in gaat

OWASP heeft hier een aparte cheat sheet voor ([Secure Coding with AI](https://cheatsheetseries.owasp.org/cheatsheets/Secure_Coding_with_AI_Cheat_Sheet.html)), en die beschrijft precies hoe deze app gebouwd wordt. Dit komt als vaste afspraken in `CLAUDE.md`:

- **Verzonnen packages.** AI noemt soms packages die niet bestaan, en aanvallers registreren die namen. Elke nieuwe dependency wordt gecontroleerd op bestaan, leeftijd en onderhouder, en krijgt een korte motivatie in de PR.
- **Verouderde versies.** Versies komen uit de lockfile en Renovate, nooit uit wat het model zich herinnert.
- **Tests die groen gemaakt worden.** Agents verwijderen soms falende tests of zwakken asserties af. CI markeert verwijderde tests en een dalend aantal asserties; de tests voor login, token-scope en upload-validatie schrijf of review jij zelf.
- **Wijzigingen buiten de opdracht.** Lockfile, CI-workflows, Dockerfile, `package.json`-scripts en `CLAUDE.md` vallen onder CODEOWNERS en worden altijd apart bekeken.
- **Repo-inhoud als instructie.** Issues, PR-teksten en foutmeldingen kunnen instructies voor de agent bevatten. Omdat alleen jij in de repo schrijft is dat risico klein, maar de Claude-workflow draait alleen voor jou als eigenaar.
- **Geheimen in de context.** `.env` en sleutels staan buiten de projectmap of op de deny-lijst van Claude Code; `.gitignore` beschermt niet tegen wat een agent kan lezen.
- **Onzichtbare tekens.** CI weigert bidi- en zero-width-tekens in code en commits.
- **Verantwoordelijkheid.** Jij keurt elke merge goed en bent eigenaar van de code; een groene AI-review vervangt dat niet.

## Datamodel

Bedragen staan altijd als hele centen (integer) in euro; een vreemde valuta is een extra veld, nooit de basis.

| Tabel | Belangrijkste velden |
| --- | --- |
| accounts | naam, IBAN, soort (SNS, Revolut) — eigen IBANs herkennen interne overboekingen |
| transactions | bedrag\_cent (EUR), datum, tegenpartij, tegen\_iban, omschrijving, categorie, account, bron (import / handmatig / bon / verwacht), bankreferentie (uniek), orig\_bedrag\_cent + orig\_valuta (optioneel), status (bevestigd / verwacht / te controleren), notitie |
| transaction\_splits | transactie, categorie, bedrag\_cent — ook voor "mijn deel" bij voorgeschoten bedragen |
| categories | naam, groep, telt mee voor budget (ja/nee) |
| rules | patroon op tegenpartij, IBAN of omschrijving, categorie, prioriteit |
| budgets | maand, categorie, limiet\_cent |
| reservations | vaste last, maand, bedrag\_cent, afschrijving (transactie, alleen in de afschrijfmaand) |
| receipts | bestand, ruwe AI-uitvoer, gecontroleerde velden, zekerheid per veld, transactie |
| recurring | tegenpartij, interval (maandelijks / kwartaal / halfjaarlijks / jaarlijks), verwachte dag, mediaan + min/max bedrag, soort (vast / wisselend), volgende datum, uitsmeren (ja/nee; standaard ja bij een interval langer dan een maand) |
| owed | persoon (verwijzing naar people), bedrag\_cent, richting (te krijgen / te betalen), bron-transactie, aandeel + maand (optioneel, samen uniek), status (open / deels / betaald / kwijtgescholden) |
| owed\_payments | transactie, persoon, post (leeg = tegoed), bedrag\_cent — vervangt betaald-via-transactie, zodat één betaling meerdere posten dekt en andersom |
| people | naam, actief; IBANs in `people_ibans` (persoon, iban), elke IBAN bij hooguit één persoon en nooit een eigen rekening |
| recurring\_shares | vaste last, persoon, soort (vast / percentage), bedrag\_cent of basispunten, verwachte ontvangstdag, vanaf maand, tot maand (optioneel) |
| sessions, passkeys | apparaat, laatst gebruikt, ingetrokken |
| jobs, audit\_log | achtergrondtaken; wijzigingen met ongedaan maken |

### Startcategorieën

| Groep | Categorieën |
| --- | --- |
| Vaste lasten | Wonen, Energie en water, Internet en telefoon, Verzekeringen, Abonnementen, Belastingen en gemeente |
| Dagelijks | Boodschappen, Uit eten en bezorgen, Drogist en verzorging, Huishouden |
| Onderweg | Vervoer (OV, fiets, auto, taxi) |
| Vrije tijd | Uitgaan, Sport, Hobby en entertainment, Reizen |
| Overig | Kleding, Gezondheid, Cadeaus, Elektronica, Overig |
| Buiten budget | Inkomen, Sparen en beleggen, Interne overboeking, Terugbetaling |

## Import

De historie komt binnen via één CAMT.053-export van SNS; daarna blijft importeren mogelijk, maar het is niet nodig.

**SNS.** Mijn SNS biedt downloads als PDF, CAMT.053 en CSV ([SNS](https://www.snsbank.nl/particulier/support/download-tonen-op-pagina/uitleg-van-je-transactieoverzicht-in-mijn-sns.html)). De parser leest CAMT.053, met CSV als terugvaloptie. De XML-parser staat geen DTD's of externe entiteiten toe (bescherming tegen XXE) en weigert bestanden boven 20 MB. Een import is één database-transactie: bij een fout rolt alles terug.

- Ontdubbelen op de bankreferentie; zonder referentie op een hash van datum, bedrag, tegen-IBAN en omschrijving. Dezelfde export twee keer uploaden levert dus niets dubbel op.
- Na de import een overzicht: aantal nieuw, aantal al bekend, periode, en welke tegenpartijen nog geen categorie hebben.
- De categorieregels worden meteen uit de historie voorgesteld: per tegenpartij één klik om een regel te maken.
- Een latere import wordt tegen je handmatige invoer gehouden via de koppellijst (zie Bonnetjes en koppelen), zodat niets dubbel telt.

**Revolut.** Opwaarderingen vanuit SNS naar Revolut worden herkend als interne overboeking en tellen niet mee als uitgave. De echte uitgaven staan bij Revolut; zonder Revolut-export ontbreken die in de historie. Revolut kan afschriften exporteren; het formaat controleer ik als je er één hebt.

**Valuta.** Je voert het eurobedrag in dat Revolut afschreef; het dollarbedrag is optioneel. Snelinvoer herkent `$20` als dollar en vraagt dan om het eurobedrag, of laat het later invullen (status "te controleren").

## Dagelijks gebruik

Het startscherm toont één getal, wat je deze maand nog vrij hebt, met daaronder het invoerveld; de meeste bezoeken duren zo minder dan tien seconden.

**Startscherm**

- Bovenaan: nog vrij deze maand (som van de limieten min de uitgaven en reserveringen in budgetcategorieën).
- Per categorie een balk met tempo: uitgegeven als deel van de limiet tegenover het deel van de maand dat voorbij is. Boodschappen op 70% bij dag 19 van 31 kleurt oranje. Geplande vaste lasten en reserveringen tellen niet mee in het tempo (zie Vaste lasten).
- Daaronder: verwachte vaste lasten die op bevestiging wachten en het aantal items in de review-inbox.

**Snelinvoer** — één veld, lokaal geparsed, zonder AI:

| Je typt | Wordt |
| --- | --- |
| `12,50 ah` | €12,50 bij Albert Heijn, categorie via regel |
| `$20 netflix rev` | $20 op Revolut, eurobedrag nog in te vullen |
| `45 etentje voor 3` | €45 uit eten; vraagt wie je nog moet terugbetalen |
| `+15 tikkie sanne` | €15 binnen; stelt de openstaande post van Sanne voor |

**Zoals Todoist.** Terwijl je typt, herkent een lokale parser de onderdelen en kleurt ze in het invoerveld; eronder staan ze als chips. Tik op een chip om hem aan te passen, of op het kruisje om dat stuk weer gewone tekst te maken. Parsen kost minder dan een milliseconde per toetsaanslag en gebeurt zonder netwerk of AI. Opslaan werkt ook offline en synct zodra er verbinding is.

| Herkent | Voorbeelden |
| --- | --- |
| Bedrag | `12,50`, `€12.50`, `+15` (inkomend), `$20` |
| Datum | `gisteren`, `vr`, `12/10`; zonder datum is het vandaag |
| Categorie | `#boodschappen`, anders via je regels |
| Rekening | `@rev`, `@sns` |
| Delen | `voor 3`, `met sanne` |
| Tegenpartij | De overige tekst, gekoppeld aan bekende namen (`ah` wordt Albert Heijn) |

**Veilig parsen**

- De parser werkt alleen op je eigen tekst in je eigen browser. Het grootste risico is een reguliere expressie die bij bepaalde invoer extreem traag wordt (ReDoS). Daarom een eenvoudige tokenizer zonder geneste herhalingen, en invoer van maximaal 200 tekens.
- Bedragen gaan met een strikte grammatica naar hele centen, nooit via `parseFloat`.
- De kleuring in het invoerveld is een gespiegelde laag met gewone tekst achter de input: geen `contenteditable` en geen `{@html}`.
- De server vertrouwt de parse niet. Hij krijgt losse velden, valideert ze met een schema (bedrag binnen grenzen, datum niet ver in de toekomst, categorie bestaat) en weigert de rest.
- Tests: unit-tests per grammaticaregel, plus fuzz-tests met willekeurige invoer (fast-check) die controleren dat de parser nooit crasht en altijd binnen 5 ms klaar is.

**Budget.** Een limiet per categorie per maand; een nieuwe maand neemt de limieten van de vorige over. Vaste lasten die niet elke maand komen, zoals een halfjaarlijkse contributie, worden binnen die limiet per maand gereserveerd (zie Vaste lasten).

**Saldocheck.** Omdat je na de import handmatig werkt, kunnen je cijfers ongemerkt afwijken van de bank. Eén keer per maand vul je het echte saldo van SNS en Revolut in; de app toont het verschil met wat hij verwacht. Een verschil betekent een vergeten uitgave, en dan kun je gericht zoeken of alsnog een export importeren.

**Meldingen.** Pushmeldingen via de app op je beginscherm (Web Push met VAPID-sleutels). Elke soort staat apart aan of uit:

- een verwachte vaste last staat klaar om te bevestigen;
- een bon is gelezen, of heeft je controle nodig;
- een categorie zit op 90% van de limiet (gemeten op het deel buiten geplande vaste lasten en reserveringen);
- een Tikkie staat 14 dagen open;
- de maand is voorbij en de afsluiting staat klaar.

Op het vergrendelscherm staan standaard geen bedragen of namen, tenzij je dat aanzet.

## Bonnetjes en koppelen

Haiku leest een bon of screenshot op de achtergrond; code controleert de uitkomst, en wat onzeker is komt in de review-inbox in plaats van stil in je cijfers.

### Verwerking

1. Foto of screenshot kiezen, of delen via een iOS-opdracht. De browser schaalt hem naar hooguit 2576 px aan de lange kant, comprimeert één keer licht (JPEG-kwaliteit 0,9) en haalt EXIF eraf. Het origineel blijft als archief bewaard (zie Beeldkwaliteit hieronder).
2. Upload komt direct binnen; de bon verschijnt meteen met status "wordt gelezen".
3. Job-worker stuurt de foto naar Claude Haiku 5.5 met een vast JSON-schema: winkel, datum, totaal, valuta, betaalwijze, regels (optioneel), en per veld een zekerheid plus een notitie bij wat onleesbaar is. Het model laat een veld leeg in plaats van te gokken.
4. Controles in code: totaal aanwezig en positief, datum niet in de toekomst en niet ouder dan 60 dagen, regels opgeteld gelijk aan het totaal (met kortings-, bonus- en statiegeldregels meegerekend, tolerantie €0,05).
5. Uitkomst: **zeker** (direct verwerkt), **controleren** (verwerkt, gemarkeerd) of **onzeker** (review-inbox). Een veld is alleen zeker als het model het zeker noemt én alle controles slagen.
6. Een screenshot van je bankapp kan meerdere transacties bevatten; die komen als lijst om in één keer te bevestigen.

### Beeldkwaliteit

Bonnetjes hebben kleine tekst, dus de app verkleint tot precies wat het model aankan: kleiner maakt tekst onleesbaar, groter laat de API zelf verkleinen.

- Modellen vanaf Claude 4.7 verwerken beelden tot 2576 px aan de lange kant (4784 beeldtokens); grotere beelden worden verkleind, wat kleine tekst minder leesbaar kan maken ([Claude vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)). Haiku 5.5 valt volgens die tabel in deze categorie; Claude Code controleert dat bij het bouwen.
- Lange bonnen (meer dan ongeveer 3,5 keer zo lang als breed) worden in overlappende stukken gesneden, elk binnen die grens, en als "Deel 1", "Deel 2" in één verzoek meegestuurd. Zo blijft de tekst groot genoeg.
- Bijsnijden tot de bon zelf (randdetectie in de browser) levert meer leesbare pixels op dan een foto met de tafel eromheen.
- Eén keer comprimeren, niet vaker: volgens de docs kan zware of herhaalde JPEG-compressie tekst onleesbaar maken.
- Het origineel (EXIF verwijderd, één keer opnieuw gecodeerd) blijft in het archief; de interface gebruikt een kleine preview.
- Het testplan vergelijkt drie varianten op je eigen bonnen: 1600 px, 2576 px en in stukken. De beste wordt de standaard.

### Uploaden via het deelmenu

Een iOS-opdracht in het deelmenu van Foto's stuurt een bon met een apart upload-token naar één endpoint dat alleen kan uploaden. Lekt het token, dan kan iemand hooguit rommel in je review-inbox zetten, maar niets lezen of wijzigen.

1. **Token aanmaken.** In de app onder Apparaten: 32 willekeurige bytes (256 bits), één keer getoond, in de database alleen als hash opgeslagen. Per token zie je wanneer het laatst gebruikt is, en je trekt het met één tik in.
2. **De opdracht.** Ontvangt afbeeldingen uit het deelmenu, zet ze om naar JPEG, schaalt ze naar hooguit 2576 px aan de lange kant en verstuurt ze als POST naar `https://finance.mijndomein.nl/api/ingest` met de header `Authorization: Bearer <token>`. De app biedt de opdracht als download aan, zodat je hem niet zelf hoeft te bouwen.
3. **Wat het token mag.** Alleen `POST /api/ingest`, alleen JPEG en PNG, maximaal 10 MB per bestand en 30 uploads per uur. De server controleert de bestandshandtekening, encodeert de foto opnieuw en slaat hem op onder een eigen UUID. De opdracht stuurt de foto als ruwe body (image/jpeg) en niet als formulier, zodat de CSRF-controle van SvelteKit voor formulieren er niet tussen komt. Het antwoord is alleen "ontvangen" met een ID, nooit data.
4. **Daarna.** De bon komt binnen met het label "via deelmenu" en doorloopt dezelfde verwerking door Haiku. Je krijgt een pushmelding zodra hij gelezen is.
5. **Bewaking.** Meer dan 30 uploads in een uur blokkeert het token tijdelijk en stuurt je een melding.

Deel de opdracht nooit met het token erin; bij een nieuw apparaat maak je een nieuw token aan.

### Testplan voordat het live gaat

- 25 tot 30 eigen bonnetjes, gemengd: supermarkt met bonuskorting, horeca met fooi, kreukelig, een Revolut-screenshot in dollar.
- Per bon de juiste winkel, datum en totaal met de hand vastleggen.
- Een script meet per veld hoe vaak Haiku het goed heeft, en vooral: hoe vaak "zeker" toch fout was.
- Doel: bij "zeker" minstens 98% goed op het totaal. Halen we dat niet, dan gaat elke bon langs de review-inbox, of we scherpen de prompt en controles aan.

### Koppellijst

Bij een bon, een binnenkomende betaling of een latere bankimport toont de app de mogelijke tegenhangers als lijst, gesorteerd op een score:

| Signaal | Gewicht | Hoe |
| --- | --- | --- |
| Bedrag | 50% | exact = vol; tot 2% of €1 verschil (fooi) = gedeeltelijk |
| Datum | 30% | 0 dagen = vol, aflopend tot 0 bij 5 dagen verschil |
| Naam | 20% | genormaliseerde tegenpartij, fuzzy match ("AH 1234 UTRECHT" ≈ "Albert Heijn") |

De lijst toont maximaal vijf kandidaten met een label (waarschijnlijk, mogelijk, onwaarschijnlijk) en altijd de optie "nieuwe transactie". De bovenste is alleen voorgeselecteerd als hij duidelijk voorloopt (score boven 0,9 en 0,3 voor op de tweede); anders kies je zelf. De gewichten stellen we bij na de test.

## Vaste lasten

Een vaste last is een aanbieder die met een vast ritme rond dezelfde dag afschrijft; het bedrag mag wisselen. Omdat je na de import zelf invoert, maakt de app ze op hun eigen ritme aan als verwachte posten die je met één tik bevestigt.

**Herkennen** (uit de import en je eigen invoer):

- Groeperen op tegenpartij en tegen-IBAN.
- Een vast ritme, met genoeg herhalingen in de historie:

| Ritme | Interval tussen afschrijvingen | Minimaal |
| --- | --- | --- |
| Maandelijks | 28 tot 35 dagen | 3 keer in de laatste 6 maanden |
| Kwartaal | 85 tot 95 dagen | 3 keer in de laatste 6 maanden |
| Halfjaarlijks | 150 tot 215 dagen; bij drie afschrijvingen liggen de eerste en de derde 350 tot 380 dagen uit elkaar | 2 keer, de laatste hooguit 7 maanden geleden |
| Jaarlijks | 350 tot 380 dagen | 2 keer; dat vraagt meer dan een jaar historie |

- Halfjaarlijks is bewust ruim: verenigingen en opleidingen schrijven vaak per semester af (bijvoorbeeld september en februari), dus de twee helften van het jaar hoeven niet even lang te zijn. De volgende datum is dezelfde maand als een jaar eerder als de historie dat laat zien, anders de vorige afschrijving plus het laatste interval; je past hem aan bij het bevestigen van het voorstel.
- Dag van de maand wijkt hooguit 4 dagen af van de mediaan; een weekend schuift de afschrijving soms op.
- Bedrag: als de spreiding binnen 5% blijft heet hij **vast**, anders **wisselend** (zoals energie of telefoon). Bewaard worden de mediaan en het minimum en maximum.
- Kandidaten verschijnen als voorstel ("Is Vattenfall een vaste last?"); er wordt niets toegevoegd zonder je bevestiging.

**Verwachte posten**

- Op de verwachte dag staat er een post met status "verwacht" en het mediane bedrag. Eén tik bevestigt; bij een wisselende last pas je eerst het bedrag aan.
- Een kwartaal-, halfjaarlijkse of jaarlijkse last krijgt alleen in de afschrijfmaand een post; in de maanden ervoor wordt er gereserveerd (zie hieronder).
- Verwachte posten tellen al mee in de verwachting voor het einde van de maand, maar pas na bevestiging in je uitgaven.
- Niet bevestigd 7 dagen na de verwachte dag: naar de review-inbox als "gemist of opgezegd?".

**Signalen**

- Vaste last 2% of meer duurder dan vorige keer: prijsverhoging.
- Wisselende last boven 120% van het hoogste bedrag tot nu toe: uitschieter.
- Overzicht: alle vaste lasten met bedrag per maand (een halfjaarlijkse last voor een zesde), totaal per maand en wat ze per jaar kosten.

### Vaste lasten die niet elke maand komen

Een kwartaal-, halfjaarlijkse of jaarlijkse vaste last wordt standaard uitgesmeerd: elke maand gaat er een deel opzij als reservering, en de afschrijving zelf komt uit die reservering. Zo klopt "nog vrij" elke maand en geeft de afschrijfmaand geen piek.

**Afweging**

| Aanpak | Voordeel | Nadeel |
| --- | --- | --- |
| Piek in de afschrijfmaand (die maand een hogere limiet) | Geen nieuw begrip; het budget volgt de bank | De maanden ervoor lijkt er meer vrij dan er is; in de afschrijfmaand springen tempo en "nog vrij"; de volgende maand neemt de verhoogde limiet over |
| Aparte categorie met een jaarbudget | Het jaartotaal klopt | Een tweede soort budgetperiode naast de maandlimiet; tempo per maand zegt niets; "nog vrij deze maand" ziet het geld niet |
| **Uitsmeren met een reservering per maand (gekozen)** | "Nog vrij" klopt elke maand; de afschrijfmaand is rustig; de limiet blijft een maandlimiet | Eén extra begrip (reservering) en wat rekenwerk bij een afwijkend bedrag |

**Hoe de reservering werkt**

- Reservering deze maand = (verwacht bedrag − al gereserveerd) gedeeld door het aantal maanden tot en met de afschrijfmaand, naar beneden afgerond op hele centen. De laatste maand neemt zo vanzelf de rest. Een halfjaarlijkse post van €90 met gelijke helften is €15 per maand.
- De reservering wordt aan het begin van de maand aangemaakt, samen met de verwachte posten, en telt vanaf de eerste van de maand als uitgave in de categorie. Het is geen transactie: saldocheck en bankimport merken er niets van. Een afgesloten maand verandert niet meer.
- Instappen halverwege werkt met dezelfde formule: bevestig je de vaste last twee maanden voor de afschrijving, dan gaat er in elk van die twee maanden de helft opzij. Ongelijke semesters (vijf en zeven maanden) lossen zich ook zo op.
- In de afschrijfmaand gaat de bevestigde afschrijving van de reservering af, niet van de limiet. Het verschil telt in die maand als uitgave in de categorie: duurder dan gereserveerd is een extra uitgave, goedkoper geeft de rest terug. Daarna begint de reservering weer bij nul.
- Een prijsverhoging (zie Signalen) past het verwachte bedrag aan; de volgende reserveringen schuiven vanzelf mee.
- Stopt de vaste last, dan valt wat al gereserveerd is vrij in die maand.
- Bij de vaste last en in de categorie zie je de stand: "€60 van €90 opzij, afschrijving rond 1 februari".
- Uitsmeren staat per vaste last uit te zetten; dan krijgt de afschrijfmaand gewoon de piek. Maandelijkse vaste lasten worden nooit uitgesmeerd.
- Unit-tests dekken de berekening: afronding, instappen halverwege, ongelijke semesters, een duurdere en een goedkopere afschrijving, en stoppen.

**Tempo met vaste lasten**

Het tempo meet alleen het deel van de limiet dat niet al gepland is. Gepland zijn de reserveringen en de verwachte of bevestigde vaste lasten van die maand in de categorie.

- De balk toont het geplande deel als eigen segment (lichter tot het bevestigd is) en daarnaast het vrije deel met tempo.
- Tempo = overige uitgaven gedeeld door (limiet − gepland), tegenover het deel van de maand dat voorbij is.
- Een categorie met alleen geplande posten heeft geen tempo; de balk kleurt alleen als de categorie over de limiet gaat.
- Is de limiet lager dan wat gepland is, dan meldt de budgetpagina dat en stelt hij een limiet voor.
- Dit geldt voor alle vaste lasten: ook huur op de eerste van de maand kleurt de balk niet meer oranje.

**Voorbeeld: vereniging** (bedragen verzonnen)

Een categorie Vereniging (zelf aan te maken, bijvoorbeeld in de groep Vrije tijd) met twee vaste lasten: de contributie van €90 in januari en juli, en het dispuut van €8 per maand. De limiet is €23 (€15 reservering + €8 dispuut), of hoger als je borrels ook hier boekt; alleen dat extra deel krijgt tempo. Elke maand gaat er €15 opzij en wordt €8 bevestigd. In januari komt de €90 uit de reservering; de balk ziet er die maand uit als elke andere.

## Nog te krijgen

Alleen jouw deel van een voorgeschoten betaling telt mee in je budget; de rest staat als openstaande post per persoon tot de Tikkie binnen is.

- **Voorschieten.** Bij een uitgave tik je "voorgeschoten" en kies je per persoon een bedrag, of "gelijk verdelen over 3". Jouw deel blijft in de categorie; de rest gaat naar Te krijgen.
  - **Gelijk verdelen.** Het aantal is altijd inclusief jou: `voor 3` is jij plus twee anderen, `met sanne en tim` ook. Jouw deel is het totaal gedeeld door het aantal, naar beneden afgerond op hele centen. De rest gaat gelijk over de anderen, en de restcenten één voor één naar de anderen in de volgorde waarin je ze noemt. €10 voor 3 met Sanne en Tim: jij €3,33, Sanne €3,34, Tim €3,33. Samen altijd precies het totaal.
  - **Bedrag per persoon.** Je vult de bedragen van de anderen in; jouw deel is wat overblijft. Samen meer dan het totaal wordt geweigerd; jouw deel mag nul zijn, niet negatief.
- **Overzicht.** Totaal openstaand, per persoon, en hoe lang het al openstaat. Optioneel een Tikkie-link of notitie bij de post.
- **Ontvangen.** Bij binnenkomend geld (`+15 tikkie sanne`) stelt de koppellijst de openstaande posten voor, gesorteerd op bedrag en naam. Een gedeeltelijke betaling laat de rest open.
- **Andersom.** Dezelfde opzet werkt voor "nog te betalen", als jij iemand nog geld schuldig bent.
- **Herinnering.** Na 14 dagen open komt de post in de review-inbox; later ook als pushmelding.

## Gedeelde vaste lasten

Een vaste last die je voor het hele huis betaalt, zoals de wifi, krijgt een aandeel per huisgenoot. Hun maandelijkse overboekingen worden daaraan gekoppeld, zodat je per persoon ziet wat er binnen is en wat nog mist. Het bouwt op Vaste lasten en Nog te krijgen: elk maandaandeel is een gewone openstaande post.

**Instellen**

- **Personen.** Een persoon heeft een naam en nul of meer tegen-IBANs. Nog te krijgen gebruikt dezelfde personen, dus `+20 sanne` en de wifi van Sanne komen op één plek uit.
- **Aandeel.** Per gedeelde vaste last en per persoon: een vast bedrag in centen (standaard, want een periodieke overboeking is ook een vast bedrag) of een percentage voor wisselende lasten zoals energie. Een percentage staat als hele basispunten (2500 = 25%); het aandeel wordt naar beneden afgerond op hele centen en de restcent is van jou. Elk aandeel heeft een verwachte ontvangstdag, een startmaand en optioneel een eindmaand. Aandelen samen mogen niet meer zijn dan het bedrag van de last.
- **Voorstel uit de historie.** Een inkomende overboeking die volgens de regels van Vaste lasten maandelijks terugkomt van dezelfde IBAN, met een bedrag tussen 10% en 90% van een actieve vaste last, wordt een voorstel ("Krijg je van S. elke maand €20 voor Ziggo?"). Er wordt niets toegevoegd zonder je bevestiging. De herkenning van vaste lasten zelf kijkt alleen naar uitgaande bedragen.
- **Terugwerkend.** Ligt de startmaand in het verleden, dan maakt de app de posten vanaf die maand aan en koppelt hij de overboekingen uit de historie één keer met dezelfde regels als hieronder.

**Elke maand**

- Zodra de verwachte post van de gedeelde last verschijnt, krijgt elke persoon met een actief aandeel een openstaande post voor die maand. Bij een percentage wordt de post herberekend als je het echte bedrag bevestigt.
- Omdat je na de import zelf invoert, zie je de overboekingen van huisgenoten niet vanzelf. Op de verwachte ontvangstdag staat de post daarom klaar om met één tik als ontvangen te bevestigen; dat boekt een inkomende transactie in de categorie Terugbetaling.
- Bij een import of handmatige invoer koppelt de app automatisch als de tegen-IBAN bij precies één persoon hoort en het bedrag gelijk is aan wat die persoon openstaat. Dat staat in het audit-log en is met één tik ongedaan te maken. Anders stelt de koppellijst de openstaande posten voor; een bekende IBAN van de persoon telt daar als volle score op naam. Koppel je een betaling van een onbekende IBAN, dan vraagt de app of die bij de persoon hoort.
- Een betaling wordt verdeeld over de openstaande posten van die persoon, oudste eerst. Wat overblijft is tegoed en gaat automatisch naar de volgende post. Zo telt een overboeking op de 28e voor de wifi van de 1e gewoon voor die volgende maand.

**Budget: netto.** De afschrijving staat bruto in de transactielijst en de saldocheck, zoals bij de bank. In het budget telt alleen jouw deel: de transactie krijgt splits, met jouw deel in de categorie van de vaste last en de aandelen in Terugbetaling (buiten budget). Dat is dezelfde regel als bij voorschieten, en je budget schommelt zo niet mee met wanneer huisgenoten betalen. Omdat de inkomende overboekingen ook in Terugbetaling staan, is het saldo van die categorie precies wat er nog openstaat. Bruto tot het geld binnen is zou een late overboeking als overschrijding tonen en de maand erna als meevaller. Het overzicht van vaste lasten toont beide: "Ziggo €60, jouw deel €20".

**Overzicht Terugbetalingen**

- Bovenaan de totale achterstand (vervallen en niet volledig betaald) en het tegoed.
- Per persoon de laatste zes maanden als vakjes: binnen, deels, open, te laat of kwijtgescholden, met tekst of icoon en niet alleen met kleur. Daarnaast verwacht tegenover ontvangen over die periode en de achterstand in euro.
- Per gedeelde last het bruto bedrag, de aandelen en jouw deel.
- Tik op een maand voor de gekoppelde betalingen, om een koppeling aan te passen of om kwijt te schelden. De app stuurt huisgenoten zelf niets; herinneren doe je zelf, eventueel met een Tikkie-link bij de post.

**Randgevallen**

| Geval | Wat de app doet |
| --- | --- |
| Te laat | Niet volledig binnen 7 dagen na de verwachte ontvangstdag: status "te laat", naar de review-inbox en optioneel een pushmelding met een eigen schakelaar |
| Ander bedrag | Minder: de post wordt "deels" en de rest blijft open. Meer: het verschil wordt tegoed |
| Dubbel betaald | De tweede betaling wordt tegoed en de review-inbox meldt het eenmalig; je laat het staan of maakt er een post "te betalen" van |
| Bedrag van de last verandert | Het prijsverhogingssignaal vraagt ook of de aandelen mee moeten, met een voorstel per persoon en een ingangsmaand. Een vast aandeel verandert nooit vanzelf, net als de overboeking van je huisgenoot; een percentage volgt automatisch, en past de overboeking dan niet meer, dan wordt de post "deels" |
| Huisgenoot vertrekt | Eindmaand op het aandeel: geen nieuwe posten, openstaande blijven tot ze betaald of kwijtgescholden zijn. Een latere overboeking wordt tegoed en komt in de review-inbox. Vanaf die maand stijgt jouw deel, tot je een nieuw aandeel toevoegt |
| Kwijtschelden | Het deel gaat in de oorspronkelijke maand alsnog naar de categorie van de vaste last; staat in het audit-log en is ongedaan te maken |
| Last gemist of opgezegd | Zonder afschrijving geen posten; een overboeking die toch binnenkomt wordt tegoed |

**Privacy.** IBANs van huisgenoten zijn persoonsgegevens van anderen: nooit in logs of naar AI, en niet in de views voor het vraagveld en de MCP-server, waar alleen de naam staat. Op het vergrendelscherm staan ook hier standaard geen namen of bedragen. Test-fixtures gebruiken alleen test-IBANs.

**Tests.** Unit: verdeling in centen met afronding, toewijzing oudste eerst met tegoed, status per maand, voorstellen uit de historie. Integratie: een import koppelt een overboeking automatisch en ontdubbelt tegen een al met één tik bevestigde ontvangst.

## Analyses

De vaste analyses draaien als SQL op je eigen server en zijn direct; AI komt er later bovenop voor vragen en samenvattingen.

**Zonder AI**

- Maandoverzicht: limiet tegenover uitgegeven per categorie, met reserveringen apart zichtbaar.
- Trend over 12 maanden per categorie.
- Topuitgaven per tegenpartij, per maand en per jaar.
- Vaste lasten: totaal per maand en als deel van je uitgaven.
- Verwachting einde maand: uitgegeven + verwachte vaste lasten (bij uitgesmeerde lasten de reservering in plaats van de afschrijving) + je gemiddelde variabele uitgaven per resterende dag.
- Jaaroverzicht, en wat een tag (bijvoorbeeld een reis) in totaal kostte.

**Met AI** (later)

- Maandsamenvatting: wat viel op tegenover vorige maanden. Het model krijgt alleen totalen per categorie en tegenpartij, geen IBANs.
- Vraagveld ("hoeveel gaf ik dit jaar uit aan uit eten?"): het model schrijft een query op views zonder IBANs, die draait op een aparte read-only verbinding met maximaal 1000 rijen en 2 seconden. Je ziet de query en het resultaat, zodat je kunt nagaan waar het getal vandaan komt.
- Een eigen MCP-server, zodat je dezelfde vragen vanuit Claude kunt stellen.

## Design en interactie

De app krijgt de verzorgde, eigenzinnige uitstraling van Awwwards-sites, maar blijft een gereedschap dat je dagelijks gebruikt. Animatie ondersteunt elke actie en houdt hem nooit op.

**Stijl**

- Grote, zelfverzekerde typografie: één display-font met karakter voor koppen en het hoofdgetal, één rustige font voor de interface. Cijfers in tabular figures, zodat bedragen netjes onder elkaar staan.
- Veel witruimte, een beperkt palet met één accentkleur, en een licht en een donker thema.
- Het getal "nog vrij deze maand" is de held van het startscherm: groot, en het telt vloeiend mee bij elke wijziging.
- Geen eyebrows: geen kleine labels of hoofdletterregels boven titels. Een titel staat op zichzelf; context hoort in de titel of in de tekst eronder.
- Mobiel eerst en binnen bereik van je duim: de belangrijkste acties onderin. Op desktop meer kolommen via container queries.
- Lege staten en foutmeldingen krijgen dezelfde zorg, met altijd een volgende stap.

**Micro-interacties**

- Snelinvoer: de chips voor bedrag, naam en categorie verschijnen terwijl je typt.
- Opslaan: de knop veert kort in en de nieuwe post schuift de lijst in, terwijl hij op de achtergrond wordt opgeslagen.
- Budgetbalken vullen met een veer-easing; nadert een categorie de limiet, dan verloopt de kleur geleidelijk.
- Swipen op een transactie bevestigt hem of wijzigt de categorie; een verwachte post afvinken geeft een korte vink-animatie.
- Een bon die wordt gelezen toont een rustige laadstaat die overgaat in de herkende velden.
- Elke reactie op een tik is binnen 100 ms zichtbaar; een animatie loopt altijd tegelijk met de actie, nooit ervoor.

**Techniek**

- Moderne CSS waar die volstaat: View Transitions voor schermovergangen (via `onNavigate` in SvelteKit), scroll-driven animations voor lijsten en grafieken, `@starting-style` voor sheets en dialogen, container queries, `:has()`, kleuren in `oklch()` en anchor positioning voor tooltips en menu's. Met een nette terugval waar een browser iets nog niet ondersteunt.
- GSAP voor wat CSS niet goed kan: tellende getallen, Flip bij het herordenen van lijsten, timelines voor het opbouwen van grafieken en SplitText voor koppen bij grote momenten zoals de maandafsluiting. GSAP wordt pas geladen na de eerste weergave.
- Alleen `transform` en `opacity` animeren, op 60 fps op een middenklasse telefoon.
- Bij `prefers-reduced-motion` worden animaties korte fades of vallen ze weg.
- Toegankelijk: contrast volgens WCAG AA, zichtbare focusstijlen, alles bereikbaar met het toetsenbord en tikdoelen van minstens 44 px.
- Performance-budget: de eerste JavaScript-bundel blijft onder 100 kB gzip, bewaakt in CI.

### Typografie en kleur

Geen monospaced fonts, ook niet voor bedragen: cijfers staan netjes onder elkaar via `font-variant-numeric: tabular-nums` in een proportioneel font. Fonts worden zelf gehost (bijvoorbeeld via Fontsource) en niet van Google Fonts geladen, zodat er geen verzoek met je IP-adres naar Google gaat en de CSP strikt kan blijven.

| Voorstel | Display-font | Interface-font | Accent | Achtergrond / tekst | Karakter |
| --- | --- | --- | --- | --- | --- |
| A · Redactioneel | Fraunces | Inter | Smaragd `#0F7B5F` | `#F6F3EE` / `#141414` | Warm, rustig, als een tijdschrift |
| B · Galerie | Instrument Serif | Inter Tight | Signaaloranje `#FF4F1F` | `#FAFAF7` / `#111111` | Strak, veel contrast |
| C · Grotesk | Bricolage Grotesque | Inter | Limoen `#C8F135` | `#101110` / `#F2F2EE`, donker eerst | Uitgesproken, speels |

Gekozen: voorstel A. Fraunces voor koppen en het hoofdgetal, Inter voor de interface, accent smaragd #0F7B5F op #F6F3EE met tekst #141414; het donkere thema krijgt een lichtere smaragd. Claude Code controleert of Fraunces tabular figures heeft; zo niet, dan krijgt het hoofdgetal de interface-font. Het accent wordt vastgelegd in `oklch()` met een licht- en een donkervariant die WCAG AA halen; tekst op limoen of oranje is altijd donker.

## Telemetrie en monitoring

Alleen een securitylog is niet genoeg: je wilt ook weten of de app werkt, of de backups lopen, of hij snel blijft en hoe goed Haiku leest. Alles blijft op je eigen server, zonder trackers of analytics van derden. In welke fase welk onderdeel komt, staat bij Fasering.

| Wat | Waarom | Hoe |
| --- | --- | --- |
| Fouten | Crashes en mislukte jobs merk je anders niet | De centrale foutafhandelaar schrijft naar een `errors`-tabel (zonder persoonsgegevens) en stuurt een pushmelding bij een nieuw soort fout |
| Beschikbaarheid | Als de VPS plat ligt, kan de app je zelf niet waarschuwen | Een externe check: een dienst die alarm slaat als de app 15 minuten niet heeft gepingd, of Uptime Kuma op een ander apparaat |
| Backups | Een backup die stil faalt merk je pas als je hem nodig hebt | Leeftijd van de laatste Litestream-replicatie en restic-snapshot in de health check; melding als die te oud is |
| Server | Een volle schijf breekt SQLite | Schijfruimte, geheugen en container-restarts; melding boven 80% schijfgebruik |
| Snelheid in de praktijk | Lighthouse meet in het lab, niet op je telefoon | De PWA meet INP en LCP met web-vitals en stuurt die naar een eigen endpoint; p75 per week op de statuspagina |
| AI | Kosten en kwaliteit | Per Haiku-aanroep: tokens, kosten, duur, uitkomst (zeker, controleren, onzeker) en of je velden achteraf corrigeerde; zo zie je de nauwkeurigheid over tijd |
| Je eigen gebruik | Volhouden | Dagen met invoer en tijd van openen tot opslaan, alleen voor jezelf |

**Afspraken**

- Gestructureerde JSON-logs (bijvoorbeeld pino), zonder IBANs, bedragen, omschrijvingen, tokens of sessie-ID's.
- Telemetrie in een aparte SQLite-database met een bewaartermijn van 90 dagen.
- `/healthz` geeft publiek alleen "ok" terug; de uitgebreide statuspagina staat achter de login.
- Meldingen gaan via dezelfde pushmeldingen als de rest van de app, met een eigen schakelaar.

## Tests en CI

Elke pull request draait lint, typecheck en drie testlagen, en wordt gereviewd door Claude. Een merge naar main deployt automatisch naar de VPS via Tailscale, met een automatische rollback als de health check faalt.

### Testlagen

| Laag | Tool | Wat | Aandeel |
| --- | --- | --- | --- |
| Unit | Vitest | CAMT- en CSV-parser, snelinvoer-parser, koppelscore, herkenning van vaste lasten, budget- en tempoberekening, categorieregels, validatie van de Haiku-uitvoer | \~50% |
| Integratie | Vitest met echte SQLite (tijdelijk bestand) | API-routes, import met ontdubbelen, elke route zonder sessie geeft 401, upload-token mag alleen uploaden, jobs met een nagebootste Haiku, migraties | \~40% |
| E2E | Playwright (Chromium en WebKit, telefoonformaat) | inloggen met een virtuele passkey, snelinvoer, offline invoeren en synchroniseren, import, bon uploaden tot de review-inbox, verwachte post bevestigen | \~10% |
| Haiku-eval | eigen script | 25 tot 30 gelabelde bonnetjes, nauwkeurigheid per veld | apart, handmatig of wekelijks |

De Haiku-eval draait niet bij elke PR, omdat hij API-tegoed kost en echte bonnetjes nodig heeft. In alle andere tests is Haiku nagebootst.

### Pipeline (GitHub Actions)

1. **Elke push:** lint (ESLint, Prettier), typecheck (`svelte-check`) en unit-tests.
2. **Elke pull request:** daarnaast integratie- en e2e-tests, Docker-build, dependency-audit, image-scan (Trivy), geheimen-scan (gitleaks), statische analyse (Semgrep), workflow-check (zizmor), een check op verwijderde tests en onzichtbare tekens, een SBOM (CycloneDX) en het performance-budget (Lighthouse CI).
3. **Review door Claude:** de Claude Code GitHub Action reviewt een PR op beveiliging, testdekking en de afspraken uit deze spec, zodra je het label `claude-review` zet. Geen `@claude` in issues of reacties: die trigger (`issue_comment`) ziet zizmor als fundamenteel onveilig. Instellen vanuit Claude Code met `/install-github-app`. De spec en de werkafspraken staan in `CLAUDE.md` in de repo.
4. **Merge naar main:** image naar GitHub Container Registry, backup van de database, deploy via SSH over Tailscale (een tijdelijke Tailscale-node in de action), migraties, health check, en bij een fout terug naar de vorige image.

### Afspraken

- `main` alleen via een PR met groene checks.
- Nooit echte bankdata of bonnetjes in de repo. Test-fixtures zijn geanonimiseerd; de echte CAMT-export blijft buiten git. Een CI-check zoekt naar echte IBAN-patronen die niet op de lijst met test-IBANs staan.
- Geheimen (Anthropic-key, VAPID-sleutels, deploy-key) alleen in GitHub Secrets en in de omgeving op de VPS.

### Uitrol (CD)

Er zit continuous deployment in: elke merge naar `main` staat binnen een paar minuten live, zonder dat er een langlevend geheim voor je VPS in GitHub staat.

1. **Bouwen.** Eén job bouwt het image één keer, maakt de SBOM en pusht naar GitHub Container Registry. Alleen deze job krijgt `packages: write`.
2. **Registry.** Het package is privé en gekoppeld aan de privé-repo, waarvan het de rechten en zichtbaarheid overneemt ([GitHub Packages](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages)). Uitgerold wordt altijd op digest (`sha256:…`), nooit op een tag als `latest`. Pro bevat 2 GB Packages-opslag; een opruimstap houdt de laatste 10 images.
3. **Verbinden.** De deploy-job draait in de `production`-environment (alleen vanaf `main`) en komt via de Tailscale GitHub Action als tijdelijke node op je tailnet. Met workload identity federation gebruikt die het OIDC-token van GitHub, dus er hoeft geen Tailscale-secret in GitHub ([Tailscale](https://tailscale.com/docs/integrations/github/github-action)). De node krijgt `tag:ci` en wordt na de job automatisch verwijderd.
4. **Afschermen.** De Tailscale-ACL laat `tag:ci` alleen poort 22 van de VPS bereiken, als gebruiker `deploy`, via Tailscale SSH; er staat dus ook geen SSH-key in GitHub. Die gebruiker mag via sudo precies één script draaien: `deploy-budget <digest>`.
5. **Uitrollen.** Het script logt in bij de registry met het kortlevende `GITHUB_TOKEN` van de job (alleen lezen, verloopt na de job), haalt het image op digest op en logt weer uit. Daarna een backup, migraties, de nieuwe container starten en een health check; mislukt die, dan gaat de vorige digest terug.

**Wat nog gevoelig is.** Wie naar `main` kan pushen, kan uitrollen. Daarom staan branch protection en CODEOWNERS op `.github/`, en draait de Claude-review in een aparte workflow zonder toegang tot de `production`-environment. Lukt workload identity federation niet, dan is de terugval een Tailscale OAuth-client die alleen auth keys voor `tag:ci` mag aanmaken, als environment secret.

### Kosten van de Claude Code Action

De action zelf is open source en gratis; de kosten zitten in twee dingen.

- **GitHub Actions-minuten** uit je 3000 per maand.
- **Claude-gebruik**: via een API-key (per token, met een bestedingslimiet in de Console) of via je abonnement met een token uit `claude setup-token`. De action draait op de Agent SDK, en volgens het helpartikel (update van 7 oktober 2026) kun je de Agent SDK met je abonnementslimieten blijven gebruiken; Max en Team krijgen daarnaast maandelijkse API-credits ([Claude Help Center](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)). Deze regels zijn in 2026 meerdere keren veranderd, dus check het artikel bij het instellen.
- **Zuinig houden:** review alleen op verzoek (het label `claude-review`), met `--max-turns` en een timeout.

### GitHub Pro (via Education)

Met Pro kan de repo privé blijven met branch protection en een beveiligde productie-omgeving; de scanners van GitHub zelf (CodeQL en secret scanning) zijn voor privé-repo's niet inbegrepen, dus die vervangen we door open-source tools.

| Wat | Privé-repo op Pro | Gevolg voor de pipeline |
| --- | --- | --- |
| Actions-minuten | 3000 per maand | Ruim genoeg voor één persoon; alleen Linux-runners (Playwright draait WebKit ook op Linux), pnpm-cache aan |
| Protected branches, CODEOWNERS | Ja | `main` alleen via PR met groene checks; CODEOWNERS op `.github/`, Dockerfile, `package.json` en `CLAUDE.md` |
| Verplichte reviewers | Ja, maar je kunt je eigen PR niet goedkeuren | Verplicht status checks in plaats van een approval, anders blokkeer je jezelf |
| Environments met eigen secrets en branch-regel | Ja | Een `production`-environment die alleen vanaf `main` mag; Tailscale-sleutel en SSH-key alleen daar |
| Goedkeuring of wachttijd vóór deploy | Nee (alleen publieke repo's of Enterprise) | Deploy gebeurt automatisch na merge; de PR-checks zijn de poort |
| CodeQL en secret scanning met push protection | Nee (vereist Team of Enterprise met GitHub Code Security / Secret Protection) | Semgrep CE voor statische analyse, gitleaks voor geheimen (ook als pre-commit hook), zizmor voor de workflows zelf |
| Dependabot alerts | Ja | Aan, met een cooldown van 7 dagen op updates |

De repo blijft privé. Publiek maken zou CodeQL, secret scanning en deploy-goedkeuring gratis opleveren, maar dan is je code zichtbaar; de tools hierboven dekken hetzelfde af.

**Extra afspraken voor de workflows** ([OWASP GitHub Actions Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/GitHub_Actions_Security_Cheat_Sheet.html)):

- `permissions: {}` op workflow-niveau en per job alleen wat nodig is.
- Alle actions vastgezet op een volledige commit-SHA, bijgewerkt door Dependabot met wachttijd.
- `actions/checkout` met `persist-credentials: false`.
- Geen `pull_request_target` of `workflow_run`; context-waarden alleen via omgevingsvariabelen in `run:`-stappen.
- Geen cache in de deploy-workflow.
- De Claude Code GitHub Action vastgezet op een SHA van minstens v1.0.94: in juni 2026 is daarin een lek gedicht waarmee een kwaadaardige issue een repo kon overnemen ([The Hacker News](https://thehackernews.com/2026/06/claude-code-github-action-flaw-let-one.html?m=1)). Hij draait alleen voor jou als eigenaar, met alleen lees- en commentaarrechten, en zonder toegang tot de deploy-secrets.

## Fasering

Vaste lasten komen vroeg, omdat je na de import handmatig werkt: zonder verwachte posten ontbreken huur en abonnementen in je budget.

1. **Fundament.** Repo met CI-pipeline, testopzet en CLAUDE.md met de AI-afspraken, designsysteem (typografie, kleuren, animatiebasis), Docker-opzet achter je bestaande nginx, passkey-login, datamodel, SNS-import met ontdubbelen, categorieregels, transactielijst met zoeken, snelinvoer, budget met tempo, startscherm, backups. Telemetrie: `errors`-tabel via `handleError` in een aparte telemetrie-database (90 dagen), leeftijd van de laatste backup, schijfruimte en container-restarts in de health check, en een externe beschikbaarheidscheck.
   - Klaar als: je historie staat erin, je kunt vanaf je telefoon een uitgave invoeren en je ziet wat er nog vrij is.
2. **Vaste lasten en Te krijgen.** Herkenning, verwachte posten, reserveringen voor vaste lasten die niet elke maand komen, tempo zonder geplande posten, signalen, voorschieten en ontvangen, saldocheck, pushmeldingen. Telemetrie: pushmeldingen bij een nieuw soort fout, een te oude backup en meer dan 80% schijfgebruik, de statuspagina achter de login, en INP en LCP via web-vitals. CI: Lighthouse CI in de PR-pipeline als performance-budget (eerste JS-bundel onder 100 kB gzip, INP), op de loginpagina en op het startscherm met een testsessie; tot dan bewaakt een e2e-test de bundelgrootte.
   - Klaar als: een maand lang alles bijhouden zonder dat er een vaste last ontbreekt.
   - Daarna, als laatste blok van deze fase: **gedeelde vaste lasten** (personen, aandelen, terugbetalingen koppelen en het overzicht). Het bouwt direct op vaste lasten en Te krijgen, en levert elke maand iets op; het hoort niet in het klaar-criterium hierboven, zodat dat niet wacht. Tot dan telt de wifi bruto mee. Klaar als: twee maanden lang per huisgenoot klopt wat er binnen is, met alleen bevestigen als handwerk.
3. **Bonnetjes.** Eerst het testplan op je eigen bonnen, dan de verwerking, de review-inbox, de koppellijst en de opdracht voor het deelmenu. Telemetrie: per Haiku-aanroep tokens, kosten, duur, uitkomst en of je velden achteraf corrigeerde.
   - Klaar als: de test het doel haalt, of we bewust kiezen voor altijd reviewen.
4. **Analyses.** Grafieken, trends, verwachting einde maand, jaaroverzicht, tags. Telemetrie: je eigen gebruik (dagen met invoer, tijd van openen tot opslaan).
5. **AI en extra's.** Maandsamenvatting, vraagveld, MCP-server, garantie-herinneringen.

Het testplan voor de bonnetjes kan parallel met fase 1: je verzamelt de bonnen toch al.

## Toetsing aan best practices

De grootste afwijking is de sessieduur: NIST adviseert voor dit soort data korter dan de 30 dagen uit het plan. De rest scherpt bestaande keuzes aan.

| Onderwerp | Bron | Advies | Wat er in de spec verandert |
| --- | --- | --- | --- |
| Sessieduur | [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b/aal/) | Bij AAL2 opnieuw inloggen binnen 24 uur en na hooguit 1 uur inactiviteit; bij AAL1 hooguit 30 dagen | Gekozen: 30 dagen (past bij AAL1); gevoelige acties vragen altijd opnieuw om je passkey |
| Sessiecookie | [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b/session/) | `__Host-`-prefix, `Secure`, `HttpOnly`, `SameSite`, minstens 64 bits willekeurig, niet in localStorage, CSRF-controle op POST | Overgenomen, met een sessie-ID van 128 bits die bij elke login wordt vernieuwd |
| Passkeys | [OWASP Passkey Security](https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html) | Onderhouden library, user verification vereisen, eenmalige challenges van minstens 16 bytes, exacte origin-lijst, geen attestation, geen terugval naar een zwakkere methode, opnieuw bevestigen voor passkey-beheer | SimpleWebAuthn met user verification `required`, RP ID `finance.mijndomein.nl`, pushmelding bij een nieuwe passkey, herstelcode eenmalig en gehasht |
| npm-supply-chain | [pnpm](https://pnpm.io/supply-chain-security), [OWASP A03](https://top10.owasp.org/2025/A03_2025-Software_Supply_Chain_Failures/) | Wachttijd op nieuwe versies, install-scripts alleen expliciet toestaan, geen exotische sub-dependencies, waarschuwen bij lager vertrouwen, lockfile | pnpm met `minimumReleaseAge: 10080` (7 dagen), `allowBuilds` alleen voor native packages zoals better-sqlite3, `blockExoticSubdeps: true`, `trustPolicy: no-downgrade` |
| Testverdeling | [Kent C. Dodds](https://kentcdodds.com/blog/unit-vs-integration-vs-e2e-tests), [Martin Fowler](https://martinfowler.com/articles/practical-test-pyramid.html) | Dodds: het meeste rendement uit integratietests, met statische analyse als basis. Fowler: veel snelle unit-tests, weinig UI-tests | Statische analyse altijd (TypeScript strict, ESLint, svelte-check); unit \~50% omdat parsers, koppelscore en berekeningen pure logica zijn; integratie \~40%; e2e \~10% |
| SQLite en backups | [Litestream](https://litestream.io/tips/) | WAL-mode vereist, `busy_timeout` van 5000 ms, nooit de database zonder het WAL-bestand verwijderen; replicatie is asynchroon | Pragma's vastgelegd bij het openen; hersteltest per kwartaal met `PRAGMA integrity_check` |
| Responsiviteit | [web.dev](https://web.dev/articles/inp) | INP van 200 ms of minder (p75) is goed | Ons doel van 100 ms blijft; gemeten als INP in Lighthouse CI |
| Content Security Policy | [SvelteKit](https://svelte.dev/docs/kit/configuration) | Ingebouwde `csp`-optie met nonces of hashes | GSAP en fonts uit de eigen bundle; geen `unsafe-inline` voor scripts |
| Uploads | [OWASP File Upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) | Type-allowlist, bestandshandtekening controleren, eigen bestandsnaam, groottelimiet, buiten de webroot, afbeeldingen opnieuw encoderen | Server controleert de handtekening, encodeert opnieuw met sharp en slaat op onder een UUID |

## Open punten

Voor fase 1 zijn alleen de repo en de SNS-export nodig; die lever je aan in Claude Code.

- [x] Stack: SvelteKit + SQLite, met GSAP voor animaties.
- [ ] GitHub-repo koppelen in Claude Code.
- [ ] SNS-export (CAMT.053) aanleveren in Claude Code. Een geanonimiseerde kopie wordt de test-fixture; de echte blijft buiten git.
- [ ] Revolut-historie: wel of niet een export importeren. Zonder ontbreken je Revolut-uitgaven van voor de start.
- [ ] Bonnetjes verzamelen voor het testplan (25 tot 30).
- [x] Display-font en accentkleur: Fraunces en Inter met smaragd.

**Nog te beslissen**

- Niets meer open: font en accent (voorstel A), sessies van 30 dagen per apparaat met opnieuw bevestigen bij gevoelige acties, en een privé-repo zijn besloten.

**Risico's**

- **Afwijken van de bank.** Handmatig invoeren betekent dat je cijfers kunnen afdrijven. De saldocheck vangt dat op, maar alleen als je hem doet.
- **Nauwkeurigheid van Haiku.** Onbekend tot de test; bij tegenvallende resultaten gaat elke bon langs de review-inbox.
- **iOS.** De app staat op je beginscherm, dus pushmeldingen werken. Wel kan iOS opgeslagen data van een PWA wissen. De offline wachtrij synct daarom zo snel mogelijk.
- **Zichtbaar subdomein.** Elk HTTPS-certificaat komt in openbare logs, dus finance.mijndomein.nl is vindbaar. Met passkeys is dat geen probleem; een wildcard-certificaat maakt het minder opvallend.
- **MCP vanuit claude.ai.** Daar is waarschijnlijk OAuth voor nodig; de actuele eisen zoek ik uit in fase 5.

## Bronnen

- [Uitleg transactieoverzicht in Mijn SNS](https://www.snsbank.nl/particulier/support/download-tonen-op-pagina/uitleg-van-je-transactieoverzicht-in-mijn-sns.html)
- [OWASP Top 10:2025](https://owasp.org/Top10/2025/0x00_2025-Introduction/)
- [OWASP GenAI LLM Top 10 2026](https://genai.owasp.org/resource/owasp-genai-llm-top-10-2026/) en de [rangorde-analyse van de Cloud Security Alliance](https://labs.cloudsecurityalliance.org/research/csa-research-note-owasp-llm-top10-2026-incident-weighted-202/)
- [OWASP Secure Coding with AI Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secure_Coding_with_AI_Cheat_Sheet.html)
- [OWASP Passkey Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html)
- [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
- [OWASP GitHub Actions Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/GitHub_Actions_Security_Cheat_Sheet.html)
- [NIST SP 800-63B-4: Authentication Assurance Levels](https://pages.nist.gov/800-63-4/sp800-63b/aal/) en [Session Management](https://pages.nist.gov/800-63-4/sp800-63b/session/)
- [GitHub's plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans), [Managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments), [GitHub Advanced Security](https://docs.github.com/en/get-started/learning-about-github/about-github-advanced-security) en [Permissions for GitHub Packages](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages)
- [Tailscale GitHub Action](https://tailscale.com/docs/integrations/github/github-action)
- [Claude Help Center: Agent SDK met je Claude-abonnement](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) en [Claude Code GitHub Actions](https://code.claude.com/docs/en/github-actions?m=1)
- [Claude vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)
- [SvelteKit adapter-node](https://svelte.dev/docs/kit/adapter-node) en [SvelteKit configuration (csp)](https://svelte.dev/docs/kit/configuration)
- [pnpm: Mitigating supply chain attacks](https://pnpm.io/supply-chain-security)
- [Kent C. Dodds: Static vs Unit vs Integration vs E2E](https://kentcdodds.com/blog/unit-vs-integration-vs-e2e-tests) en [Martin Fowler: The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html)
- [Litestream: Tips & Caveats](https://litestream.io/tips/)
- [web.dev: Interaction to Next Paint](https://web.dev/articles/inp)
- [The Hacker News: lek in de Claude Code GitHub Action (juni 2026)](https://thehackernews.com/2026/06/claude-code-github-action-flaw-let-one.html?m=1)
