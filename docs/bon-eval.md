# Haiku-eval op je eigen bonnen

Het testplan uit de spec ("Testplan voordat het live gaat"): 25 tot 30 eigen bonnen, met de hand gelabeld, door Claude Haiku 5.5 laten lezen in drie varianten, en meten hoe vaak elk veld goed is en vooral hoe vaak "zeker" toch fout was. Doel: bij "zeker" minstens 98% goed op het totaal.

Sinds fase 4 kiest Haiku in dezelfde aanroep ook een productgroep per artikelregel (spec: Analyses → Boodschappen per productgroep). De eval meet daarom ook hoe vaak alle regels gevuld zijn en, als je de artikelen labelt, of de productgroep klopt. Na elke wijziging aan de prompt of het schema (`schema.ts`) draai je de eval opnieuw.

Het script draait niet in CI: het kost API-tegoed en heeft echte bonnen nodig. Echte bonnen komen nooit in de repo; het script weigert een map binnen de projectmap.

## Map met bonnen

Een map buiten de repo, bijvoorbeeld `~/Documents/bon-eval/`:

```text
bon-eval/
├── labels.json
├── ah-bonus.jpg
├── cafe-fooi.jpg
├── jumbo-lang-1.jpg
├── jumbo-lang-2.jpg
├── revolut-usd.png
├── sns-lijst.png
└── revolut-lijst.png
```

Foto's als JPEG, PNG of WebP. iPhone-foto's in HEIC eerst als JPEG exporteren (in Foto's: Exporteer, of AirDrop naar de Mac kiest vaak al JPEG). Lever ze aan zoals de app ze straks krijgt: de originele foto, niet alvast verkleind. Lange bonnen bijsnijden tot de bon zelf, want dat doet de app straks ook (randdetectie in de browser); alleen dan valt een lange bon onder "in stukken".

## labels.json

```json
{
	"bonnen": [
		{
			"id": "ah-bonus",
			"bestanden": ["ah-bonus.jpg"],
			"winkel": ["Albert Heijn", "AH"],
			"datum": "2026-10-12",
			"totaal": "23,45",
			"betaalwijze": "pin",
			"soort": "supermarkt",
			"regels": [
				{ "omschrijving": "Halfvolle melk", "bedrag": "1,19", "groep": "zuivel_eieren" },
				{ "omschrijving": "Bananen", "bedrag": "1,99", "groep": "groente_fruit" },
				{ "omschrijving": "Spaghetti", "bedrag": "0,99", "groep": "voorraad" }
			]
		},
		{
			"bestanden": ["jumbo-lang-1.jpg", "jumbo-lang-2.jpg"],
			"winkel": "Jumbo",
			"datum": "2026-10-14",
			"totaal": "87,10",
			"soort": "kreukel"
		},
		{
			"id": "revolut-usd",
			"bestanden": ["revolut-usd.png"],
			"winkel": "Blue Bottle Coffee",
			"datum": "2026-09-30",
			"totaal": "6,50",
			"valuta": "USD",
			"ontvangen": "2026-10-02",
			"soort": "screenshot"
		}
	]
}
```

| Veld          | Verplicht | Betekenis                                                                                                                                                                                                    |
| ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bestanden`   | ja        | Eén of meer foto's van dezelfde bon, van boven naar beneden. Alleen bestandsnamen in deze map.                                                                                                               |
| `winkel`      | ja        | De juiste winkelnaam, of een lijst namen die allemaal goed zijn. Vergeleken zonder hoofdletters, accenten, leestekens en B.V.; een filiaalnummer erachter mag ("Albert Heijn 1234" telt als "Albert Heijn"). |
| `datum`       | ja        | Aankoopdatum als `JJJJ-MM-DD`.                                                                                                                                                                               |
| `totaal`      | ja        | Het betaalde bedrag zoals je het typt: `23,45` of `1.234,50`. Inclusief fooi als die op de bon is opgeteld.                                                                                                  |
| `valuta`      | nee       | ISO-code, standaard `EUR`.                                                                                                                                                                                   |
| `betaalwijze` | nee       | `pin`, `creditcard`, `contant`, `cadeaukaart` of `overig`. Zonder label telt dit veld niet mee.                                                                                                              |
| `ontvangen`   | nee       | Wanneer je de bon zou uploaden; daartegen gelden de controles "niet in de toekomst" en "niet ouder dan 60 dagen". Standaard de dag na `datum`.                                                               |
| `id`          | nee       | Korte naam in het rapport; standaard de eerste bestandsnaam zonder extensie.                                                                                                                                 |
| `soort`       | nee       | Vrije groep, zoals `supermarkt`, `horeca`, `kreukel`, `screenshot`.                                                                                                                                          |
| `notitie`     | nee       | Voor jezelf.                                                                                                                                                                                                 |
| `regels`      | nee       | De artikelen met hun productgroep, van boven naar beneden; zie "Regels en productgroep" hieronder. Zonder dit veld meet het script alleen of alle regels gevuld zijn.                                        |

Neem een mix zoals de spec vraagt: supermarkt met bonuskorting, horeca met fooi, een kreukelige bon, een lange bon en een Revolut-screenshot in dollar.

## Regels en productgroep

Per bon meet het script altijd of **alle regels gevuld** zijn: alle regels gelezen, en samen (met korting, bonus en statiegeld) gelijk aan het gelabelde totaal, binnen €0,05. Alleen zo'n bon telt in de app mee in het overzicht per productgroep. Daarvoor hoef je niets extra te labelen.

Of de **productgroep klopt**, meet het alleen bij bonnen met `regels`: per artikel het bedrag en de groep. Kortingen, bonus, statiegeld en fooi label je niet; die krijgen geen groep. Het script koppelt elk gelabeld artikel aan een gelezen artikel met hetzelfde bedrag, op volgorde van de bon. Een artikel zonder paar telt als niet gevonden en dus niet goed. `omschrijving` is alleen voor jezelf.

| Veld           | Verplicht | Betekenis                                                                        |
| -------------- | --------- | -------------------------------------------------------------------------------- |
| `bedrag`       | ja        | Bedrag van het artikel zoals op de bon en zoals je het typt: `2,49`.             |
| `groep`        | ja        | Een van de twaalf groepen hieronder.                                             |
| `omschrijving` | nee       | Wat er op de bon staat, om je labels terug te vinden; telt niet mee in de score. |

| `groep`         | Voorbeelden                                            |
| --------------- | ------------------------------------------------------ |
| `groente_fruit` | groente, fruit, aardappelen, verse kruiden             |
| `zuivel_eieren` | melk, yoghurt, kaas, boter, eieren                     |
| `vlees_vis`     | vlees, vis, vleeswaren, vleesvervangers                |
| `brood_ontbijt` | brood, beschuit, ontbijtgranen, jam, pindakaas         |
| `voorraad`      | pasta, rijst, conserven, sauzen, kruiden, koffie, thee |
| `kant_en_klaar` | maaltijden, salades, soep, pizza, diepvriesmaaltijden  |
| `snacks_snoep`  | chips, koek, snoep, chocolade, noten                   |
| `frisdrank_sap` | frisdrank, sap, water, energiedrank                    |
| `alcohol`       | bier, wijn, sterke drank                               |
| `huishouden`    | schoonmaak, wc-papier, afvalzakken, batterijen         |
| `verzorging`    | shampoo, tandpasta, deodorant, medicijnen              |
| `overig`        | al het andere                                          |

Dezelfde voorbeelden staan in de prompt (`schema.ts`); verander je de ene, verander dan de andere mee.

Alle artikelen met de hand overtikken is veel werk. Laat het script daarom een begin maken: met `--concept-regels` schrijft het na een run `resultaten/concept-regels-<tijd>.json` met per bon de artikelen zoals Haiku ze las (omschrijving, bedrag en groep, van de laatste variant). Kijk elke regel na tegen de bon, verbeter bedrag en groep, vul ontbrekende artikelen aan, haal kortingen eruit, en zet de lijst als `regels` bij de bon in `labels.json`. Kijk echt na: neem je de groepen van Haiku ongezien over, dan meet de eval alleen zichzelf.

Label niet per se alle bonnen: vijf tot tien supermarktbonnen met samen een paar honderd artikelen zeggen genoeg over de groepen.

## Screenshots met meerdere transacties

Een screenshot van je bankapp met een lijst transacties (spec: Verwerking stap 6) label je per transactie, onder `lijsten` in hetzelfde `labels.json`. `bonnen` en `lijsten` mogen allebei; één van de twee mag ontbreken.

```json
{
	"bonnen": [],
	"lijsten": [
		{
			"id": "sns-lijst",
			"bestanden": ["sns-lijst.png"],
			"ontvangen": "2026-10-26",
			"transacties": [
				{ "datum": "2026-10-25", "tegenpartij": ["Albert Heijn", "AH"], "bedrag": "-23,45" },
				{ "datum": "2026-10-25", "tegenpartij": "NS", "bedrag": "-4,80" },
				{ "datum": "2026-10-24", "tegenpartij": "Werkgever B.V.", "bedrag": "2.150,00" }
			]
		},
		{
			"bestanden": ["revolut-lijst.png"],
			"transacties": [
				{
					"datum": "2026-10-20",
					"tegenpartij": "Blue Bottle Coffee",
					"bedrag": "-6,50",
					"valuta": "USD"
				},
				{ "datum": "2026-10-19", "tegenpartij": "Uber", "bedrag": "-18,20", "valuta": "USD" }
			]
		}
	]
}
```

| Veld                     | Verplicht | Betekenis                                                                                                                                            |
| ------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bestanden`              | ja        | Het screenshot (of een paar, van boven naar beneden).                                                                                                |
| `transacties`            | ja        | Elke transactie die (grotendeels) in beeld staat, van boven naar beneden. Geen saldo, kopjes of totalen.                                             |
| `datum`                  | ja        | Per transactie, als `JJJJ-MM-DD`. Staat er "Vandaag" of een datum zonder jaar, schrijf dan de echte datum.                                           |
| `tegenpartij`            | ja        | De naam zoals in de app, of een lijst namen die allemaal goed zijn; vergeleken zoals `winkel` hierboven.                                             |
| `bedrag`                 | ja        | Met teken, zoals je het typt: `-23,45` voor geld dat eraf ging, `2.150,00` voor geld dat binnenkwam.                                                 |
| `valuta`                 | nee       | ISO-code van dat bedrag, standaard `EUR`. Toont Revolut een bedrag in dollar met het eurobedrag eronder, label dan het dollarbedrag met `USD`.       |
| `ontvangen`              | nee       | Wanneer je het screenshot zou uploaden; Haiku krijgt deze datum om "Vandaag" en "Gisteren" om te rekenen. Standaard de dag na de laatste transactie. |
| `id`, `soort`, `notitie` | nee       | Als bij een bon.                                                                                                                                     |

Neem een paar soorten: een SNS-lijst met uitgaven en een binnenkomend bedrag, een Revolut-lijst in vreemde valuta, en een lijst waarvan de onderste transactie half buiten beeld valt.

## Draaien

Met je eigen API-sleutel in de omgeving (`ANTHROPIC_API_KEY`, of eenmalig `ant auth login`). Het script leest of toont de sleutel nooit.

Eerst droog, zonder API-aanroepen: laat per variant de formaten en beeldtokens zien en bewaart de voorbereide beelden in `beelden/` in je map, zodat je kunt nakijken of de tekst leesbaar blijft.

```bash
node scripts/bon-eval.ts ~/Documents/bon-eval --droog --bewaar-beelden
```

Dan echt, alle drie de varianten:

```bash
node scripts/bon-eval.ts ~/Documents/bon-eval
```

Na een wijziging aan de prompt, zoals de productgroepen van fase 4, is alleen de variant die de app gebruikt (`stukken`) nodig. Eerst een run met een begin voor de regels, dan de regels nakijken en in `labels.json` zetten, dan nog een run om de groepen te meten:

```bash
node scripts/bon-eval.ts ~/Documents/bon-eval --varianten stukken --concept-regels
```

```bash
node scripts/bon-eval.ts ~/Documents/bon-eval --varianten stukken
```

Kijk dan of winkel, datum, totaal en valuta niet slechter zijn geworden dan bij de vorige run (het doel van 98% bij zeker op het totaal blijft), hoe vaak alle regels gevuld zijn, en of de productgroep bij gevulde regels het doel van 90% haalt.

Opties:

| Optie              | Standaard           |                                                                                  |
| ------------------ | ------------------- | -------------------------------------------------------------------------------- |
| `--varianten`      | `1600,2576,stukken` | Welke varianten                                                                  |
| `--effort`         | `medium`            | Denkniveau van Haiku 5.5 (`low` tot `max`); `medium` is ook zijn eigen standaard |
| `--model`          | `claude-haiku-5-5`  | Ander model ter vergelijking                                                     |
| `--gelijktijdig`   | `3`                 | Aanroepen tegelijk (1–8)                                                         |
| `--alleen`         |                     | Alleen deze id's, kommagescheiden                                                |
| `--bewaar-beelden` | uit                 | Voorbereide beelden in `beelden/<variant>/`                                      |
| `--droog`          | uit                 | Alleen beelden voorbereiden, geen API-aanroepen                                  |
| `--concept-regels` | uit                 | Na de run `resultaten/concept-regels-<tijd>.json` als begin voor `regels`        |

Kosten: een bon is zo'n 2.000 tot 5.000 beeldtokens per deel plus de uitvoer; met de prijs van Haiku 5.5 ($0,10 per miljoen tokens in, $0,50 uit) is een volledige run van 30 bonnen in drie varianten ruim onder de $0,25. Het rapport noemt de werkelijke kosten.

## Wat je terugkrijgt

In de terminal per variant alleen aantallen, geen bedragen of winkelnamen:

- uitkomst per bon: zeker, controleren, onzeker, en hoeveel bonnen "zeker" waren terwijl winkel, datum, totaal of valuta fout was;
- per veld: hoe vaak goed, hoe vaak gevuld, hoe vaak zeker, en het percentage goed bij zeker;
- of het doel gehaald is (totaal bij zeker ≥ 98%);
- tokens, kosten en mediane duur;
- de id's van bonnen waar "zeker" toch fout was, om na te kijken;
- regels: bij hoeveel bonnen alle regels gevuld zijn (samen het totaal);
- productgroep (alleen met `regels` in je labels): hoeveel gelabelde artikelen gevonden zijn, hoeveel de goede groep hadden, en welk deel van het geld in de goede groep viel; met de id's van bonnen met een fout, als `ah-bonus (2)` voor twee artikelen;
- productgroep bij gevulde regels: hetzelfde percentage, alleen over bonnen waarvan alle regels gevuld zijn, en of het doel uit de spec gehaald is (minstens 90% juiste groep, fase 4 "Klaar als");
- bij lijsten: hoeveel screenshots als bon gelezen werden (en bonnen als lijst), hoeveel gelabelde transacties gevonden en helemaal goed waren, per veld (`datum`, `tegenpartij`, `bedrag`, `valuta`) goed, gevuld en goed bij zeker, hoeveel transacties "zeker" waren met een fout veld, en hoeveel het model er las die niet in het label staan (extra, en daarvan zeker). Die laatste twee zijn het belangrijkst: zo'n transactie staat aangevinkt klaar om te boeken. De id's staan erbij als `sns-lijst #2 (bedrag)`, waarbij #2 de tweede transactie van boven is.

De details per bon (wat Haiku las, de controles, de score) staan in `resultaten/eval-<tijd>.json` in je map, buiten de repo.

Een mislukte lezing (weigering, afgekapt, ongeldige uitvoer of API-fout) telt als onzeker en niet gevuld: in de app zou die bon in de review-inbox komen.

Een gelabelde transactie hoort bij hooguit één gelezen transactie: het script koppelt eerst de paren die het meest overeenkomen (bedrag weegt het zwaarst), en alleen als het bedrag klopt of datum en naam allebei kloppen. Een transactie zonder paar telt als niet gevonden; een gelezen transactie zonder paar als extra.

## Hoe de uitkomst ontstaat

Dezelfde code als de app straks gebruikt (`src/lib/server/receipts/`):

1. **Beeld** (`images.ts`): rechtzetten volgens EXIF, verkleinen, één keer JPEG met kwaliteit 90, metadata eraf. `1600`: lange kant 1600 px. `2576`: zo groot als het model aankan (2576 px én 4784 beeldtokens; een 4:3-foto wordt daardoor zo'n 1650 × 2200). `stukken`: als `2576`, maar een bon die meer dan 3,5 keer zo lang als breed is wordt op volle breedte (tot 1288 px) in hooguit vijf gelijke stukken met minstens 10% overlap gesneden.
2. **Lezen** (`reader.ts`): één verzoek met de delen als "Deel 1", "Deel 2", een vast JSON-schema via structured outputs en geen tools. Elke regel heeft een productgroep uit een vaste lijst (enum); een onbekende waarde wordt `overig`, en alles wat geen artikel is krijgt geen groep.
3. **Controleren** (`checks.ts`): totaal aanwezig en positief, datum niet in de toekomst en niet ouder dan 60 dagen, regels (met korting, bonus en statiegeld) opgeteld gelijk aan het totaal binnen €0,05. Een veld is zeker als het model zeker is én de controles slagen; controleren als het model twijfelt maar de controles slagen; anders onzeker. Bij een lijst per transactie: datum als bij een bon, naam aanwezig, bedrag aanwezig en niet nul (met teken), valuta een ISO-code.

Haal je het doel niet, dan gaat volgens de spec elke bon langs de review-inbox, of we scherpen de prompt (`schema.ts`) en de controles aan en draaien de eval opnieuw.
