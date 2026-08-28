# GoKnoop — Phase 2: Route Engine Master Design

**Datum:** 26 augustus 2026
**Status:** ONTWERP GOEDGEKEURD (GO, na GPT-review 26-8-2026) — klaar voor implementatie, test-eerst-volgorde (zie sectie "Volgende stap")
**Basis:** Phase 1 (voltooid, zie `docs/phase1b-design.md`) + Master Context v2 (langetermijn-productvisie)

---

## 0. WAAROM EERST EEN ONTWERP, GEEN CODE

Phase 2 is fundamenteel anders dan Phase 1. Phase 1 ging over betrouwbare data → graph. Phase 2 beslist hoe die graph wordt omgezet in een routebaar object. Die beslissing (datamodel, algoritmekeuze, API-contract) legt de basis voor alles wat daarna komt (navigatie, voorkeuren, AI). Een verkeerde keuze hier is duur om later te herstellen — vandaar: eerst het contract vaststellen, dan pas bouwen.

---

## 1. SCOPE — WAT PHASE 2 (MVP) MOET KUNNEN

1. A → B route berekenen tussen twee logicalNodes
2. Kortste route (op afstand, niet op tijd — geen snelheidsmodel in MVP)
3. Totale afstand berekenen
4. Route reconstrueren als knooppuntenreeks (`nodes[]`, in volgorde)
5. Geometrie reconstrueren (aaneengesloten lijngeometrie voor kaartweergave)
6. Architectuur voorbereiden op meerdere routealternatieven (datamodel ondersteunt een array, MVP hoeft er niet per se meer dan 1 te vullen)
7. Route-metadata teruggeven (bron, algoritme, berekeningsduur, dataset-versie)
8. Expliciete constraints kunnen ontvangen (bijv. vermijd knooppunt X, vermijd edge Y)
9. `directionality=unknown` veilig behandelen (nooit een aanname forceren die niet bewezen is)
10. Voorbereid zijn op toekomstige routeprofielen (modaliteit, karakter) zonder daar nu op te bouwen

**Nadrukkelijk NIET in Phase 2 (Master Context sectie 23 — geen premature implementation):**
Route creation-features (rondjes, exacte afstand, langer/korter maken), routekarakter/`RoutePreferences`, waypoints ("ik wil hier langs"), POI-laag, AI-routeassistent, persoonlijke voorkeuren, opgeslagen routes/varianten, route recovery, weerbewuste routes, e-bike/batterij, samen fietsen, offline, wearables, veiligheidslaag, navigatie-UI. Deze blijven exact wat ze in Phase 1B al waren: toekomstvaste velden in het datamodel, geen gebouwde functionaliteit.

---

## 2. DATAFLOW

```
GRAPH (Phase 1 — logicalNodes + matched edges)
        ↓
ROUTE REQUEST (fromLogicalNodeId, toLogicalNodeId, constraints?)
        ↓
GRAPH LOADING (welke edges/nodes zijn beschikbaar voor deze aanvraag)
        ↓
PATHFINDING (kortste-pad-algoritme)
        ↓
ROUTE RECONSTRUCTIE (nodes[], edges[], geometry, distance)
        ↓
ROUTE OBJECT (volledig, met metadata)
```

Dit is de concrete invulling van Master Context sectie 3 (`Graph → Route Engine → Route`).

---

## 3. WELKE EDGES ZIJN ROUTEBAAR

**Beslissing: alleen `matchConfidence === 'matched'` edges worden in de routing-graph opgenomen.**

Edges met `unmatched_start`/`unmatched_end`/`unmatched_both` verwijzen niet betrouwbaar naar twee logicalNodes en kunnen dus geen bruikbare graph-kant vormen — ze blijven in de database staan (nooit verwijderd, zie Phase 1 pre-flight-principe "geen stille drops"), maar worden simpelweg niet meegenomen bij het opbouwen van de in-memory routing-graph.

Op de volledige dataset betekent dit: **16.345 van de 28.060 edges (58,3%)** vormen de routing-graph. Dat is bekend en geaccepteerd vanuit Phase 1 (sectie 6B/7) — geen nieuwe aanname, alleen een expliciete bevestiging dat de Route Engine dezelfde grens hanteert.

**Belangrijk, expliciet vastgelegd na review (26-8-2026): parallelle edges tussen dezelfde twee nodes zijn toegestaan.** Twee `logicalNode`'s kunnen door meerdere edges verbonden zijn (verschillende brongeometrieën, verschillende netwerken, of later verschillende modaliteiten/routekwaliteit). De graph modelleert dit dus NIET als een unieke `A→B`-relatie, maar staat meerdere edge-documenten tussen hetzelfde nodepaar toe. Dijkstra kiest bij het opbouwen van de adjacency automatisch de goedkoopste (kortste `distanceM`) van de beschikbare parallelle edges voor dat nodepaar — dit vereist geen aanpassing aan het algoritme zelf, alleen dat de adjacency-opbouw een node-paar niet overschrijft bij een tweede edge, maar beide edges als aparte kant-opties aanhoudt.

**`distanceM` betekent expliciet: de lengte van de brongeometrie (uit `lengte_m` in Routedatabank), NIET de Euclidische (rechte-lijn) afstand tussen de twee eindpunten.** Bij een edge met een bocht is dat verschil substantieel — Dijkstra moet de daadwerkelijke af te leggen afstand gebruiken, anders ontstaan systematisch te korte route-inschattingen bij bochtige geometrieën.

---

## 4. GRAPH-LOADINGSTRATEGIE

**Te beslissen bij implementatie, hier de afweging vastgelegd:**

| Optie | Voordeel | Nadeel |
|---|---|---|
| A. Bij elke routeaanvraag opnieuw inladen (Firestore-query + in-memory adjacency-opbouw) | Simpel, altijd actueel | Bij 11.003 nodes / 16.345 edges: herhaalde leeskosten per aanvraag |
| B. In-memory cache op module-niveau (blijft bestaan tussen "warme" serverless-aanroepen) | Snel bij herhaald gebruik | Onvoorspelbaar wanneer een cold start de cache leegt; geen garantie op consistentie tussen instanties |
| C. Vooraf berekende, geëxporteerde adjacency-structuur (bijv. als los JSON-bestand of aparte Firestore-collectie, gegenereerd ná Phase 1-activatie) | Voorspelbaar snel, geen herhaalde Firestore-leescapaciteit nodig | Extra build/publicatiestap na elke dataset-activatie |

**Aanbeveling voor de eerste implementatie: optie A (simpel, correct), met optie C als bekende vervolgstap zodra performance een probleem blijkt.** Niet vooruitlopen op een optimalisatie die nog niet nodig is bewezen.

**Vastgelegd na review (26-8-2026): de architectuur mag niet afhangen van welke laadstrategie gekozen wordt.** Dit wordt afgedwongen via een expliciete interface-abstractie, niet door Dijkstra rechtstreeks tegen Firestore te laten praten:

```
GraphProvider
 ├── load(datasetVersionId)
 └── getAdjacency()

Eerste implementatie:  Firestore-query  → GraphProvider → Dijkstra
Latere optimalisatie:  In-memory cache  → GraphProvider → Dijkstra
Latere optimalisatie:  Precomputed data → GraphProvider → Dijkstra
```

Dijkstra (en elke toekomstige pathfinding-implementatie, zie sectie 5) roept alleen `getAdjacency()` aan en weet niets van hóé die data geladen is. Dat betekent: optie A nu bouwen, later zonder wijziging aan de pathfinding-code overstappen op optie B of C.

**BENCHMARK-RESULTAAT EN DEFINITIEVE KEUZE (26-8-2026):** na implementatie van alle drie de opties is een eerlijke meting uitgevoerd op de volledige productiedataset (11.003 nodes, 16.345 edges), dezelfde route (`ysPQwdlis6xmkwthaZYL → 4LfEocIOnTjfHJTWNHlj`, 102,4km) in elke modus.

| | A (Firestore direct) | B koud | **B warm** | C (precomputed) |
|---|---|---|---|---|
| loadTimeMs | 7.292 | 6.539 | **0** | 6.089 |
| Dijkstra | 14ms | 10ms | 9ms | 13ms |
| **totalTimeMs** | **~7.300** | ~6.580 | **~29** | ~6.130 |

**Optie C (precomputed) loste het probleem niet wezenlijk op** — 82 gechunkte edge-documenten parallel inlezen (`Promise.all`) bleef netwerk-round-trip-overhead houden, amper sneller dan optie A, en voegt een aparte precompute-pipeline toe (82 chunk-documenten, tot 373MB geheugenpiek tijdens het inladen) voor weinig winst. Dit bevestigt het risico dat vooraf werd benoemd: "het probleem verplaatsen, niet oplossen."

**Optie B (in-memory cache) wint overtuigend.** Een warme aanvraag: **29ms totaal — een factor 250 sneller** dan de huidige situatie. Bevestigd met een reproduceerbare `cacheHit: true` en `loadTimeMs: 0`. Een eerste anomalie (345ms Dijkstra-tijd bij één warme meting) bleek garbage-collection-ruis door voorafgaande zware tests in dezelfde instance, niet een echt probleem — bevestigd door een herhaalde, schone meting (9ms).

**DEFINITIEVE ARCHITECTUURKEUZE: optie B (`CachedGraphProvider`, module-niveau in-memory cache).** Optie A blijft de fallback/eerste-aanvraag-gedrag (een cold start laadt nog steeds ~6,5s, dat verandert niet), optie C wordt niet in productie gebruikt (de precompute-pipeline en `PrecomputedGraphProvider` blijven in de code staan als bewezen-niet-gekozen alternatief, niet als dode code zonder reden).

**Blijvend aandachtspunt, niet opgelost door deze keuze:** een cold start (nieuwe serverless-instance, na inactiviteit of een nieuwe deploy) kost nog steeds ~6,5 seconden voor de eerste aanvraag op die instance. Dat is acceptabel als incidentele eerste-gebruiker-vertraging; wordt pas een probleem als cold starts vaak genoeg voorkomen om structureel merkbaar te zijn — dan pas is verdere optimalisatie (bijv. een "warm-up"-aanroep na elke dataset-activatie) de moeite waard.

---

## 5. ALGORITME

**Dijkstra's kortste-pad-algoritme**, gewicht = `distanceM` per edge.

Waarom niet A*: A* heeft een heuristiek (bijv. Euclidische afstand tot het doel) nodig om sneller te zijn dan Dijkstra, en is vooral waardevol bij zeer grote graphs. Bij 11.003 nodes is Dijkstra ruim snel genoeg voor interactief gebruik; de eenvoud en het ontbreken van een heuristiek-correctheidsrisico wegen zwaarder dan de marginale snelheidswinst van A* op deze schaal.

**Alle matched edges zijn tweerichtingsverkeer in de pathfinding**, conform de vastgestelde `directionality=unknown → bidirectional`-routingpolicy (Phase 1 pre-flight punt 6). Dit is een expliciete, herroepbare beslissing op routing-niveau — geen aanname die is teruggeschreven in de brondata-interpretatie.

**Voorbereiding op toekomstige directionaliteit (zonder het nu te bouwen):** de edge-traversal-check in het algoritme wordt als aparte, benoemde functie geschreven (bijv. `isTraversable(edge, fromNodeId)`) die nu altijd `true` teruggeeft, in plaats van de richtingslogica inline in de Dijkstra-loop te verwerken. Zodra de rijrichting-semantiek ooit wordt opgehelderd (Phase 1B sectie 4), hoeft alleen deze ene functie aangepast te worden — geen rewrite van het pathfinding-algoritme zelf.

**Expliciete laagscheiding, vastgelegd na review (26-8-2026):** de graph zelf (zoals opgeslagen, `directionality: 'unknown'`) wordt NOOIT herschreven naar `'bidirectional'`. Dat blijft `unknown`, precies zoals Phase 1 het heeft vastgelegd. De vertaling naar "in de praktijk beide richtingen toegestaan" gebeurt uitsluitend in de `isTraversable()`-routingpolicy-laag, niet door de brondata-interpretatie te overschrijven:

```
RAW (Firestore)                 directionality = 'unknown'   ← blijft altijd zo
        ↓
RoutingPolicy (isTraversable)   unknown → traversable in beide richtingen
```

Dit is geen cosmetisch verschil: het betekent dat de routingpolicy later kan veranderen (bijv. zodra de rijrichting-semantiek is opgehelderd) zonder de geïmporteerde graph opnieuw te hoeven opbouwen of migreren.

**Architectuur voorbereid op meerdere algoritmes (niet nu bouwen):**
```
Route Engine
 ├── Dijkstra          (MVP)
 ├── A*                (later, zelfde Route-contract)
 └── toekomstige algoritmes
```
Een latere overstap naar (of aanvulling met) A* verandert het API-contract en het Route-datamodel niet — alleen de interne pathfinding-implementatie.

---

## 6. ROUTE-OBJECT DATAMODEL

Aansluitend op Master Context sectie 7 (toekomstvast routeobject), met MVP-gevulde velden en expliciet-lege placeholder-velden voor latere fases:

```
Route
 ├── id                    -- gegenereerd bij routeberekening
 ├── datasetVersionId      -- welke graph-versie is gebruikt (Phase 1-koppeling)
 ├── source                -- 'route-engine-v1' (voor toekomstige algoritme-tracking)
 ├── network               -- 'fiets' (zie Phase 1B sectie 8/9B — niet hardcoded aan mode)
 ├── mode                  -- 'bicycle' (MVP altijd dit, veld al aanwezig voor toekomst)
 ├── nodes[]                -- logicalNodeId's in volgorde (de knooppuntenreeks)
 ├── edges[]                -- edge-id's in volgorde (welke edge tussen elk node-paar)
 ├── geometry               -- aaneengesloten coördinatenreeks (coords[] per edge, juiste richting samengevoegd)
 ├── distanceM              -- som van edge distanceM langs de route
 ├── elevation              -- null (MVP) — veld aanwezig voor toekomstige hoogteprofieldata
 ├── durationEstimate        -- null (MVP) — geen snelheidsmodel nu; veld aanwezig voor toekomst
 ├── preferences             -- {} (MVP) — toekomstige RoutePreferences (sectie 9 Master Context)
 ├── constraints             -- MVP-gevuld: expliciet meegegeven bij de aanvraag (zie sectie 8)
 ├── waypoints[]              -- [] (MVP) — toekomstige "ik wil hier langs"
 ├── alternatives[]           -- MVP: array met minimaal 1 Route (zichzelf niet dubbel), structuur
 │                              ondersteunt al meerdere — vullen met >1 is een latere uitbreiding,
 │                              geen datamodel-wijziging
 ├── navigation              -- null (MVP) — toekomstige turn-by-turn-structuur
 └── metadata
      ├── algorithm          -- 'dijkstra'
      ├── computedAt
      ├── computeTimeMs
      └── edgesConsidered     -- hoeveel edges in de routing-graph zaten (16.345, ter referentie)
```

**Waarom dit ontwerp:** elk "nog niet gebouwd"-veld staat er al met een expliciete lege/null-waarde, in plaats van simpelweg te ontbreken. Dat voorkomt precies het probleem dat Master Context sectie 22/23 benoemt — een toekomstige feature (bijv. elevation-gebaseerde e-bike-berekening) kan aanhaken op een bestaand veld zonder dat het Route-object opnieuw ontworpen hoeft te worden.

**Expliciet vastgelegd na review (26-8-2026): `edges[]` is verplicht, niet af te leiden uit `nodes[]`.** Reden: door parallelle edges (sectie 3) kunnen twee routes dezelfde knooppuntenreeks hebben maar verschillende edge-geometrieën/metadata gebruiken. De route moet dus "edge-aware" zijn — `nodes[]` alleen is onvoldoende om de route eenduidig te reconstrueren.

**Nieuwe validatieregel: de distance-invariant.** Na elke routeberekening moet gelden:
```
route.distanceM === Σ (edges[i].distanceM)   [binnen een expliciet gedefinieerde afrondingstolerantie]
route.geometry   === aaneenschakeling van edges[i].geometry (in de juiste doorlooprichting)
```
Dit is een interne consistentietest die bij elke implementatie/wijziging van de Route Engine gecontroleerd moet worden — een afwijking betekent dat de route-reconstructie een fout bevat, ongeacht of Dijkstra zelf correct rekende.

---

## 7. API-CONTRACT (schets, geen implementatiedetail)

```
POST /api/route
Body:
  {
    fromLogicalNodeId: string,
    toLogicalNodeId: string,
    constraints?: {
      avoidNodeIds?: string[],
      avoidEdgeIds?: string[]
    }
  }

Response: Route (zie sectie 6)

Foutgevallen (expliciet, geen stille failures):
  - 404: fromLogicalNodeId of toLogicalNodeId bestaat niet in de actieve dataset
  - 422: geen route mogelijk — MET machineleesbare reden, niet alleen een generieke
         foutmelding:
         reason: 'disconnected'                      -- nodes bestaan, zitten in
                                                          verschillende connected components
         reason: 'no_traversable_edges'               -- node bestaat, heeft geen
                                                          matched edges (isolated node)
         reason: 'all_paths_blocked_by_constraints'   -- een route zou bestaan, maar
                                                          avoidNodeIds/avoidEdgeIds
                                                          sluiten alle opties uit
  - 200 met route: normale succesvolle berekening
```

**Belangrijk, direct gekoppeld aan de Phase 1-bevinding:** met 669 connected components (84,4% in de hoofdcomponent) zal een deel van de mogelijke A→B-combinaties **geen geldige route opleveren**, simpelweg omdat de twee punten niet met elkaar verbonden zijn in de gematchte graph. Dit is geen bug in de Route Engine — het is een correcte weerspiegeling van Phase 1's bevindingen. De 422-foutrespons moet dit duidelijk communiceren, niet als een onverklaarde mislukking.

---

## 8. CONSTRAINTS (MVP-scope)

**Wel in MVP:** expliciete, door de aanroeper meegegeven constraints — `avoidNodeIds`, `avoidEdgeIds`. Simpel te implementeren binnen Dijkstra (uitsluiten uit de adjacency tijdens het opbouwen van de graph voor deze specifieke aanvraag).

**Semantiek expliciet vastgelegd na review (26-8-2026):**
- **`avoidNodeIds`** — de route mag deze node(s) helemaal niet gebruiken, ook niet als tussenstop. (Gebruik als start- of eindpunt is alleen toegestaan als de API dat expliciet aangeeft — standaard dus ook niet.)
- **`avoidEdgeIds`** — alleen die specifieke edge(s) mogen niet gebruikt worden. Dit vermijdt NIET automatisch alle parallelle edges tussen hetzelfde nodepaar (zie sectie 3) — als er een alternatieve edge tussen dezelfde twee nodes bestaat, blijft die wél beschikbaar.

Dit onderscheid is belangrijk zodra parallelle edges vaker voorkomen — een gebruiker die één specifieke (bijv. drukke) route-optie wil vermijden, moet niet per ongeluk ook het alternatief tussen dezelfde twee knooppunten blokkeren.

**Niet in MVP, wel voorbereid in het datamodel (sectie 6):** voorkeur-gebaseerde constraints (natuur, water, rustige wegen — Master Context sectie 9 `RoutePreferences`). Het `constraints`-veld op het Route-object is bewust generiek genoeg opgezet om hier later op te kunnen uitbreiden zonder het veld zelf te hoeven herontwerpen.

---

## 9B. PHASE 3-VOORBEREIDING — EMPIRISCH GEVALIDEERD (28-8-2026)

Vóór Phase 3 (Core GoKnoop UX) is gestart, zijn de drie ontbrekende capabilities gebouwd en tegen de échte productiedataset (11.003 nodes, 16.345 matched edges) getest — niet alleen tegen fixtures. Vastgelegd als contract, zodat Phase 3 hierop kan bouwen zonder losse, nergens vastgelegde aannames.

**Location Resolver** (`lib/route-engine/location-resolver.ts`): ✅ gevalideerd. "Utrecht" → correct gegeocodet via Nominatim naar "Utrecht, Nederland", dichtstbijzijnde knooppunt op 444m. Coördinatenconversie (WGS84↔RD New via `proj4`) apart geverifieerd tegen een extern referentiepunt, nauwkeurig tot ~0,3m.

**RoutePlanner** (`lib/route-engine/route-planner.ts`): ✅ gevalideerd, met een belangrijke bevestiging van het Phase 2-ontwerp in de praktijk:
- **Parallelle edges worden correct als aparte alternatieven behandeld** (ontwerp sectie 3) — een testpaar knooppunten bleek verbonden door twee parallelle edges (308m en 333m), en de planner vond en presenteerde ze automatisch als 2 losse alternatieven, zonder dat daar aparte logica voor nodig was.
- **`foundCount` is eerlijk, geen kunstmatige opvulling naar het gevraagde aantal:**
  - 102km-testcase (twee ver uit elkaar gelegen Noord-Brabant-knooppunten): `foundCount: 1` van de 4 gevraagde — er bestond simpelweg geen tweede, voldoende diverse route.
  - 308/333m-testcase (dichtbij gelegen knooppunten, parallelle edges): `foundCount: 2` van de 4 gevraagde — precies het aantal daadwerkelijk beschikbare, verschillende verbindingen.
- **Contractbevestiging: een aanvraag levert NOOIT gegarandeerd 4 routes op.** Dit moet Phase 3's UI expliciet honoreren (zie hieronder) — nooit doen alsof er altijd 4 keuzes zijn.

**Rondje-generator** (`lib/route-engine/loop-route-generator.ts`): ✅ gevalideerd, met een herijking op basis van echte meting:
- Eerste test (target 20km, `circuityFactor=1.3`): beste kandidaat 25,3km (26,5% afwijking) — te grof.
- **`circuityFactor` herijkt naar 1,6** op basis van de gemeten werkelijke verhouding (25.309m / (2×7.692m) = 1,65).
- Na herijking + meerdere kandidaten per richting (`CANDIDATES_PER_BUCKET=3`): beste kandidaat 23,1km (**15,7% afwijking**) — bruikbaar.
- **Belangrijke structurele bevinding, niet zomaar op te lossen met nóg een parametertuning:** de werkelijke omwegfactor is **geen stabiele constante**, maar varieert per richting en lokale netwerkdichtheid (tweede meting gaf 1,85, niet 1,6). Dit is een eigenschap van het fietsknooppuntennetwerk zelf (sommige gebieden zijn dichter vertakt dan andere), geen bug. Verdere precisie-winst vereist waarschijnlijk richtingsafhankelijke kalibratie of een adaptief zoekalgoritme — bewust niet nu gebouwd, MVP-heuristiek volstaat.
- **Consequentie voor Phase 3 UI: toon de werkelijke afstand, doe niet alsof het exact de gevraagde afstand is** (bijv. "±23 km" of de exacte waarde, niet een afgeronde "20 km"-belofte).

**Samenvattend contract voor Phase 3:**
```
✅ Location Resolver, RoutePlanner, rondje-generator: gevalideerd op echte data
✅ Parallelle edges: correct afzonderlijk aangeboden
✅ foundCount: altijd eerlijk, nooit kunstmatig opgevuld
❗ GEEN garantie op 4 routes per aanvraag — UI moet "Ik heb N routes gevonden" tonen, N is niet vast
❗ Rondje-afstand is een BENADERING — toon de werkelijke afstand, niet de gevraagde waarde als belofte
📐 circuityFactor (1,6) is een empirische aanname op basis van een klein aantal metingen, geen universele constante — te herzien zodra meer data beschikbaar is
```

---

## 9. WAT DIT ONTWERP BEWUST NIET BESLIST

- **Meerdere routealternatieven genereren (k-shortest-paths of vergelijkbaar):** datamodel ondersteunt het (sectie 6, `alternatives[]`), het algoritme (sectie 5) niet. Dit is een expliciete, latere uitbreiding — niet nu bouwen, wel niet blokkeren met een datamodel-wijziging als het zover is.
- **Route-kwaliteitsscoring** (Master Plan-sectie 72/73, oorspronkelijk CodeSnap-document): geen onderdeel van dit MVP-contract. Kan later als extra sorteer-/filterlaag boven de kortste-padberekening.
- **Prestatie-optimalisatie van de graph-loadingstrategie** (sectie 4): bewust opengelaten totdat er een concrete performance-reden is om te kiezen.

---

## 10. GO/NO-GO (GPT-review, 26-8-2026)

**GO.** Alle onderdelen beoordeeld, vier aanvullingen verwerkt in dit document (parallelle edges, verplichte edge-sequence, distance-invariant, GraphProvider-abstractie). Geen nieuwe onderzoeksfase nodig.

---

## VOLGENDE STAP — TEST-EERST, VÓÓR API/UI

Dit document is het contract. De implementatie begint expliciet **niet** met een API-route of frontend, maar met de kernlogica, getest tegen bekende scenario's:

```
1. Graph fixture (klein, handmatig samengesteld testgraafje — niet de volledige productiedata)
        ↓
2. Dijkstra op de fixture → bekende, met de hand berekende kortste paden
        ↓
3. Constraints (avoidNodeIds/avoidEdgeIds) → verwacht gedrag getest
        ↓
4. Disconnected nodes → 422 met de juiste reason-code getest
        ↓
5. Geometry-reconstructie → distance-invariant getest (sectie 6)
        ↓
6. Pas dán: API-route (POST /api/route)
        ↓
7. Pas dán: koppeling aan de echte productiedataset (11.003 nodes, 16.345 edges)
```

Zo staat vast dat de Route Engine zelf correct is vóórdat er een interface omheen wordt gebouwd — dezelfde discipline die Phase 1 ook honderden empirische stappen verder heeft gebracht dan een blind vertrouwen op aannames.
