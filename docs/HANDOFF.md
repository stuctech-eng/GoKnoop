# GoKnoop — Handoff-briefing voor een nieuwe sessie

**Laatst bijgewerkt:** 9 september 2026
**Doel van dit document:** een nieuwe Claude-sessie (of ontwikkelaar) in enkele minuten volledig op de hoogte brengen, zonder de oorspronkelijke, zeer lange ontwikkelsessie te hoeven doorlezen.

---

## 1. WAAR WE STAAN

```
Phase 1 — Data Foundation           ✅ COMPLETE
Phase 2 — Graph + Route Engine      ✅ COMPLETE (benchmark-onderbouwd)
Phase 3 — Core GoKnoop UX (MVP)     ✅ VALIDATED op echte productiedata
Phase 4 — Navigation                ⬜ nog niet gestart
```

**Live app:** https://go-knoop.vercel.app
**Repo:** `stuctech-eng/GoKnoop` (publiek op GitHub)
**Werkwijze:** de gebruiker (Te) werkt uitsluitend vanaf een iPhone via Working Copy (git-app) — er is geen lokale ontwikkelomgeving. Elke codewijziging wordt als download/zip aangeleverd, die Te vervolgens zelf uitpakt, commit en pusht in Working Copy. Test-URL's worden door Te geopend in Safari en het resultaat teruggeplakt.

**Volledige technische details staan in:**
- `docs/phase1a-wfs-audit.md` — WFS-discovery (welke lagen, velden, CRS)
- `docs/phase1b-design.md` — datamodel, importer, composite-node-clustering, graph-validatie, Phase 1 COMPLETE-status
- `docs/phase2-route-engine-design.md` — Route Engine-contract, benchmarkresultaten, Phase 3-voorbereiding, Amsterdam-bugfix, Phase 3 MVP-validatie

Dit handoff-document herhaalt die inhoud niet, maar geeft de **praktische, operationele context** die nergens anders staat.

---

## 1a. NWB-ARCHITECTUURBESLUIT (9 september 2026) — LEES DIT EERST

**Dit is het meest recente, belangrijkste besluit in het project. Elke nieuwe sessie moet dit gelezen hebben vóór verder werk aan netwerkdekking/routing.**

### Besluit

De eerdere strategie om het GoKnoop-netwerk voornamelijk te repareren met individuele Bridge Layer-verbindingen wordt niet langer als primaire architectuur beschouwd.

De nieuwe richting is:

> **GoKnoop-knooppunten vormen de voorkeurslaag binnen een breder, compleet fietsnetwerk.**

De beoogde gecombineerde netwerklaag bestaat uit: **GoKnoop knooppunten + NWB fietsrelevante infrastructuur**.

GoKnoop behoudt daarmee zijn belangrijkste eigenschap — routeren via fietsknooppunten — maar is niet langer afhankelijk van de volledigheid van uitsluitend het knooppuntennetwerk.

### Onderzoek dat dit besluit ondersteunt

Een grootschalige NWB-verzameling over het onderzochte gebied (Amsterdam–Hilversum, ruime buffer) leverde:

- 190.296 NWB-knopen;
- 189.702 knopen in één component bij 20m tolerantie — **99,7%** in één samenhangend geheel;
- bij 5m tolerantie al 88,6% in één component;
- 303–334 van 340 onderzochte GoKnoop-knopen binnen 10–50m van NWB-infrastructuur.

Dit is sterk bewijs dat NWB in het onderzochte gebied niet slechts uit losse lokale eilandjes bestaat, maar een vrijwel continu netwerk vormt dat ruimtelijk dicht bij het bestaande GoKnoop-netwerk ligt. Eerdere gerichte tests bevestigden bovendien dat echte GoKnoop ↔ NWB-connectors kunnen worden opgebouwd (connectorlogica getest en functioneel).

Zelfde resultaat, herbevestigd via Lochem (99,6% in één component, 9.203 setB-segmenten) en Volendam/Edam/Purmerend (85,8% in één component, 20.489 setB-segmenten) — dit is dus geen toevalstreffer specifiek voor het Hilversum-gebied.

### Belangrijke nuance: Amsterdam → Hilversum blijft een OPEN vraag

De specifieke vraag *"kan de gecombineerde GoKnoop + NWB-graaf een realistische fietsroute van Amsterdam naar Hilversum vinden?"* is **nog niet definitief bewezen én ook niet weerlegd**.

Een eerdere routetest gebruikte een relatief smalle corridor rond de rechte lijn Amsterdam → Hilversum. Daarbij werden 31–52 GoKnoop ↔ NWB-connectors gevonden (afhankelijk van tolerantie), werkte de connectorlogica, maar gebruikte Dijkstra geen enkele connector — er werd geen betere route gevonden dan de bestaande, zeer slechte GoKnoop-route van circa 366 km.

**Deze negatieve routetest mag NIET worden geïnterpreteerd als "NWB kan Amsterdam → Hilversum niet verbinden."** De meest waarschijnlijke verklaring: de gebruikte NWB-corridor kwam onvoldoende overeen met de geografische ligging van de bestaande foutieve GoKnoop-route. Die route wijkt al zeer vroeg (rond 1,5% van de totale route-afstand) sterk af van de geografisch logische richting, en komt uiteindelijk tot circa 99 km van de rechte lijn. Daardoor kon Dijkstra in de smalle NWB-corridor geen NWB-overstap vinden vanaf het deel van de GoKnoop-graaf dat hij daadwerkelijk gebruikte — een corridor-dekkingsprobleem, geen eigenschap van NWB zelf.

**Correcte formulering voor toekomstige sessies:**
> "Een eerdere smalle-corridor-test vond geen route, maar die test was geografisch onvoldoende om de volledige NWB-verbinding te beoordelen. De vraag is daarom nog open."

Niet: ~~"NWB kan Amsterdam → Hilversum niet routeren."~~ — dat is niet wat er is aangetoond.

### Wat wél bewezen is

1. NWB bevat in het onderzochte gebied zeer veel fietsrelevante infrastructuur.
2. NWB vormt daar bij geschikte connectietolerantie een vrijwel continu netwerk.
3. NWB ligt geografisch zeer dicht bij het overgrote deel van de onderzochte GoKnoop-knooppunten.
4. GoKnoop ↔ NWB-connectors kunnen daadwerkelijk worden gegenereerd.
5. De connectorlogica zelf is getest en functioneert.
6. Het huidige GoKnoop-netwerk heeft aantoonbare ernstige netwerkproblemen die een breder fietsnetwerk kan helpen oplossen.
7. Een architectuur waarin knooppunten de voorkeurslaag zijn binnen een breder fietsnetwerk is daarom technisch veelbelovender dan uitsluitend het bestaande knooppuntennetwerk proberen te repareren.

### Wat nog niet bewezen is

Of een volledig verzamelde NWB-graaf, gecombineerd met GoKnoop, daadwerkelijk een realistische Amsterdam → Hilversum-route kan produceren. Dit is een open validatievraag, geen bekende beperking van NWB. Een toekomstige test moet hiervoor een voldoende groot en volledig NWB-gebied gebruiken (bijv. rond de daadwerkelijke, huidige omweg-route heen, niet alleen de rechte lijn) en mag niet uitsluitend worden gebaseerd op een smalle rechte-lijncorridor.

### Architectuurrichting

De toekomstige router moet conceptueel kunnen werken als:

```
Start
  ↓
breed fietsnetwerk
  ↓
GoKnoop-knooppunt beschikbaar?
  ├── ja → knooppuntroute krijgt voorkeur
  │
  └── nee → normaal fietsnetwerk
  ↓
volgend knooppunt
  ↓
opnieuw voorkeur voor GoKnoop
  ↓
Bestemming
```

GoKnoop wordt daarmee geen geïsoleerde knooppuntenrouter, maar een knooppunten-georiënteerde router binnen een breder fietsnetwerk. Dit sluit conceptueel aan bij het eerder onderzochte model van de Fietsersbond Routeplanner: knooppunten worden zoveel mogelijk gevolgd, terwijl buiten het knooppuntennetwerk het normale fietsnetwerk kan worden gebruikt.

### Status (samenvatting)

| Onderdeel | Status |
|---|---|
| Architectuurrichting | GoKnoop + breder fietsnetwerk |
| NWB als aanvullende laag | Sterk ondersteund |
| GoKnoop ↔ NWB connectors | Bewezen technisch mogelijk |
| NWB-connectiviteit in onderzochte gebieden | Zeer sterk ondersteund (3 gebieden getest) |
| Amsterdam → Hilversum via volledige gecombineerde graph | **OPEN** — niet bewezen, niet weerlegd |
| Bridge Layer als primaire oplossing | Niet langer de voorkeursrichting |
| Productie-integratie NWB | **Nog niet uitvoeren** voordat de gecombineerde netwerkarchitectuur en routeringsregels zijn ontworpen |

De onderzoeksinfrastructuur die dit heeft aangetoond (NWB-client, quad-tree-verzamelaar, component-analyse, gecombineerde-graaf-Dijkstra-test) staat in `lib/nwb-analysis/` en de bijbehorende `/api/debug/nwb-*`-eindpunten — puur onderzoek, geen productiecode, nooit geactiveerd in de daadwerkelijke route-engine.

**VERVOLG, 9 september 2026 (later op de dag):** het volledige routingverbetering-traject (Fase 1 t/m N, architectuur, F-factor-kalibratie, route-validatie, Valhalla-onderzoek, en straks productie-integratie) wordt nu bijgehouden in een apart, doorlopend document: **[`docs/ROUTING-IMPROVEMENT-MASTER.md`](ROUTING-IMPROVEMENT-MASTER.md)**. Dat document bevat de Phase Log, Decision Log, Regression Catalog, Anomaly Register en Dataset Register voor dit hele traject. Begin daar, niet hier, voor de actuele status van dit traject.

---

## 2. KERNGEGEVENS

```
Actieve dataset-versie:  uINZ3y2QsgBdEyky3duq   (config/activeDataset in Firestore)
Firebase-project:        go-knoop
Vercel-regio:            fra1 (Frankfurt) -- bewust gekozen, dicht bij Firestore
Vercel-plan:             Hobby (zie sectie 3, punt 1 -- dit is een harde beperking)
```

**Datavolume (bijgewerkt 9 september 2026, live geverifieerd — Fase 1-rapport NWB-onderzoek):**
```
sourceNodes:        13.152
logicalNodes:        11.003  (1.191 samengevoegd, 9.698 los, 114 exception_review)
source edges:        28.061
matched edges:       15.495  (dit is de daadwerkelijke routing-graph)
Hoofdcomponent:      76,1% van alle logicalNodes (8.372 nodes, 1.111 connected components totaal)
Geïsoleerde nodes:   729
Dead-ends:           1.206
```

**Correctie t.o.v. eerdere versie van dit document:** de vorige waarden (28.067 source edges, 16.345 matched edges, 84,4%/669 componenten) zijn vervangen door bovenstaande, op 9-9-2026 live opgevraagde cijfers. Het verschil in matched edges (16.345→15.495) én in componentverdeling (84,4%/669→76,1%/1.111) is substantieel en de **oorzaak is nog niet vastgesteld** — mogelijk documentatie-veroudering, mogelijk een tussentijdse, niet-gedocumenteerde wijziging. Dit blokkeert het lopende NWB-onderzoek niet (de live cijfers gelden als baseline), maar verdient uitzoeken vóórdat een eventuele NWB-verbetering wordt toegeschreven aan NWB terwijl het gedeeltelijk een GoKnoop-datawijziging zou kunnen zijn.

---

## 3. BELANGRIJKE GELEERDE LESSEN (voorkom dat je dezelfde fouten herhaalt)

1. **Vercel Hobby-plan = harde 10-seconden-limiet per functie-aanroep, ongeacht `maxDuration` in de code.** Elke zware operatie (imports, clustering, matching, graph-precompute) moet daarom **hervatbaar/gepagineerd** zijn. Het bewezen patroon: een admin-pagina (`app/admin/import/page.tsx`) die de import-lus **in de browser** draait (niet server-side), met kleine paginagroottes en automatische retries. Zie die pagina als sjabloon voor elke toekomstige zware batch-operatie.

2. **Firestore-batchlimieten:** max 500 operaties per batch, én een praktische limiet van ~10MB request-payload. Bij items met veel data (zoals edges met volledige geometrie) moet de chunkgrootte veel kleiner zijn dan bij lichte items (nodes). Vuistregel die werkte: ~450 operaties/batch voor lichte data, ~200 items/chunk of zelfs 1 chunk-document per commit (parallel via `Promise.all`) voor zware data.

3. **Gebruik altijd deterministische Firestore-document-ID's** (`${datasetVersionId}_${sourceObjectId}`) voor alles wat geïmporteerd of herhaald kan worden. Auto-gegenereerde ID's leidden tot dubbele documenten bij retries na een time-out — dit gebeurde zowel bij nodes als edges en kostte een hele opschoon-cascade om te herstellen (dedup-nodes, dedup-edges, wipe-clustering, wipe-matching routes, nu nog in de codebase als eenmalige opschoontools).

4. **Firebase Spark-plan (gratis) kan het dagquotum aan schrijfacties bereiken** bij zware importwerk (`RESOURCE_EXHAUSTED: Quota exceeded`). Er is destijds gesuggereerd om te upgraden naar Blaze (pay-as-you-go) — **controleer of dit daadwerkelijk is gebeurd**, dit is niet met zekerheid bevestigd in de sessie. Zo niet, kan hetzelfde probleem terugkeren bij een volgende zware batch-operatie.

5. **`circuityFactor` (rondje-generator) is GEEN stabiele constante.** Empirisch gemeten tussen 1,6 en 1,85 afhankelijk van het gebied (Utrecht vs. Amsterdam). Huidige default: 1,6. Niet verder tunen zonder nieuwe metingen — dit is een MVP-heuristiek, geen exacte wetenschap.

6. **De Location Resolver sluit sinds 28-8-2026 geïsoleerde nodes (0 edges) uit.** Vóór die fix kon de dichtstbijzijnde-node-selectie een volledig onbruikbaar startpunt opleveren (concreet gevonden bij een Amsterdam-test — zie `docs/phase2-route-engine-design.md` sectie 9C). Als je ooit weer "0 routes gevonden" ziet zonder duidelijke reden, check eerst `edgeCount` van het gekozen startpunt.

7. **Alleen `matchConfidence === 'matched'` edges vormen de routing-graph** (15.495 van 28.061, live geverifieerd 9-9-2026 — zie sectie 2 voor de eerdere afwijkende waarde en de nog-openstaande verklaring daarvoor). De overige edges blijven gewoon in de database staan (nooit verwijderd) voor herleidbaarheid/toekomstige verbetering, maar worden simpelweg niet meegenomen in de Dijkstra-adjacency.

8. **Web_fetch-tool van Claude heeft een cache-bug** bij herhaalde, sterk gelijkende URL's naar hetzelfde domein (bijv. bij paginering met oplopende `startIndex`). Bij dat patroon: vraag de gebruiker om elke URL zelf te plakken in plaats van zelf te herhalen fetch'en — dat werkte in deze sessie altijd betrouwbaar, zelf herhalen gaf herhaaldelijk verouderde/gecachte resultaten.

9. **Alle nieuwe code krijgt een `tsc`-typecontrole EN een `vitest run`** vóór 'ie als "klaar" wordt gepresenteerd — dit ving in deze sessie minstens één echte bug op (een verkeerd importpad, `../types` i.p.v. `./types`) vóórdat die naar productie ging.

---

## 4. ADMIN/TEST-TOOLS (voor Te om zelf te gebruiken, of om als nieuwe sessie te hergebruiken)

Alle routes hieronder vereisen `?key=<DEBUG_SECRET>` (de waarde staat in Vercel's environment variables, niet in dit document — vraag Te ernaar of laat 'm de env var checken).

| Pagina/route | Doel |
|---|---|
| `/admin/import` | Bulk-import van nodes/edges, node-clustering, edge-matching — alles hervatbaar, draait client-side in de browser |
| `/admin/route-test` | Simpel testformulier voor `POST /api/route` (A→B) |
| `/admin/capabilities-test` | Testformulier voor Location Resolver, RoutePlanner-alternatieven, rondje-generator — met samenvatting (zonder geometrie) en kopieerknoppen |
| `/api/import/status?datasetVersionId=...` | Telt het werkelijke aantal sourceNodes/edges in Firestore |
| `/api/import/graph-connectivity?datasetVersionId=...` | Connected-components-analyse |
| `/api/import/dedup-nodes`, `/api/import/dedup-edges` | Eenmalige opschoontools (dryRun-parameter beschikbaar) — waarschijnlijk niet meer nodig tenzij er een nieuwe importfout optreedt |

---

## 5. OPENSTAANDE, NIET-BLOKKERENDE PUNTEN

Deze zijn bewust **niet** opgelost — ze blokkeren niets, maar zijn het waard om te weten:

- **7 excluded/unresolved edges** (28.067 bron vs. 28.060 in de graph) — vermoedelijke oorzaak: enkele bronrecords zonder geldige lijngeometrie, nooit definitief bevestigd.
- **114 `exception_review`-clusters** — gemengde Enkelvoudig/Samengesteld-knooppuntgroepen, veilig apart gehouden zonder automatische samenvoeging.
- **Rijrichting-semantiek** — bewust gepauzeerd onderzoek (Phase 1B sectie 4). Veilige default: `directionality: 'unknown'`, routing-policy behandelt dit als bidirectioneel. `isTraversable()` in `lib/route-engine/is-traversable.ts` is al voorbereid om dit ooit op te lossen zonder de rest van de Route Engine te hoeven wijzigen.
- **Firebase-plan (Spark vs. Blaze)** — zie les 4 hierboven, status onbevestigd.

---

## 6. LOGISCHE VOLGENDE STAP: PHASE 4 — NAVIGATION

Nog niet gestart. Uit het Master Plan: turn-by-turn-navigatie tijdens het fietsen (huidig knooppunt, volgend knooppunt, afstand, routeprogressie, afwijking van route, herberekening). Het Route-datamodel (`lib/route-engine/types.ts`) heeft hier al een `navigation: null`-placeholder-veld voor klaarstaan — nog geen functionaliteit gebouwd, exact zoals de rest van het project bewust gelaagd is opgebouwd (architectuur voorbereiden, functionaliteit pas bouwen als de fase daadwerkelijk begint).

**Nog steeds nadrukkelijk NIET bouwen** (Master Context sectie 23, nog steeds van kracht): AI-routeassistent, POI's, persoonlijke voorkeuren, weer, e-bike/batterij, samen fietsen, offline, wearables, veiligheidslaag.
