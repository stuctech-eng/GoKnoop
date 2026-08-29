# GoKnoop — Handoff-briefing voor een nieuwe sessie

**Laatst bijgewerkt:** 28 augustus 2026
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

## 2. KERNGEGEVENS

```
Actieve dataset-versie:  uINZ3y2QsgBdEyky3duq   (config/activeDataset in Firestore)
Firebase-project:        go-knoop
Vercel-regio:            fra1 (Frankfurt) -- bewust gekozen, dicht bij Firestore
Vercel-plan:             Hobby (zie sectie 3, punt 1 -- dit is een harde beperking)
```

**Datavolume (huidige actieve dataset):**
```
sourceNodes:        13.152
logicalNodes:        11.003  (1.191 samengevoegd, 9.698 los, 114 exception_review)
source edges:        28.067
valid graph edges:   28.060  (7 excluded/unresolved -- traceerbaar, nooit stilzwijgend verwijderd)
matched edges:       16.345  (dit is de daadwerkelijke routing-graph, 58,3% van alle edges)
Hoofdcomponent:      84,4% van alle logicalNodes (669 connected components totaal)
```

---

## 3. BELANGRIJKE GELEERDE LESSEN (voorkom dat je dezelfde fouten herhaalt)

1. **Vercel Hobby-plan = harde 10-seconden-limiet per functie-aanroep, ongeacht `maxDuration` in de code.** Elke zware operatie (imports, clustering, matching, graph-precompute) moet daarom **hervatbaar/gepagineerd** zijn. Het bewezen patroon: een admin-pagina (`app/admin/import/page.tsx`) die de import-lus **in de browser** draait (niet server-side), met kleine paginagroottes en automatische retries. Zie die pagina als sjabloon voor elke toekomstige zware batch-operatie.

2. **Firestore-batchlimieten:** max 500 operaties per batch, én een praktische limiet van ~10MB request-payload. Bij items met veel data (zoals edges met volledige geometrie) moet de chunkgrootte veel kleiner zijn dan bij lichte items (nodes). Vuistregel die werkte: ~450 operaties/batch voor lichte data, ~200 items/chunk of zelfs 1 chunk-document per commit (parallel via `Promise.all`) voor zware data.

3. **Gebruik altijd deterministische Firestore-document-ID's** (`${datasetVersionId}_${sourceObjectId}`) voor alles wat geïmporteerd of herhaald kan worden. Auto-gegenereerde ID's leidden tot dubbele documenten bij retries na een time-out — dit gebeurde zowel bij nodes als edges en kostte een hele opschoon-cascade om te herstellen (dedup-nodes, dedup-edges, wipe-clustering, wipe-matching routes, nu nog in de codebase als eenmalige opschoontools).

4. **Firebase Spark-plan (gratis) kan het dagquotum aan schrijfacties bereiken** bij zware importwerk (`RESOURCE_EXHAUSTED: Quota exceeded`). Er is destijds gesuggereerd om te upgraden naar Blaze (pay-as-you-go) — **controleer of dit daadwerkelijk is gebeurd**, dit is niet met zekerheid bevestigd in de sessie. Zo niet, kan hetzelfde probleem terugkeren bij een volgende zware batch-operatie.

5. **`circuityFactor` (rondje-generator) is GEEN stabiele constante.** Empirisch gemeten tussen 1,6 en 1,85 afhankelijk van het gebied (Utrecht vs. Amsterdam). Huidige default: 1,6. Niet verder tunen zonder nieuwe metingen — dit is een MVP-heuristiek, geen exacte wetenschap.

6. **De Location Resolver sluit sinds 28-8-2026 geïsoleerde nodes (0 edges) uit.** Vóór die fix kon de dichtstbijzijnde-node-selectie een volledig onbruikbaar startpunt opleveren (concreet gevonden bij een Amsterdam-test — zie `docs/phase2-route-engine-design.md` sectie 9C). Als je ooit weer "0 routes gevonden" ziet zonder duidelijke reden, check eerst `edgeCount` van het gekozen startpunt.

7. **Alleen `matchConfidence === 'matched'` edges vormen de routing-graph** (16.345 van 28.060). De overige edges blijven gewoon in de database staan (nooit verwijderd) voor herleidbaarheid/toekomstige verbetering, maar worden simpelweg niet meegenomen in de Dijkstra-adjacency.

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
