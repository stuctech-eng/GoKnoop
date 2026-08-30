# GoKnoop — MASTER DOCUMENT

**Datum:** 29 augustus 2026
**Doel:** één zelfstandig document dat een nieuwe Claude/GPT-sessie volledig op de hoogte brengt — Phase 0 t/m 3 (samengevat), Phase 4 Navigation-engine (volledig, met echte iPhone-validatie), en de vastgelegde UX-visie voor Phase 4's navigatie-UI (stap 12, nog te bouwen). Vervangt niet `docs/phase1b-design.md`, `docs/phase2-route-engine-design.md`, `docs/HANDOFF.md` of `docs/phase4-navigation-design.md` (die blijven de gedetailleerde bron), maar bundelt de kern zodat niet elke sessie losse stukken hoeft te reconstrueren.

**Belangrijke leesaanwijzing:** overal waar de status van een item vermeld staat, betekent
- **BESTAAND BESLUIT** — al eerder vastgelegd, hier alleen samengevat, niet opnieuw ter discussie
- **CONCRETISERING** — een bestaand concept nu voor het eerst in detail uitgewerkt (m.n. de UX in sectie 5) — geen nieuwe architectuurbeslissing, wel nieuwe visuele/interactie-invulling
- **🆕 NIEUW** — pas nu benoemd/vastgelegd

---

## 1. STATUS

```
Phase 0/1 — Data Foundation              ✅ COMPLETE
Phase 2   — Graph + Route Engine         ✅ COMPLETE (benchmark-onderbouwd)
Phase 3   — Core GoKnoop UX (MVP)        ✅ VALIDATED op echte productiedata
Phase 4   — Navigation ENGINE            ✅ COMPLETE + GEVALIDEERD (stap 1-11B, incl. echte iPhone-test)
Phase 4   — Navigation UI                ⬜ stap 12 — 12.1-12.7 ✅ + dataketen-fix ✅ + Start-knop-koppeling ✅ GEBOUWD + getest — klaar voor de ÉÉN echte lokale testrit
```

**Live app:** https://go-knoop.vercel.app
**Repo:** `stuctech-eng/GoKnoop` (publiek op GitHub)
**Werkwijze:** iPhone-first via Working Copy, geen lokale ontwikkelomgeving. Code als zip aangeleverd, gebruiker pakt zelf uit/commit/pusht. Vercel-deploy, testen in Safari.
**Actieve dataset-versie:** `uINZ3y2QsgBdEyky3duq`

---

## 2. PHASE 0-3 — SAMENVATTING (BESTAAND BESLUIT, gedetailleerd in phase1b-design.md/phase2-route-engine-design.md/HANDOFF.md)

### 2.1 Data Foundation
```
Source nodes         13.152        →  Logical nodes      11.003
Source edges         28.067        →  Valid graph edges  28.060  (7 excluded/unresolved, traceerbaar)
Matched edges        16.345  (58,3% — dit is de daadwerkelijke routing-graph)
Hoofdcomponent       84,4% van alle logicalNodes
```
Firestore (niet Supabase — gewijzigd tijdens Phase 1B, project `go-knoop`). Coördinaten blijven platte `x`/`y`-velden in RD New (EPSG:28992), geen `GeoPoint`/PostGIS. Drie-lagen-datamodel: `sourceNodes` → `logicalNodes` (via `sourceNodeMappings`, nooit destructief) → `edges` (met `endpointMatches` voor volledige herleidbaarheid, matchtoleranties 0,5m/2m/5m).

**Bewust nog niet opgelost, geen blocker:** 7 excluded/unresolved edges, 114 `exception_review`-clusters, rijrichting-semantiek gepauzeerd (`directionality: 'unknown'` als veilige default, `isTraversable()` behandelt dit als bidirectioneel), Firebase Spark-vs-Blaze-status onbevestigd.

### 2.2 Route Engine (Phase 2)
`GraphProvider`-abstractie (`CachedGraphProvider`, benchmark: ~29ms warm, ~6,5s koud) → Dijkstra → `Route`-object. Contract: `POST /api/route` — `{ fromLogicalNodeId, toLogicalNodeId, constraints?: { avoidNodeIds?, avoidEdgeIds? } }` → 200 (`Route`) / 404 (node bestaat niet) / 422 (`reason`: `disconnected`/`no_traversable_edges`/`all_paths_blocked_by_constraints`). Distance-invariant: `Route.distanceM` = som van edge-`distanceM` (brongeometrie-lengte, nooit Euclidisch). Amsterdam-bugfix: `resolveNearestNodes()` sluit geïsoleerde nodes (0 edges) uit.

**Bekende, nog niet opgeloste kloof (herbevestigd tijdens Phase 4 stap 8):** `POST /api/route` accepteert geen `datasetVersionId`-parameter, gebruikt altijd `config/activeDataset` vers uit Firestore. Zie sectie 3.6.

### 2.3 Core UX / MVP (Phase 3)
Flow: locatie/plaats kiezen → afstand → routes vinden (4 voorstellen) → route kiezen → starten. Location Resolver, RoutePlanner-alternatieven, rondje-generator (`circuityFactor` empirisch 1,6-1,85, geen vaste constante). Gevalideerd op echte productiedata.

**Niet bouwen, nog steeds van kracht (Master Context sectie 23):** AI-routeassistent, POI's, persoonlijke voorkeuren, weer, e-bike/batterij, samen fietsen, offline, wearables, veiligheidslaag.

---

## 3. PHASE 4 — NAVIGATION ENGINE (BESTAAND BESLUIT, volledig, `docs/phase4-navigation-design.md` is de volledige bron)

### 3.1 Kernarchitectuur: Route versus NavigationSession

```
Route             = wat de gebruiker heeft gekozen (Phase 2/3, NOOIT gemuteerd door navigatie)
NavigationSession = waar de gebruiker zich nu bevindt + voortgang + afwijking + status
                    + eventueel herberekende route (apart Route-object, referentie via routeId)
```
Bij een reroute: nieuw `Route`-object, oorspronkelijke blijft ongewijzigd (bewezen met tests: `oldRoute.id !== newRoute.id`, diepe gelijkheid van `oldRoute` vóór/na).

### 3.2 De volledige keten (alle 11 stappen ✅ afgerond en getest)

```
GPS simulator (stap 1)
   ↓
NavigationSession state machine (stap 2) — 11 states, incl. PERMISSION_DENIED apart van GPS_LOST
   ↓
GPS-metadata / navigation clock (stap 3) — GPS-timestamp / navigation time / last-valid-fix strikt gescheiden
   ↓
Candidate-based matching (stap 4) — afstand + heading + continuïteit, geen pure dichtstbijzijnde-lijn
   ↓
Progress calculation (stap 5) — Route.edges[]/edge.distanceM leidend, niet rauwe geometrie
   ↓
Deviation detection (stap 6) — bevestigingsvenster in de state machine leidend, geen distance>X-kortsluiting
   ↓
Reroute-context (stap 7) — RECENT_ROUTE_MEMORY, temporaryAvoidEdgeIds, vervalt bij bevestigd ON_ROUTE
   ↓
Route Engine-koppeling (stap 8) — hergebruikt POST /api/route exact, dataset-versie-pinning als vangnet
   ↓
Lifecycle (stap 9) — GPS_LOST/PERMISSION_DENIED/PAUSED/ARRIVED/CANCELLED, permission strikt los van GPS_LOST
   ↓
Integratietests (stap 10) — 10 scenario's, volledige keten, kalibratie-verkenning (geen productiewaarden)
   ↓
Echte iPhone-GPS + Wake Lock (stap 11/11B) — GEVALIDEERD op echt toestel, zie sectie 3.4
```

**Codebase:** `lib/navigation/` — `types.ts`, `session/`, `clock/`, `matching/`, `progress/`, `deviation/`, `reroute/`, `lifecycle/`, `gps-sources/` (incl. `browser-geolocation-source.ts`), `wake-lock/`, `testing/`, `integration/`. **237 tests, `tsc` schoon.**

### 3.3 Navigation state machine (11 states)

```
NOT_STARTED → ON_ROUTE ↔ POSSIBLE_DEVIATION → OFF_ROUTE → REROUTING → REROUTED → ON_ROUTE → ARRIVED
overlays: GPS_LOST, PAUSED, CANCELLED, PERMISSION_DENIED
```
`PERMISSION_DENIED` is een eigen state, NOOIT via `GPS_LOST` bereikt of behandeld — bevestigd zowel in isolatie (stap 9) als in de integratietests (stap 10) als met echte GPS (stap 11).

### 3.4 Echte iPhone-bevindingen (🆕 NIEUW t.o.v. het oorspronkelijke ontwerp, empirisch)

- Bevestigingsvenster werkt exact zoals ontworpen tegen echte, ruizige GPS (~5,0-5,2s gemeten, consistent over meerdere sessies).
- Progress liep monotoon op tot 100% bij aankomst.
- **Scherm-uit breekt de sessie volledig:** Safari bevriest niet alleen `watchPosition` maar de hele pagina — 5,5 minuten test zonder enige update, gevolgd door een opgehoopte inhaalslag van state-transities bij hervatting.
- **Screen Wake Lock als MVP-maatregel toegevoegd en gevalideerd** (`lib/navigation/wake-lock/screen-wake-lock.ts`): aangevraagd bij sessiestart, vrijgegeven bij Stop/PERMISSION_DENIED/unmount, automatische her-aanvraag via `visibilitychange`. **Op een echt toestel ~13 minuten getest: scherm bleef onafgebroken vanzelf actief, geen GPS_LOST, geen sessieonderbreking.**
- **Conclusie, expliciet: "Web-MVP navigatie = scherm-aan navigatie" is een houdbare, geteste aanname — geen garantie tegen elke vorm van pagina-opschorting, wél de dominante praktijksituatie afgedekt.**

### 3.5 PWA-architectuurkeuze (BESTAAND BESLUIT, herbevestigd)

```
📱 installeerbaar op het beginscherm     🗺️ navigatie volledig in de PWA
📍 GPS via de browser Geolocation API    🔋 Wake Lock tijdens actieve navigatie
🌐 geen native app nodig voor de MVP
```
De laagscheiding (`GpsSource → matching → progress → deviation → navigation`) maakt een latere native shell met achtergrond-locatie mogelijk zonder de engine opnieuw te ontwerpen — géén reden om nu naar native over te stappen.

### 3.6 Dataset-version-pinning (BESTAAND BESLUIT, met een bekende, niet-opgeloste kloof)

Een `NavigationSession` blijft gepind aan de `datasetVersionId` van de oorspronkelijke `Route`, ook bij reroute. **Kloof:** `POST /api/route` accepteert dit vandaag niet als parameter (leest altijd `config/activeDataset`). Vangnet: `RerouteExecutor` vergelijkt de teruggekregen `datasetVersionId` met de gepinde waarde en weigert bij een mismatch (`dataset_version_mismatch`) i.p.v. stilzwijgend te accepteren. **Echte oplossing (API uitbreiden met optionele `datasetVersionId`) is bewust uitgesteld tot een aparte architectuurreview — niet stiekem meenemen in een volgende stap.**

### 3.7 Nog te kalibreren waarden (BESTAAND BESLUIT: bewust NIET vastgezet)

| Constante | Uitgangspunt (stap 10/11) | Status |
|---|---|---|
| `deviationThresholdM` | 20m | ≥10m stabiel gebleken tegen ±5m ruis (simulatie) |
| `deviationConfirmDurationMs` | 5000ms | Consistent gemeten ~5,0-5,2s met echte GPS |
| `rerouteCooldownMs` | 10000ms | Consistent gedrag 2000-15000ms (simulatie) |
| `RECENT_ROUTE_MEMORY` | 200m | Expliciete afweging pingpong-preventie vs. U-bocht-vrijheid, geen "juiste" waarde aangewezen |
| `accuracyThresholdM` | 20m | Nog niet apart gekalibreerd |
| `gpsTimeoutMs` | 10000ms | Mogelijk te laag bij bewust stilstaan (scherm aan) — geen probleem gebleken, wel een aandachtspunt |

**Geen van deze waarden mag als productiewaarde behandeld worden vóór verdere, bredere meting** (meer routes, meer omstandigheden, langere ritten).

---

## 4. WAT WEL EN NIET GEBOUWD WORDT (BESTAAND BESLUIT + CONCRETISERING)

**Wel (Phase 4, engine + UI):**
- Alles in sectie 3 (engine, ✅ compleet)
- De navigatie-UI (stap 12, sectie 5 hieronder)

**Niet in Phase 4** (Master Context sectie 23, ongewijzigd): AI-routeassistent, POI's, persoonlijke voorkeuren, weer, e-bike/batterij, samen fietsen, volledige offline-navigatie (contract wel voorbereid, zie phase4-navigation-design.md sectie 15), wearables, veiligheidslaag, turn-by-turn spraak/audio, achtergrondnavigatie als gegarandeerde functionaliteit (zie 3.4).

---

## 5. PHASE 4 — NAVIGATIE-UI (stap 12), UX-VISIE

**Status van dit hele hoofdstuk: CONCRETISERING.** Dit is geen nieuwe architectuurbeslissing naast het Master Plan — het is de visuele/interactieve uitwerking van wat al in Phase 3/4's scope stond, nu voor het eerst gedetailleerd. Waar iets een bestaand besluit is versus nieuw benoemd, staat expliciet gemarkeerd.

### 5.0 Kaartlibrary-beslissing (🆕 NIEUW, definitief — 29-8-2026)

**MapLibre GL JS**, niet Leaflet, niet Google Maps.

Niet omdat Leaflet technisch ongeschikt zou zijn — het is een prima lichte MVP-optie — maar omdat GoKnoop's gewenste eindervaring (moderne kaartweergave, vloeiende zoom, eigen styling van wegen/fietsroutes/knooppunten, een kaartlaag die onafhankelijk van de navigatie-engine kan evolueren, geen Google-afhankelijkheid) beter past bij MapLibre's vector-tile-architectuur.

**Harde architectuurregel, niet onderhandelbaar:** de navigatie-engine (`lib/navigation/`) mag NOOIT afhankelijk worden van MapLibre-types.

```
GPS → GpsFixEvaluator → Candidate Matcher → Progress → Deviation Detection
   → NavigationStateMachine → NavigationSession → Route → MapLibre Adapter / UI
```

MapLibre is uitsluitend presentatielaag. Als MapLibre ooit vervangen moet worden, verandert alleen de kaart-/UI-laag — de Route Engine, `NavigationSession`, GPS-logica, matching, progress-berekening en rerouting blijven onaangeroerd. Concreet: een aparte kaartadapterlaag (`lib/map/MapLibreAdapter` of gelijkwaardig, exacte structuur af te stemmen bij implementatie), UI-componenten (`components/navigation/NavigationScreen`, `DirectionGuidance`, `NavigationMap`, `NavigationProgress` of gelijkwaardig) consumeren de bestaande `lib/navigation/`-types, nooit andersom.

### 5.1 De volledige flow (Phase 3 blijft, wordt niet vervangen)

```
1. Waar wil je fietsen?          📍 Mijn locatie                         BESTAAND BESLUIT (Phase 3)
2. Waar parkeer je?              🅿️ Geschikte parkeerplaats              BESTAAND BESLUIT (Master Plan)
3. Naar startpunt                🅿️ → 🚲 Startknooppunt                  BESTAAND BESLUIT
4. Kies route                    4 routevoorstellen                      BESTAAND BESLUIT (Phase 3)
5. Start                         → NAVIGATIE-UI (hieronder)              CONCRETISERING — stap 12
```
Phase 4-navigatie is de logische voortzetting ná Phase 3, niet een vervanging ervan. De parkeerplaats-stap blijft gewoon onderdeel van de flow vóór navigatie start.

### 5.2 Kernprincipe (🆕 NIEUW, als expliciete UX-doelstelling)

> **"Zie waar je bent. Zie waar je heen moet. Weet onmiddellijk welke kant je op moet."**

De interface moet aanvoelen als een **slimme fietsknooppunten-navigator**, niet als een traditionele auto-navigatie-app (geen turn-by-turn-straatnamen, geen ETA-in-minuten-obsessie, geen overladen interface).

### 5.3 Drie informatieniveaus (CONCRETISERING van Phase 4's bestaande scope: "huidig/volgend knooppunt, afstand, voortgang")

**Niveau 1 — Richting (grootste visuele gewicht):**
```
→ KNOOPPUNT 42
   350 m
```
Grote, ondubbelzinnige richtingaanwijzer + het eerstvolgende knooppuntnummer + afstand. Dit moet **altijd onmiddellijk zichtbaar** zijn, zonder scrollen of tikken.

**Niveau 2 — Totaalbeeld (noordgerichte kaart):**
Toont gelijktijdig: eigen positie, volledige gekozen route, huidige positie op de route, komende knooppunten, optioneel subtiel het reeds-afgelegde deel. **Noord altijd boven** (BESTAAND BESLUIT, eerdere UX-keuze, hier herbevestigd — geen kaartrotatie mee met de rijrichting).

**Niveau 3 — Voortgang:**
```
18%
6,4 km / 35,2 km
```
Rechtstreeks gevoed door `ProgressTracker`/`calculateProgress` (stap 5) — geen nieuwe berekening, alleen weergave.

### 5.4 Start Guidance (🆕 NIEUW, als benoemd UX-concept) — nu onderdeel van een drieledige fasering (CONCRETISERING, 12.1-review 29-8-2026)

Vóór de eigenlijke navigatie (niveau 1-3, sectie 5.3) doorloopt de gebruiker drie visueel verwante, maar functioneel verschillende fasen — zelfde lay-out-structuur (richtingblok/kaart/statusregel), verschillend doel en toon:

**A. Naar startpunt** — "Waar moet ik heen om te beginnen?" Actief zodra de gebruiker nog niet bij het eerste knooppunt van de gekozen route is (bijv. na de parkeerplaats-stap, sectie 5.1). Toont het startknooppuntnummer + afstand ernaartoe, met een fiets-icoon (niet de richtingpijl — dat zou verwarrend suggereren dat de navigatie al bezig is) en de tekst "Rijd naar het startpunt". Geen progressiepercentage getoond (er is nog geen route-voortgang, alleen een aanrij-afstand).

**B. Start Guidance** — "Welke kant moet ik op?" Actief zodra de gebruiker het startknooppunt bereikt heeft, vóórdat er voldoende bewegingsinformatie is om een betrouwbare voortgaande richting te bepalen (dezelfde technische aanleiding als eerder beschreven: `headingDeg` nog niet betrouwbaar bij lage snelheid). Kompas-icoon, tekst "Je staat bij het startpunt" / "Rijd deze richting op", met het eerste te volgen knooppunt + afstand.

**C. Navigatie** — de normale, doorlopende navigatie (niveau 1-3 zoals hierboven). Overgang van B naar C gebeurt automatisch zodra er een betrouwbare bewegingsrichting is (sectie 5.5) — geen aparte gebruikersactie nodig.

```
A. Naar startpunt  →  B. Start Guidance  →  C. Navigatie
   (aanrijden)          (vertrekpunt,           (onderweg,
                          nog stilstaand)         volgend knooppunt)
```

Dit onderscheid is functioneel belangrijk, niet alleen cosmetisch: het voorkomt dat een gebruiker die nog naar het startpunt onderweg is per ongeluk denkt dat de routenavigatie al begonnen is (en dus een "afwijking" zou kunnen zien terwijl hij simpelweg nog niet bij de route is).

### 5.5 GPS-koers pas betrouwbaar gebruiken bij beweging (BESTAAND BESLUIT, architectuur al zo gebouwd)

Sluit direct aan op wat de candidate matcher al doet: `headingDeg` is nullable en wordt pas meegewogen als signaal wanneer het er is; bij stilstand levert de Geolocation API vaak geen (betrouwbare) heading. Geen nieuwe logica nodig — de UI moet dit gedrag alleen visueel volgen (Start Guidance, sectie 5.4), niet zelf een aparte heading-fallback bouwen.

### 5.6 Wat hier WEL gebouwd wordt (stap 12, deze fase)

- Drieledige voorfasering: A. Naar startpunt, B. Start Guidance, C. Navigatie (sectie 5.4) — visueel verwant, functioneel onderscheiden
- Richtingscherm (niveau 1)
- Noordgerichte kaart met route + positie + komende knooppunten (niveau 2)
- Voortgangsweergave (niveau 3)
- Koppeling van al deze schermen aan de bestaande `NavigationSessionController` (géén nieuwe navigatielogica — alleen consumptie van wat er al is)
- Bevestigde toestand-weergave voor alle 11 states (in elk geval `ON_ROUTE`/`POSSIBLE_DEVIATION`/`OFF_ROUTE`/`REROUTING`/`REROUTED`/`GPS_LOST`/`PERMISSION_DENIED`/`ARRIVED` moeten zichtbaar anders aanvoelen — niet alle 11 hoeven een unieke visuele state, maar geen enkele mag onzichtbaar/verwarrend blijven)

### 5.7 Wat hier NIET gebouwd wordt (expliciet uitgesteld, geen stilzwijgende scope-uitbreiding)

- Straatnaam-niveau turn-by-turn
- Spraak/audio-instructies (design sectie 1, al uitgesloten)
- Kaartrotatie met de rijrichting (noord blijft boven, sectie 5.3)
- Offline-kaarttegels (offline-contract bestaat, implementatie niet, phase4-design sectie 15)
- Achtergrondnavigatie-garanties (sectie 3.4 — Wake Lock is het enige dat gebouwd is)
- Elk item uit sectie 4 ("Niet in Phase 4")

### 5.8 Architectuurkoppeling (BESTAAND BESLUIT: UI is een dunne laag over de bestaande engine)

```
PWA Navigatie-UI
      ↓
NavigationSessionController  (stap 9 — al gebouwd, al getest)
      ↓
Deviation / Progress / Matching  (stap 4-6 — al gebouwd, al getest)
      ↓
GPS (BrowserGeolocationSource, stap 11 — al gebouwd, al gevalideerd)
      ↕
Route Engine (POST /api/route, stap 8 — al gekoppeld)
```
De UI **consumeert** deze keten (via dezelfde soort bekabeling als de debugharness, `app/debug/navigation/page.tsx`, die als referentie-implementatie kan dienen — niet als eindproduct), maar voegt géén nieuwe navigatielogica toe. Elke berekening (matching, progress, deviation, state) blijft in `lib/navigation/`.

---

## 6. ACCEPTANCE CRITERIA VOOR STAP 12 (definitief — 29-8-2026)

Stap 12 is geslaagd wanneer:

1. De gebruiker onmiddellijk ziet waar hij heen moet.
2. Het volgende knooppunt prominent zichtbaar is.
3. De volledige route zichtbaar is.
4. De eigen positie duidelijk zichtbaar is.
5. De kaart standaard noordgericht is.
6. Progress overeenkomt met de bestaande `ProgressTracker`/`calculateProgress` — geen tweede, afwijkende berekening in de UI.
7. Start Guidance werkt vóórdat betrouwbare bewegingsrichting beschikbaar is (geen "verkeerde richting"-melding terwijl de gebruiker nog stilstaat).
8. Afwijking duidelijk maar niet alarmistisch wordt weergegeven.
9. Rerouting zichtbaar wordt verwerkt.
10. `GPS_LOST` en permission-status begrijpelijk worden weergegeven.
11. De UI geen eigen, concurrerende navigatielogica introduceert.
12. MapLibre volledig geïsoleerd blijft van de navigatie-engine (sectie 5.0).
13. De interface op iPhone/PWA goed bruikbaar is.
14. De gebruiker zonder uitleg begrijpt wat hij moet doen.

---

## 7. IMPLEMENTATIEVOLGORDE VOOR STAP 12 (definitief — 29-8-2026)

Zelfde discipline als Phase 4's engine-opbouw (stap 1-11): eerst een klein, geïsoleerd stuk bewijzen, dan uitbreiden — niet in één keer een compleet scherm bouwen. Geen productiecode vóórdat de informatiehiërarchie (12.1) akkoord is.

```
12.1  ✅ AKKOORD -- UX/wireframe, drie-fasen A/B/C (sectie 5.4)
12.2  ✅ GEVALIDEERD OP ECHTE IPHONE (29-8-2026) -- MapLibre GL JS draait betrouwbaar in
      Next.js/PWA. Publieke demo-stijl gebruikt puur als technische test (geen productiestijl).
      Noordgericht bevestigd: sleep-/pinch-rotatie uitgeschakeld, pannen/zoomen werkt.

      TWEE ECHTE VALKUILEN GEVONDEN EN OPGELOST (bewaren voor een volgende sessie, geen
      architectuurfouten, wel MapLibre v6 + Next.js/Turbopack-specifieke eigenaardigheden):
        1. `maplibre-gl` v6 is EEN PURE ESM-PACKAGE ZONDER `default`-export.
           `import maplibregl from "maplibre-gl"` faalt stil (`undefined`). Gebruik
           `import * as maplibregl from "maplibre-gl"` (of named imports zoals `{ Map }`).
        2. Turbopack (Next.js' standaardbundelaar) breekt de automatische worker-URL-
           resolutie van MapLibre v6 (tile-verwerking gebeurt in een Web Worker). Gevolg:
           de kaart *mount* (canvas/achtergrondkleur/besturing werken), maar er wordt nooit
           een tegel opgevraagd -- blijft hangen op "loading". Fix: `maplibre-gl-worker.mjs`
           EN zijn vereiste sibling `maplibre-gl-shared.mjs` in `public/` plaatsen, en vóór
           de eerste `new Map()`-aanroep één keer `maplibregl.setWorkerUrl("/maplibre-gl-
           worker.mjs")` aanroepen.
      Referentie-implementatie: `app/debug/map/page.tsx`.

12.3  ✅ GO (A-H compleet, 29-8-2026) -- opgedeeld (na review 29-8-2026), STRIKT in deze
      volgorde uitgevoerd, elke deelstap klopte vóór de volgende begon:

      12.3A  ✅ DEFINITIEF -- kaartstijl: OpenFreeMap Liberty
             (`https://tiles.openfreemap.org/styles/liberty`), niet Positron. Liberty geeft
             meer geografische context, past beter bij een fietsroute-app; Positron blijft
             een mogelijk toekomstig alternatief. Beide zijn naast elkaar getest op een echte
             iPhone (`app/debug/map-styles/page.tsx`) vóór deze keuze.
      12.3B  ✅ Route-object -> kaartgeometrie: `lib/map/route-geometry-adapter.ts`
             (`buildRouteGeoJson`). EENRICHTINGS-adapter -- hergebruikt `RouteProgressModel`
             (stap 5) voor de samengevoegde geometrie/edge-grenzen, GEEN nieuw parallel
             route-datamodel. Levert platte, lokaal getypeerde GeoJSON-achtige objecten
             (geen `@types/geojson`-afhankelijkheid nodig in de adapter zelf). Parallelle
             edges tussen dezelfde nodes worden niet gededupliceerd (expliciet getest).
      12.3C  ✅ Route getekend: donkerteal (`#085041`, dezelfde kleur als de 12.1-wireframe),
             `line-width: 5`, ronde lijnstijl.
      12.3D  ✅ Knooppunten: witte cirkel met donkerteal rand + het ECHTE knooppuntnummer
             als label (geen fictieve waarden) -- klein, niet concurrerend met de routelijn.
      12.3E  ✅ Auto-fit (`map.fitBounds(bounds, { padding: 60 })`) + bestaand 12.2-kaartgedrag
             (pannen/zoomen aan, rotatie uit, noord boven, resize/cleanup) ongewijzigd
             hergebruikt.
      12.3F  ✅ Debugpagina: `app/debug/map-route/page.tsx` -- vaste test-`Route` (3 edges,
             met een knik, om meerdere segmenten te tonen), Liberty, route + knooppunten +
             auto-fit. Geen live GPS, geen positie-marker, geen navigatiepijl, geen
             deviation/rerouting (bewust uitgesteld tot 12.4+).
      12.3G  ✅ Tests: `lib/map/route-geometry-adapter.test.ts`, 7 tests dekken exact de
             6 gevraagde scenario's (2-edge route, multi-edge volgorde, parallelle edges,
             distance-invariant onaangetast, lege/ongeldige geometrie, bounds voor auto-fit).
             244/244 tests totaal, `tsc` schoon.
      12.3H  ✅ ECHTE IPHONE-VALIDATIE GESLAAGD (29-8-2026): Liberty rustig en leesbaar,
             route springt duidelijk naar voren tegen het gedempte kleurpalet; volgorde
             12→34→56→78 in één oogopslag begrijpelijk; geen rotatie bij twee-vinger-
             draaien; pannen (één vinger) en zoomen (twee vingers) werken beide vlot;
             geen haperingen; knooppuntnummers leesbaar op elk getest zoomniveau.

      Architectuurregel bevestigd, niet geschonden: `lib/navigation/` en `lib/route-engine/`
      bevatten geen enkele MapLibre-/GeoJSON-import. Alleen `lib/map/route-geometry-adapter.ts`
      en de debugpagina's kennen MapLibre.
12.4  ✅ GO (gebouwd, getest, echte iPhone-validatie geslaagd 29-8-2026) -- Live positie
      uit de bestaande NavigationSession getoond op de kaart.

      KERNARCHITECTUUR, bewaakt en getest: `GPS → matching → navigation state →
      kaartmarker`, NOOIT `GPS → kaartmarker`. De marker wordt uitsluitend bijgewerkt
      vanuit een geaccepteerde `DeviationOutcome` (`reported_on_route`/
      `reported_deviation`) van `DeviationDetector` -- die zelf alleen zo'n uitkomst
      geeft ná een succesvolle `NavigationStateMachine`-transitie. Er is geen enkel pad
      waarin een ruwe `GpsSample` rechtstreeks de marker beweegt.

      `lib/map/position-marker-adapter.ts` (`buildPositionMarkerGeoJson`) -- zelfde
      eenrichtings-adapterprincipe als `route-geometry-adapter.ts` (stap 12.3B): accepteert
      uitsluitend een `MatchedPosition` (het resultaat van matching, nooit een ruwe sample),
      puur, geen state. 5 tests, incl. een expliciete borging dat de functiesignature geen
      los lat/lon-pad toestaat.

      `app/debug/map-live/page.tsx`: route uit stap 12.3 hergebruikt (identieke testroute,
      geen nieuwe geometrie), live positiemarker (solide teal vulling + witte rand --
      bewust anders dan de witte-vulling/teal-rand-knooppunten en de teal routelijn, nog
      GEEN richtingpijl, die hoort bij stap 12.5). `NavigationSessionController` blijft
      volledige eigenaar van de navigatiestatus; de kaartlaag leest er alleen van.

      ECHTE IPHONE-VALIDATIE (29-8-2026): marker verscheen zichtbaar en correct op de
      route (geprojecteerd via de matcher op het dichtstbijzijnde punt, aangezien de
      gebruiker fysiek ~45km van de testroute stond), `nav state` klopte met de log,
      meerdere snelle GPS-updates bij opstarten allemaal correct verwerkt.

      BEWUST BEHOUDEN BEPERKING, geen bug: de testroute (stap 12.3's handmatige fixture,
      drie rechte lijnstukken) volgt geen echte straten/fietspaden -- dat is een kenmerk
      van de fixture (toegestaan voor "een pure visuele fixture/test", ontwerpregel
      sectie 4), geen vervanging van een echte, door de Route Engine berekende `Route`.
      Straatvolgende routegeometrie komt met een echte `Route` (via `POST /api/route`),
      uiterlijk bij stap 12.7 (integratie in de bestaande Phase 3-flow) -- niet eerder
      stilzwijgend aangenomen als al opgelost.

      249/249 tests totaal, `tsc` schoon. `lib/navigation/`/`lib/route-engine/` bevatten
      nog steeds geen MapLibre-import.
12.5  ✅ TECHNISCH GO (29-8-2026) -- Richtings- en knooppuntlaag -- volgend knooppunt +
      afstand + grote richtingindicator (niveau 1).

      ENGINE-LAAG (klein, geïsoleerd gat gedicht, geen nieuwe navigatielogica): het
      oorspronkelijke Phase 4-ontwerp (sectie 6/7) beschreef "huidig/volgend knooppunt"
      en "afstand tot volgend knooppunt" al als onderdeel van het contract, maar dit was
      bij stap 5 nooit als eigen functie geïmplementeerd. Nu toegevoegd aan
      `lib/navigation/progress/route-progress-model.ts`:
        - `getNodeSegmentIndex(model, nodeIndex)` -- gedeelde helper, ook `route-geometry-
          adapter.ts` (stap 12.3B) hergebruikt deze nu (refactor, geen dubbele logica meer).
        - `calculateNextNodeInfo(model, progress, matchedPosition, nodeIds)` -- huidig/
          volgend knooppunt-ID, `distanceToNextNodeM` (ECHTE edge.distanceM-gebaseerde
          afstand, niet de rauwe geometrieafstand), `bearingToNextNodeDeg` (hergebruikt
          `bearingDegrees` uit stap 4, geen nieuwe geometrieberekening).
      `bearingToNextNodeDeg` is een ABSOLUTE richting (0°=noord) -- nog GEEN correctie voor
      bewegingsrichting/heading (de "overgang van kompas naar bewegingsrichting" hoort
      bij stap 12.7, Start Guidance, bewust hier niet vooruitgelopen).

      UI-LAAG: `app/debug/map-live/page.tsx` uitgebreid met de niveau-1-kaart uit de
      12.1-wireframe (donkerteal kaart, pijl geroteerd op `bearingToNextNodeDeg`,
      knooppuntnummer, afstand in meters) -- gevoed door dezelfde `matchedPosition` die
      ook de kaartmarker al bijwerkt (stap 12.4), geen tweede databron.

      257/257 tests totaal (8 nieuw: `getNodeSegmentIndex`/`calculateNextNodeInfo`),
      `tsc` schoon. `lib/navigation/`/`lib/route-engine/` bevatten nog steeds geen
      MapLibre-import.

      BEKEND TESTFIXTURE-RANDGEVAL (geen productgedrag, geen bug -- 29-8-2026): bij een
      echte-iPhone-check op ~45km van de testroute toonde de richtingkaart "0 m" met een
      rechtdoor-wijzende pijl. Verklaring: de matcher projecteert een zeer verre positie
      op het dichtstbijzijnde punt van de HELE route -- in dat specifieke geval bleek dat
      exact knooppunt 78 (het laatste routepunt) te zijn, dus `distanceToNextNodeM` = 0 en
      een bearing tussen twee identieke punten valt terug op 0°. Dit is correct gedrag
      gegeven de invoer, geen fout in `calculateNextNodeInfo`/de richtingpijl.

      BEWUSTE KEUZE (na review, 29-8-2026): de realistische links/rechts/rechtdoor-
      validatie van de richtingpijl (een positie dichtbij de route, niet toevallig exact
      op een knooppunt) wordt NIET nu los getest. In plaats daarvan: gebundeld in ÉÉN
      uitgebreide iPhone-eindvalidatie zodra de volledige keten (t/m stap 12.7) staat --
      zie de eindvalidatie-checklist onderaan sectie 7. Dit voorkomt herhaaldelijk
      losstaand straattesten van halfafgebouwde functionaliteit; de 257 geautomatiseerde
      tests + de simulator blijven de onderliggende logica intussen dekken.
12.6  ✅ GEBOUWD (29-8-2026, echte iPhone-validatie gebundeld bij de eindvalidatie na
      12.7 -- zie de checklist hierboven) -- Progress/state-UI -- progress, ON_ROUTE,
      afwijking, GPS_LOST, rerouting, arrival zichtbaar maken zonder de interface te
      overladen.

      GEEN nieuwe engine-logica -- uitsluitend weergave van wat al bestond
      (`calculateProgress`, stap 5; `NavigationState`, stap 2). Toegevoegd aan
      `app/debug/map-live/page.tsx`:
        - Statusbadge (niveau boven de kaart): korte, NIET-alarmistische labels per
          `NavigationState` (bijv. "Mogelijk afgeweken" i.p.v. een waarschuwingstoon voor
          `POSSIBLE_DEVIATION`; "Van route af" pas bij `OFF_ROUTE`) -- ontwerpregel
          sectie 13: afwijking duidelijk maar niet alarmistisch.
        - Progress-balk (niveau 3, uit de 12.1-wireframe): km/km + percentage, rechtstreeks
          gevoed door `calculateProgress`'s `distanceAlongRouteM`/`totalDistanceM`/
          `progressRatio` -- geen tweede, eigen berekening in de UI-laag.

      257/257 tests ongewijzigd (geen nieuwe engine-code, dus geen nieuwe tests nodig),
      `tsc` schoon.
12.7  ✅ GEBOUWD (29-8-2026, echte iPhone-validatie gebundeld bij de eindvalidatie --
      zie de checklist hierboven) -- Start Guidance + polish -- volledige integratie
      van de drieledige fasering (sectie 5.4), daarna visuele polish.

      NIEUWE, KLEINE ENGINE-COMPONENT (bewust apart getest, geen if/else-logica in de
      UI-laag): `lib/navigation/session/pre-navigation-phase.ts`
      (`determinePreNavigationPhase`) -- pure functie, 10 tests. Bepaalt welke van de
      drie fasen getoond moet worden:
        - A. TO_START: sessie nog niet gestart, gebruiker buiten de aankomstdrempel
          (`ARRIVAL_AT_START_THRESHOLD_M`, uitgangspunt 25m) van het startknooppunt.
        - B. START_GUIDANCE: binnen de aankomstdrempel maar sessie nog niet gestart, ÓF
          sessie gestart maar nog geen betrouwbare bewegingsrichting (`speedMps` null of
          onder `MOVEMENT_SPEED_THRESHOLD_MPS`, uitgangspunt 0,5 m/s) -- ontwerpregel
          sectie 5.5: GPS-heading pas betrouwbaar bij beweging.
        - C. NAVIGATING: sessie gestart, bevestigd `ON_ROUTE`, én voldoende snelheid.
      Beide drempelwaarden zijn UITGANGSPUNTEN, net als de overige kalibratiewaarden
      (sectie 3.7) nog niet definitief vastgezet.

      INTEGRATIE in `app/debug/map-live/page.tsx`: `NavigationStateMachine.start()`
      wordt nu pas aangeroepen zodra fase A voorbij is (niet meer bij de eerste GPS-fix
      onvoorwaardelijk, zoals in stap 11's harness) -- tijdens fase A wordt alleen de
      afstand tot het startknooppunt getoond (via `distanceBetween`/`wgs84ToRd`, stap 4,
      geen nieuwe geometrieberekening), geen matching, geen actieve navigatiesessie. De
      niveau-1-kaart (stap 12.5) toont nu drie visuele varianten: 🚲 "Rijd naar het
      startpunt" (A), 🧭 "Rijd deze richting op" met "Je staat bij het startpunt"-caption
      (B), en de bestaande pijl (C, ongewijzigd uit stap 12.5).

      POLISH: zachte overgang (`transition: opacity`) op de richtingkaart, consistente
      afronding/padding, fase zichtbaar in het debugpaneel voor testdoeleinden.

      267/267 tests totaal (10 nieuw), `tsc` schoon. `lib/navigation/`/`lib/route-engine/`
      bevatten nog steeds geen MapLibre-import.

      Hiermee is de volledige UI-ketting (12.1-12.7) gebouwd en met de simulator/
      geautomatiseerde tests gedekt. De laatste stap is de ÉÉN gebundelde iPhone-
      eindvalidatie (zie checklist hierboven), niet nog een losse deelstap-test.
```

Ná 12.1-12.7 zelfstandig bewezen: integratie in de bestaande Phase 3-flow (na routekeuze, een "Start navigatie"-knop die hierheen leidt) en validatie met echte iPhone-GPS (`BrowserGeolocationSource`, al gebouwd en gevalideerd in stap 11).

**Dataketen-fix vóór de Start-knop (29-8-2026), afgerond:** bij het inspecteren van de echte `app/page.tsx` bleek `selectedLoop.route` (de state ná routekeuze) alleen `edges: string[]` (ID's) te bevatten, geen volledige `GraphEdge[]`-objecten. De navigatie-engine (`buildRouteProgressModel`, en alles wat daarop bouwt) heeft juist die volledige objecten nodig (`edge.distanceM`, `edge.geometry` per edge) -- reconstructie vanuit de platte, samengevoegde `Route.geometry` zou een tweede, fragiel datamodel zijn (ontwerpregel: "GraphEdge blijft leidend", geen nieuw parallel model).

**Oplossing, additief, geen breaking change:**
- `lib/route-engine/resolve-route-edges.ts` (`resolveRouteEdges`) -- vertaalt `Route.edges[]`
  terug naar volledige `GraphEdge[]`, uitsluitend via de bestaande
  `GraphProvider.getEdgesFrom()` (geen nieuwe providermethode). Steunt op de garantie dat
  `Route.nodes[i]`/`Route.edges[i]` 1-op-1 corresponderen (Phase 2-ontwerp sectie 6), filtert
  ondubbelzinnig op edge-`id` (correct ook bij parallelle edges tussen dezelfde nodes).
  Gooit een duidelijke fout bij een niet-resolveerbare edge, geen stil gat.
- `LoopCandidate` (`lib/route-engine/loop-route-generator.ts`) uitgebreid met een NIEUW,
  verplicht veld `resolvedEdges: GraphEdge[]` -- alle bestaande velden
  (`route`/`nodes`/`edges`/`geometry`/`distanceM`) ONGEWIJZIGD. Alleen berekend voor de
  daadwerkelijk geaccepteerde/teruggegeven kandidaten (niet voor afgewezen duplicaten --
  geen verspilde `GraphProvider`-lookups).
- `app/api/route/loop/route.ts` zelf hoefde NIET aangepast te worden -- die geeft `result`
  ongewijzigd door aan `NextResponse.json()`, dus `resolvedEdges` stroomt automatisch mee.
  Bestaande routeselectie (Phase 3, `app/page.tsx`) blijft ongewijzigd werken.
- `Route.datasetVersionId` was al aanwezig op het bestaande `Route`-type (Phase 2) --
  geen wijziging nodig om dit beschikbaar te houden voor de `NavigationSession`.

**Geverifieerd, niet alleen aangenomen:** een integratietest draait de ECHTE
`generateLoopRoutes()` tegen een 3x3-rastergraaf-fixture, voert `loop.resolvedEdges`
rechtstreeks in `buildRouteProgressModel()` (Navigation Engine, stap 5), en bevestigt dat
`model.totalDistanceM` exact overeenkomt met `loop.route.distanceM` -- de distance-invariant
blijft intact over de grens Route Engine ↔ Navigation Engine heen. 273/273 tests totaal
(6 nieuw), `tsc` schoon.

**Nog te doen:** de "Start"-knop in `app/page.tsx` (die nu alleen `navigationStarted=true`
zet en een placeholder-tekst toont) daadwerkelijk koppelen aan de nieuwe navigatie-UI,
gevoed door `selectedLoop.resolvedEdges` in plaats van de testfixture uit `/debug/map-live`.

**Start-knop-koppeling (29-8-2026), afgerond -- minimale ingreep, geen nieuwe route-
architectuur (bewust gecontroleerd: eerst `app/page.tsx` bekeken, dan pas gewijzigd):**

- `components/navigation/NavigationScreen.tsx` -- de volledige navigatielogica uit stap
  12.4-12.7 (kaart, marker, richting, progress, fase A/B/C) omgevormd tot een herbruikbaar
  React-component met props (`edges`, `nodeIds`, `datasetVersionId`, `onExit`) in plaats van
  de hardcoded testfixture. `app/debug/map-live/page.tsx` is nu een dunne wrapper om
  ditzelfde component (met de testfixture als props) -- GEEN dubbele navigatielogica meer
  tussen debugharness en productieflow.
- `app/page.tsx`: minimale, additieve wijziging. `Step`-type uitgebreid met `"navigating"`
  (de bestaande state-machine-aanpak van de pagina hergebruikt, geen nieuwe architectuur).
  De placeholder-tekst na "Start" vervangen door een echte transitie naar
  `step === "navigating"`, die `<NavigationScreen>` rendert met de daadwerkelijk gekozen
  route (`selectedLoop.resolvedEdges`/`selectedLoop.route.nodes`/
  `selectedLoop.route.datasetVersionId`). Bestaande stappen (location/distance/results/
  detail) ONGEWIJZIGD.
- Lokale `Route`/`LoopCandidate`-types in `app/page.tsx` additief uitgebreid met
  `datasetVersionId`/`resolvedEdges` -- precies de velden die de dataketen-fix (hierboven)
  al server-side leverde.
- Layoutfix, zelf gevonden tijdens het bouwen: `NavigationScreen`'s wrapper stond op
  `position: relative`, wat prima werkte op de losstaande debugpagina maar binnen
  `app/page.tsx`'s bestaande `<main>`-layout (header, padding, `maxWidth: 480`) tot een
  ingesnoerd, verkeerd gepositioneerd scherm zou leiden. Gewijzigd naar
  `position: fixed; inset: 0; z-index: 50` zodat het scherm altijd het volledige
  viewport overneemt, ongeacht waar het in de DOM gemount wordt.
- ✕-knop toegevoegd (alleen zichtbaar als `onExit` is meegegeven, dus niet op de
  debugpagina) om terug te gaan naar de route-detailweergave.

**Bewust NOG NIET gebouwd:** een live `POST /api/route`-aanroep bij een daadwerkelijke
reroute (`RerouteExecutor`/`performReroute` bestaan al in `lib/navigation/reroute/`, maar
zijn nog niet vanuit `NavigationScreen` aangesloten) -- dat blijft voor een latere stap,
niet stilzwijgend meegenomen in deze knop-koppeling.

**Resultaat:** `tsc --noEmit` schoon (tegen de ECHTE `app/page.tsx`, niet een kopie),
**273/273 tests slagen** (ongewijzigd -- deze stap is UI-integratie, geen nieuwe
engine-logica). De uiteindelijke flow: Routeplanner → Route detail → START → Naar
startpunt → Start Guidance → Navigatie.

**Eindvalidatie-checklist (na 12.7, één gebundelde echte iPhone-sessie, geen losse straattests per deelstap meer):**

```
GPS → matching → progress → deviation → reroute → kaart → richting → knooppunt
    → Start Guidance → navigatie
```

Status per onderdeel (bijgewerkt 29-8-2026):
- ✅ **Fase A ("naar startpunt")** — bevestigd op echte iPhone (`/debug/map-live`,
  46.029m tot testknooppunt 12 correct getoond, `nav state: NOT_STARTED`, geen matching
  vóór de aankomstdrempel). Geen kunstmatige lokale testroute nodig geweest.
- ⏳ **Fase B (Start Guidance)** — bewaard voor de echte lokale testrit (vereist een
  positie binnen de aankomstdrempel van een echt startknooppunt; niet zinvol te forceren
  met de Utrecht-testfixture vanaf een andere locatie).
- ⏳ **Fase C (navigatie) + de A→B→C-overgang als geheel** — idem, bewaard voor dezelfde rit.
- ⏳ **Realistische links/rechts/rechtdoor-richtingpijl** (bewaard vanuit stap 12.5).
- ⏳ **Reroute, GPS_LOST-herstel, Wake Lock** onder echte, gecombineerde belasting.

**Besluit (na review, 29-8-2026):** geen kunstmatige testroute meer bouwen om B/C/de rest
apart te forceren. De 267 geautomatiseerde tests + de bevestigde fase-A-iPhone-test geven
voldoende vertrouwen om door te bouwen naar de volgende integratiestap (Phase 3-flow-
koppeling). Bovenstaande openstaande punten worden in ÉÉN echte lokale testrit gevalideerd
zodra die integratie staat -- niet eerder, en niet met een kunstmatige locatie geforceerd.
