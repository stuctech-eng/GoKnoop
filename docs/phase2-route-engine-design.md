# GoKnoop — Phase 2: Route Engine Master Design

**Datum:** 26 augustus 2026
**Status:** ONTWERP — nog geen implementatie. Vastgesteld vóór code wordt geschreven.
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

---

## 4. GRAPH-LOADINGSTRATEGIE

**Te beslissen bij implementatie, hier de afweging vastgelegd:**

| Optie | Voordeel | Nadeel |
|---|---|---|
| A. Bij elke routeaanvraag opnieuw inladen (Firestore-query + in-memory adjacency-opbouw) | Simpel, altijd actueel | Bij 11.003 nodes / 16.345 edges: herhaalde leeskosten per aanvraag |
| B. In-memory cache op module-niveau (blijft bestaan tussen "warme" serverless-aanroepen) | Snel bij herhaald gebruik | Onvoorspelbaar wanneer een cold start de cache leegt; geen garantie op consistentie tussen instanties |
| C. Vooraf berekende, geëxporteerde adjacency-structuur (bijv. als los JSON-bestand of aparte Firestore-collectie, gegenereerd ná Phase 1-activatie) | Voorspelbaar snel, geen herhaalde Firestore-leescapaciteit nodig | Extra build/publicatiestap na elke dataset-activatie |

**Aanbeveling voor de eerste implementatie: optie A (simpel, correct), met optie C als bekende vervolgstap zodra performance een probleem blijkt.** Niet vooruitlopen op een optimalisatie die nog niet nodig is bewezen.

---

## 5. ALGORITME

**Dijkstra's kortste-pad-algoritme**, gewicht = `distanceM` per edge.

Waarom niet A*: A* heeft een heuristiek (bijv. Euclidische afstand tot het doel) nodig om sneller te zijn dan Dijkstra, en is vooral waardevol bij zeer grote graphs. Bij 11.003 nodes is Dijkstra ruim snel genoeg voor interactief gebruik; de eenvoud en het ontbreken van een heuristiek-correctheidsrisico wegen zwaarder dan de marginale snelheidswinst van A* op deze schaal.

**Alle matched edges zijn tweerichtingsverkeer in de pathfinding**, conform de vastgestelde `directionality=unknown → bidirectional`-routingpolicy (Phase 1 pre-flight punt 6). Dit is een expliciete, herroepbare beslissing op routing-niveau — geen aanname die is teruggeschreven in de brondata-interpretatie.

**Voorbereiding op toekomstige directionaliteit (zonder het nu te bouwen):** de edge-traversal-check in het algoritme wordt als aparte, benoemde functie geschreven (bijv. `isTraversable(edge, fromNodeId)`) die nu altijd `true` teruggeeft, in plaats van de richtingslogica inline in de Dijkstra-loop te verwerken. Zodra de rijrichting-semantiek ooit wordt opgehelderd (Phase 1B sectie 4), hoeft alleen deze ene functie aangepast te worden — geen rewrite van het pathfinding-algoritme zelf.

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
  - 422: geen route mogelijk (bijv. de twee nodes zitten in verschillende connected
         components — zie Phase 1 sectie 7, 669 components, niet elk paar nodes is
         bereikbaar van elkaar)
  - 200 met route: normale succesvolle berekening
```

**Belangrijk, direct gekoppeld aan de Phase 1-bevinding:** met 669 connected components (84,4% in de hoofdcomponent) zal een deel van de mogelijke A→B-combinaties **geen geldige route opleveren**, simpelweg omdat de twee punten niet met elkaar verbonden zijn in de gematchte graph. Dit is geen bug in de Route Engine — het is een correcte weerspiegeling van Phase 1's bevindingen. De 422-foutrespons moet dit duidelijk communiceren, niet als een onverklaarde mislukking.

---

## 8. CONSTRAINTS (MVP-scope)

**Wel in MVP:** expliciete, door de aanroeper meegegeven constraints — `avoidNodeIds`, `avoidEdgeIds`. Simpel te implementeren binnen Dijkstra (uitsluiten uit de adjacency tijdens het opbouwen van de graph voor deze specifieke aanvraag).

**Niet in MVP, wel voorbereid in het datamodel (sectie 6):** voorkeur-gebaseerde constraints (natuur, water, rustige wegen — Master Context sectie 9 `RoutePreferences`). Het `constraints`-veld op het Route-object is bewust generiek genoeg opgezet om hier later op te kunnen uitbreiden zonder het veld zelf te hoeven herontwerpen.

---

## 9. WAT DIT ONTWERP BEWUST NIET BESLIST

- **Meerdere routealternatieven genereren (k-shortest-paths of vergelijkbaar):** datamodel ondersteunt het (sectie 6, `alternatives[]`), het algoritme (sectie 5) niet. Dit is een expliciete, latere uitbreiding — niet nu bouwen, wel niet blokkeren met een datamodel-wijziging als het zover is.
- **Route-kwaliteitsscoring** (Master Plan-sectie 72/73, oorspronkelijk CodeSnap-document): geen onderdeel van dit MVP-contract. Kan later als extra sorteer-/filterlaag boven de kortste-padberekening.
- **Prestatie-optimalisatie van de graph-loadingstrategie** (sectie 4): bewust opengelaten totdat er een concrete performance-reden is om te kiezen.

---

## VOLGENDE STAP

Dit document is het contract. Zodra dit is goedgekeurd, kan de daadwerkelijke implementatie beginnen: eerst de graph-loading + Dijkstra-kernlogica (server-side, geen UI), getest met een handvol bekende A→B-paren uit de bestaande dataset, vóór er een API-route of frontend aan gekoppeld wordt.
