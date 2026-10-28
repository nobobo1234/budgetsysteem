# Vraag-eval

De eval uit de spec ("Vraagveld → Eval" en "Tests en CI"): de goudset van Nederlandse vragen gaat naar elke variant van het model, code rekent uit wat het model koos, en de uitkomst wordt vergeleken met wat er volgens de goudset uit moet komen (execution accuracy). Doel: minstens 95% juist op de vragen die in het vraagformaat passen, en geen enkel getal bij een vraag die er niet in past.

Het script draait niet in CI: het kost API-tegoed. Draai het na elke wijziging aan de prompt (`src/lib/server/question/translator.ts`) of de semantische laag (`src/lib/semantic/`, `src/lib/server/semantic.ts`), op alle varianten, zodat een sneller model weer kan als het doel ook daarmee gehaald wordt.

## Wat er gemeten wordt

- **Fixture.** `tests/fixtures/vraag/fixture.ts`: veertien maanden verzonnen geldzaken tot en met 21 oktober 2026, met alleen test-IBANs en verzonnen namen. Er gaan geen echte gegevens naar het model.
- **Goudset.** `tests/fixtures/vraag/goudset.ts`: 49 vragen met de bedoelde query en de uitkomst op de fixture, inclusief de valkuilen uit de spec ("dit jaar", terugbetalingen en negatieve bedragen, interne overboekingen, een gesplitste bon, een categorie die op twee manieren te lezen is, twee tegenpartijen met bijna dezelfde naam) en vragen die niet passen. De integratietest `tests/integration/semantic.test.ts` controleert dat elke query in de goudset deze uitkomst geeft, en dat de maten dezelfde getallen geven als Budget en Analyses.
- **Juist.** Een vraag die past is juist als het getal gelijk is aan de verwachte uitkomst (bij een lijst ook de eerste rijen), of aan die van een andere goede lezing (`ook`). Een dubbelzinnige vraag is juist als er een verduidelijking komt, van het model of van code. Een vraag die niet past is juist als er geen getal komt.
- **Varianten.** `haiku` (Claude Haiku 5.5 op de standaard-effort), `haiku-high` (`effort: high`) en `sonnet` (Claude Sonnet 5.5). Per variant: de uitkomst, de mediane duur en de kosten (ook per 100 vragen). Het script noemt de snelste variant die het doel haalt; die wordt `QUESTION_VARIANT` in `translator.ts`. Haalt geen variant het doel, dan eerst de prompt en de semantische laag aanscherpen, daarna Claude Opus 5.5 meten (spec: Vraagveld, Model).

## Draaien

De API-sleutel komt uit je eigen omgeving (`ANTHROPIC_API_KEY` of `ant auth login`); het script leest of toont hem nooit.

```bash
node scripts/vraag-eval.ts --uit ~/Documents/vraag-eval
```

Opties:

- `--varianten haiku,haiku-high,sonnet`: welke varianten (standaard alle drie).
- `--gelijktijdig 3`: hoeveel vragen tegelijk (1 tot 8).
- `--alleen kapper,eten`: alleen deze vragen uit de goudset.
- `--uit <map>`: bewaar de details per vraag (met het vraagformaat dat het model koos) als JSON in een map buiten de repo.
- `--droog`: laat zien wat er naar het model zou gaan, zonder aanroep.

Haiku is per token twintig keer zo goedkoop als Sonnet (prijzen in `src/lib/server/ai/client.ts`); het script meldt na de run de echte kosten per variant.

## Een vraag toevoegen

Voeg de vraag toe aan `goudset.ts` met de query die hij bedoelt en de uitkomst. De uitkomst reken je uit op de fixture en controleer je met de hand; de integratietest bewaakt daarna dat hij niet stil verandert. Een uitkomst aanpassen mag alleen als de fixture verandert, nooit om een test groen te maken. Vragen die het vraagveld in de praktijk weigerde (`questions` met soort `kan_niet`) zijn de beste bron voor nieuwe vragen en voor maten of filters die nog ontbreken.
