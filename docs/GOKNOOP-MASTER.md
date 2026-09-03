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
Phase 4   — Navigation UI                ⬜ stap 12 — logpaneel-bug gefixt ✅; route-naar-startpunt ✅; BACKLOG 8B+8C GEBOUWD: aankomst-stabiliteitslaag (achterwaarts compatibel) ✅, slimmere start-node-score (afstand+beschikbaarheid+kwaliteit, vervangt simpele fallback in /api/route/loop) ✅; 345/345 tests, tsc schoon
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

### 5.9 Visuele noordster + groep-1 UI-polish (🆕 NIEUW als referentiebeeld, 29-8-2026)

Een visuele mockup ("Overzichtelijk. Rustig. Duidelijk.") is vastgelegd als **richting, niet als letterlijke bouwopdracht** — de bestaande architectuur blijft leidend, bestaande functies worden naar dat kwaliteitsniveau gebracht.

**Expliciet uit de mockup NIET meegenomen (aparte, latere beslissing, niet stilzwijgend):**
- Gebogen afslagpijl (links/rechts/rechtdoor) — vereist een andere richtingsberekening dan de huidige absolute kompasrichting; bewust uitgesteld
- Verwachte aankomsttijd (ETA) — `Route.durationEstimate` blijft `null` tot er een degelijk snelheidsmodel is
- Offline kaarten downloaden — aparte technische fase, al eerder uitgesloten (sectie 5.7)
- Nieuwe onderste tabbalk (Overzicht/Route/Navigatie/Profiel) — raakt de hele app-navigatiestructuur, niet alleen dit scherm
- Foto's in route-detail, donut-voortgangsring — geen prioriteit boven de kerninformatie

**Leidend ontwerpprincipe (herbevestigd):** binnen één seconde antwoord op *waar ben ik / waar moet ik heen / hoe ver nog* — kaart = totaalbeeld, grote richting = direct antwoord, voortgang = context.

**Groep 1 — UI-polish binnen bestaande architectuur, gebouwd 29-8-2026 (`components/navigation/NavigationScreen.tsx`), géén nieuwe navigatielogica:**
- **Navigatie-header**: horizontale layout (witte knooppunt-badge + grote afstand + pijl-icoon in één rij, i.p.v. verticaal gestapeld), meer witruimte, `#085041`.
- **Kaart**: knooppunt-cirkels iets groter/duidelijker (radius 9→10, tekst 11→12px bold); **positiemarker van teal naar subtiel blauw** (`#3B82F6`) omdat dat de gangbare "hier ben je"-kleur is en teal daardoor exclusief voor de route/knooppunten blijft — de ROUTE zelf blijft teal, dus dit maakt de kaart niet alsnog Google Maps-achtig.
- **Richting**: unicode-pijl (`↑`) vervangen door een echt SVG-pijlicoon, nog steeds geroteerd op dezelfde `bearingToNextNodeDeg` (stap 12.5, ongewijzigde berekening) — puur visuele vervanging, geen nieuwe richtinglogica.
- **Voortgang**: statistiekenrij (Tot. afstand / Resterend / Voltooid%) boven een rustigere, dunnere balk — bewust **geen** derde ETA-kolom.
- **Startfasen**: bestaande A/B/C (sectie 5.4) visueel meegenomen in dezelfde stijlvernieuwing (badge-vormtaal, witruimte), geen gedragswijziging.

**Nog te doen:** echte iPhone-validatie van deze polish-pass (nog niet uitgevoerd op het moment van schrijven).

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

## 6B. STARTKNOOPPUNT-FALLBACK (Volendam-onderzoek, 29-8-2026, afgerond)

**Het probleem:** in Volendam (Bootslot 25) gaf "Mijn locatie" op élke afstand (20-50km) "Geen routes gevonden", terwijl het netwerk daar op zich niet slecht is. Diagnose via een nieuwe debugpagina (`/debug/location-candidates`, roept uitsluitend bestaande endpoints aan, géén wijziging aan productielogica) bevestigde de oorzaak:

| # | Knooppunt | Afstand | edgeCount | Routes (20km) |
|---|---|---|---|---|
| 1 (destijds gekozen) | 96 | 538m | 9 | **0/4** |
| 2 | 97 | 1055m | 3 | 4/4 |
| 3 | 95 | 1346m | 2 | 4/4 |
| 4 | 99 | 1415m | 1 | 0/4 |
| 5 | 98 | 1426m | 6 | 0/4 |

Knooppunt 96 heeft 9 edges (niet geïsoleerd) maar is een **chokepoint**: `outboundFailed: 2, inboundFailed: 13` van de 15 kandidaat-waypoints — bijna elke heenroute gebruikt de enige praktische doorgang, waardoor een terugweg die dat stuk vermijdt (vereist om een écht rondje te zijn, geen heen-en-terug) vrijwel altijd onmogelijk is. Waarschijnlijk een dijk/brug-achtige situatie. Dit is **geen bug** in de rondje-generator (de "vermijd de heenweg"-regel is bewust) en **geen bug** in de node-resolutie (96 is niet geïsoleerd, `resolveNearestNodes()` werkte correct) — een echt kenmerk van de lokale netwerktopologie.

**Architectuurbeslissing:** de gebruiker vraagt niet om "een route vanaf mijn dichtstbijzijnste knooppunt", maar om "een bruikbare route vanaf mijn locatie". Welke kandidaat daarvoor het beste startknooppunt is, is een **Route Engine-verantwoordelijkheid**, geen UI-beslissing — `app/page.tsx` bevat daarom geen fallback-logica.

**Gebouwd, additief, geen breaking change:**
- `generateLoopRoutesWithFallback()` (`lib/route-engine/loop-route-generator.ts`) — probeert kandidaten STRIKT in de meegegeven (afstands)volgorde, stopt bij de eerste die minstens 1 bruikbare route oplevert. Bewust: "kandidaat 1 heeft geen routes" ≠ "neem zomaar kandidaat 2" — het enige criterium is `foundCount === 0`, geen aanname over de oorzaak. Nog geen kwaliteitsscore (afstand+beschikbaarheid+kwaliteit) — expliciet uitgesteld tot na deze eerste, geteste versie.
- **Test bewijst het exacte Volendam-patroon**: een fixture met een knooppunt dat wél edges heeft maar GEGARANDEERD geen bruikbare terugweg (een enkele edge naar de rest van het netwerk — elke heenweg gebruikt 'm, dus elke terugweg die 'm moet vermijden faalt per definitie) bevestigt dat de fallback correct van kandidaat 1 naar kandidaat 2 springt, en transparant rapporteert welke gebruikt is. 5 nieuwe tests, 278 in totaal, `tsc` schoon.
- `POST /api/route/loop` accepteert nu additief `candidateNodeIds`/`candidateDistancesM` (naast het bestaande `startLogicalNodeId`, dat blijft werken als vóór deze wijziging). Respons bevat bij succes `selectedStartNodeId`/`selectedStartNodeDisplayNumber`/`selectedStartNodeDistanceM`/`selectedCandidateRank`; bij falen van ALLE kandidaten een 404 met `reason: "no_usable_candidate"` en per-kandidaat `attempts`.
- `app/page.tsx`: bewaart nu de volledige kandidatenlijst (niet alleen `candidates[0]`), stuurt die door naar `/api/route/loop`. **Eerlijke UI, geen verborgen sprong**: als het daadwerkelijk gebruikte startknooppunt afwijkt van de dichtstbijzijnde kandidaat, toont het resultatenscherm expliciet "Beste startpunt gevonden — 📍 Knooppunt X — Y km van je locatie" plus een regel dat het dichterbij gelegen knooppunt geen bruikbare route opleverde. Knooppunt-badges/labels op de resultatenlijst en het detailscherm gebruiken nu `loop.nodeDisplayNumbers[0]` (het daadwerkelijke, per-route startknooppunt) i.p.v. het oorspronkelijke, mogelijk-ongebruikte kandidaat-1-label.

**Bewust nog niet gebouwd:** een start-node-score die afstand+routebeschikbaarheid+routekwaliteit combineert — eerst deze 1→5-fallback in de praktijk laten bewijzen (Volendam + Edam + een normale situatie waar kandidaat 1 al werkt), pas daarna eventueel verfijnen.

---

## 6C. HEADING-UP NAVIGATIE (🆕 NIEUW, spec ontvangen 29-8-2026 — stap 1 gebouwd, rest bewust uitgesteld)

**Kernprincipe (vervangt "noord altijd boven" tijdens actieve navigatie):** de kaart/richtingindicator draait mee met de rijrichting van de fietser, niet met noord. Het volgende knooppunt wordt getoond ten opzichte van waar de fietser nú heen kijkt (rechtdoor/links/rechts/achteruit), niet als een absolute kompasrichting. Dit vervangt het eerder in sectie 5.9 genoemde "gebogen afslagpijl" — het is dezelfde onderliggende behoefte, nu volledig uitgespecificeerd.

**Belangrijk, expliciet: dit wijzigt het "noord boven"-principe uit sectie 5.3/10 alleen voor de ACTIEVE navigatiefase.** De kaart tijdens routeplanning/-overzicht (vóór "Start") blijft noordgericht — heading-up is specifiek een eigenschap van de navigatiemodus.

**Gebouwd (29-8-2026), stap 1 van de spec's eigen aanbevolen volgorde — uitsluitend pure, apart geteste functies, GEEN kaartrotatie, GEEN UI-wijziging:**

`lib/navigation/direction/relative-direction.ts` (26 tests, `tsc` schoon, 304 totaal):
- `normalizeAngleDeg`/`relativeAngleDeg` — hergebruikt de bestaande `bearingDegrees` (stap 4) voor de absolute bearing; dit bestand maakt 'm alleen relatief t.o.v. de rijrichting.
- `classifyDirection` — RECHTDOOR/LICHT_LINKS/LINKS/LICHT_RECHTS/RECHTS/ACHTERUIT, drempels expliciet injecteerbaar (nog niet definitief, zelfde discipline als sectie 3.7).
- `smoothHeadingDeg` — circulaire exponentiële smoothing (doorkruist de 0°/360°-grens via de kortste weg), voorkomt nerveuze rotatie (AC7).
- `selectHeadingDeg` — GPS-bewegingsrichting tijdens voldoende snelheid, anders de laatst bekende stabiele richting vasthouden (AC8). Bewust GEEN device-kompas/magnetometer aangesloten — aparte sensor/toestemming, niet stilzwijgend toegevoegd.
- `hasArrivedAtNode` — simpele afstandscheck; de "niet te vroeg springen"-stabiliteitslaag (spec sectie 13, vergelijkbare hysterese als deviation detection stap 6) is BEWUST nog niet gebouwd.

**Nog niet gebouwd, bewust uitgesteld:**
- Kaartrotatie zelf (MapLibre `setBearing`/continue rotatie-aansturing)
- Wiring van deze functies in `NavigationScreen.tsx`
- Aankomst-stabiliteitslaag (hysterese, voorkomt vroegtijdig wisselen van knooppunt)
- Simulatie- en daarna echte-fietstests (spec sectie 26, stappen 11-12)

**Reden voor de pauze na stap 1:** er lagen op het moment van deze spec drie **nog onopgeloste diagnosevragen** over hetzelfde scherm (dubbele/parallelle lijnen bij een knooppunt-paar, ontbrekende knooppunt-badges bij een Edam-test, en een verdachte kaarsrechte lijn die geen weg volgt) — bouwen op een mogelijk nog niet volledig kloppend kaartbeeld zou de resultaten van heading-up-tests onbetrouwbaar maken. Deze moeten eerst opgehelderd worden (zie sectie 6D) vóór stap 2+ van heading-up (kaartrotatie/UI) begint.

---

## 6D. OPENSTAANDE DIAGNOSE (29-8-2026) — punt 3 OPGELOST, echte engine-bug gevonden

1. **Dubbele/parallelle lijnen** tussen knooppunt 10 en 64 (Volendam-lus): nog steeds de werkhypothese dat dit twee daadwerkelijk verschillende edges tussen dezelfde knooppunten zijn (bijv. beide kanten van een kanaal/dijk, samenhangend met de "vermijd de heenweg-edges bij de terugweg"-regel, sectie 6B) — niet met zekerheid uitgesloten dat de hieronder beschreven richtingsbug hier ook aan bijdroeg; opnieuw te beoordelen ná de fix.
2. **Ontbrekende knooppunt-badges bij Edam** — bleek een test-menselijke fout: de gestuurde screenshot was per ongeluk de eerder gepande/ingezoomde Volendam-kaart, niet een verse Edam-zoekopdracht (de app "onthoudt" de laatst geladen route totdat er een nieuwe zoekopdracht gedaan wordt — geen bug, wel een makkelijk te maken testfout). Nog te herhalen met een echte, verse Edam-zoekopdracht.
3. **✅ OPGELOST: de kaarsrechte lijn.** Bevestigd met een nieuwe `/debug/route-geometry-inspector`-pagina (roept alleen bestaande endpoints aan, geen serverwijziging): ALLE edges in de Naarden-route bleken dichte, realistische geometrie te hebben (19-39m tussen punten) — dus GEEN brondata-kwaliteitsprobleem. De echte oorzaak: `buildRouteProgressModel()` (stap 5) miste de richtingscorrectie die `route-builder.ts` (Phase 2, al langer correct) wél had. Een edge is bidirectioneel doorloopbaar, maar de brongeometrie ligt vast in één richting (`fromLogicalNodeId → toLogicalNodeId`); als de route 'm omgekeerd doorloopt, moet de coördinatenreeks omgekeerd worden. Zonder die correctie "sprong" de samengevoegde lijn naar het verkeerde uiteinde van zo'n edge — precies het waargenomen patroon. **Dit trof niet alleen de kaartweergave maar ook matching/progress/richting**, die allemaal op dezelfde `model.geometry` draaien.

   **Fix:** `buildRouteProgressModel(edges, nodeSequence)` — `nodeSequence` (nieuw, verplicht parameter) toegevoegd, exact dezelfde, al bewezen richtingslogica hergebruikt als `route-builder.ts`'s `concatenateGeometry()` (geen nieuwe, afwijkende implementatie). Bijkomend: `NavigationScreen`'s `nodeIds`-prop bleek zelf ook een tweede, gerelateerd probleem te verbergen — die werd zowel voor de ECHTE interne knooppunt-ID's (nodig voor deze richtingscorrectie) als voor mensleesbare weergavenummers gebruikt. Nu netjes gesplitst in twee aparte props: `nodeSequence` (echte ID's, structureel) en `nodeDisplayNumbers` (weergave, cosmetisch) — dezelfde soort verwarring als de eerdere "9CHmIH3BmYvDp7wmARBq i.p.v. 96"-bug, nu definitief voorkomen door het onderscheid expliciet in het type-systeem vast te leggen.

   Een nieuwe test bewijst de fix direct: een edge die in de brondata omgekeerd is opgeslagen t.o.v. de routevolgorde, levert nu de juiste (niet-springende) samengevoegde geometrie op. **306/306 tests, `tsc` schoon.**

---

## 6E. LIVE-LOCATIEKAART (🆕 NIEUW, 29-8-2026)

Op verzoek: de bestaande "Mijn locatie"-knop (locatiestap, `app/page.tsx`) leidt niet meer direct naar de afstandskeuze, maar eerst naar een nieuwe bevestigingsstap: een live MapLibre/Liberty-kaart met de actuele GPS-positie (blauwe stip + rustige "gloed", zelfde blauw als de live-positiemarker op het navigatiescherm) en rijrichting (kompasletter + graden, bijv. "NW · 315°"), met een "Gebruik deze locatie"-knop om door te gaan.

**Bewust géén route, géén matching, géén NavigationSession** — er is op dit punt nog geen route gekozen, dus de volledige navigatie-engine is hier niet van toepassing. Puur "waar ben ik nu", vergelijkbaar met hoe een kaart-app een blauwe stip toont.

**Hergebruik, geen nieuwe infrastructuur:**
- Dezelfde worker-URL-fix, dezelfde Liberty-stijl-URL, dezelfde `BrowserGeolocationSource` (stap 11) als het navigatiescherm.
- `compassAbbreviation()` (nieuw, `lib/navigation/direction/relative-direction.ts`, 5 tests) — Nederlandse 8-punts kompas-afkorting (N/NO/O/ZO/Z/ZW/W/NW), puur weergaveformattering.

**Component:** `components/location/LiveLocationScreen.tsx` — nieuwe `Step`-waarde `"confirmLocation"` in `app/page.tsx` (zelfde bestaande state-machine-aanpak als eerder bij `"navigating"`, geen nieuwe architectuur). De oude, directe `resolveByGps()` (riep zelf `getCurrentPosition` aan en resolvede meteen) is opgesplitst in `showLocationConfirmation()` (navigeert naar de nieuwe stap) en `resolveFromConfirmedCoords(lat, lon)` (de eigenlijke `/api/location/resolve`-aanroep, nu gevoed door de bevestigde coördinaten uit het live scherm in plaats van een eenmalige `getCurrentPosition`-call).

**Bewust NIET meegenomen (expliciete keuze, niet vergeten):** de onderste tabbalk (Kaart/Zoeken/Mijn routes/Profiel) uit de bijbehorende mockup. Die blijft een aparte, latere beslissing (raakt de hele app-navigatiestructuur) — de gebruiker gaf aan dat dit ook later kan.

**310/310 tests, `tsc` schoon.** Nog geen echte iPhone-validatie van dit specifieke scherm.

---

## 6F. APP-STRUCTUUR HERONTWERP: TABBALK + HOME=KAART (🆕 NIEUW, 29-8-2026)

**Bewust een eerdere beslissing teruggedraaid, niet stilzwijgend.** Sectie 6E/5.9 hield de onderste tabbalk expliciet buiten scope ("raakt de hele app-navigatiestructuur... latere beslissing"). Op uitdrukkelijk verzoek (29-8-2026) is dat nu bewust wél gedaan.

**Fase 1 (gebouwd, 29-8-2026): tabbalk + Home=kaart, geen knoppenlijst meer.**
- `components/layout/TabBar.tsx` — vier tabs: Kaart/Zoeken/Mijn routes/Profiel.
- `app/page.tsx` grondig herstructureerd: `step` is nu `Step | null` (`null` = geen actieve flow, toon de tabbladen; niet-`null` = bestaande stap-gebaseerde flow, tabbalk verborgen). De oude `"location"`/`"confirmLocation"`-stappen zijn VERVALLEN -- de Kaart-tab IS nu permanent het live-locatiebevestigingsscherm (geen aparte stap meer nodig).
  - **Kaart-tab**: `<LiveLocationScreen embedded onConfirm={...} />` -- geen "Mijn locatie"-knop meer, de kaart zelf is de home.
  - **Zoeken-tab**: de bestaande plaatsnaam-zoekfunctie, ongewijzigde logica, alleen verplaatst van de oude homepage naar deze tab.
  - **Mijn routes-tab**: lege-staat-placeholder ("Je hebt nog geen routes opgeslagen") -- de daadwerkelijke opslag komt in fase 3.
  - **Profiel-tab**: placeholder, zoals afgesproken.
- `LiveLocationScreen` uitgebreid met een `embedded`-modus (`position: absolute` i.p.v. `fixed`, ruimte voor de tabbalk) en een optionele `onCancel` (geen ✕-terugknop nodig als hometab, wél als losse bevestigingsstap elders).
- 310/310 tests ongewijzigd (pure UI-herstructurering, geen engine-wijziging). Nog geen echte iPhone-validatie.

**Geplande vervolgfasen (nog NIET gebouwd, bewuste volgorde):**

**Fase 2 — Gereden routes automatisch onthouden. ✅ GEBOUWD (29-8-2026).**

Trigger: `NavigationStateMachine` bereikt `ARRIVED` -- expliciete, ondubbelzinnige keuze (niet "op Start gedrukt", dat zou een niet-voltooide poging ook als "gereden" tellen).

**Belangrijke bijvangst, zelf ontdekt tijdens het bouwen:** `NavigationSessionController.checkArrival()` bestond al sinds stap 9, maar werd NERGENS vanuit `NavigationScreen.tsx` aangeroepen -- `ARRIVED` werd dus nooit daadwerkelijk bereikt in de praktijk, ongeacht deze nieuwe feature. Nu alsnog gekoppeld: `checkArrival(progress.remainingDistanceM, ARRIVAL_AT_END_THRESHOLD_M)` (uitgangspunt 25m, net als de startdrempel nog niet definitief) wordt bij elke geaccepteerde sample aangeroepen; bij bevestigde aankomst wordt de rit precies ÉÉN keer vastgelegd (`hasRecordedArrivalRef`-guard, gereset bij `stop()`).

**Gebouwd:**
- `lib/history/ridden-routes-store.ts` (`getRiddenRoutes`/`recordRiddenRoute`) -- puur browserlokaal (`localStorage`), SSR-veilig (`typeof window === "undefined"`-guard), best-effort (opslagfout breekt de navigatie nooit), begrensd tot de laatste 20 ritten. 6 tests, met een handmatige in-memory `localStorage`-polyfill (geen jsdom-afhankelijkheid toegevoegd).
- `generateLoopRoutes()` uitgebreid met optioneel `avoidRouteEdgeSets: string[][]` -- hergebruikt LETTERLIJK hetzelfde `edgeOverlapRatio`-mechanisme dat al bestond voor onderlinge dedup tussen kandidaten binnen één aanvraag, nu ook toegepast tegen de geschiedenis. Nieuw diagnosticveld `historyRejected` voor transparantie. 4 nieuwe tests, incl. een test die eerst een baseline-kandidaat vindt, die exact als "gereden" opgeeft, en bevestigt dat 'ie daarna overgeslagen wordt.
- `/api/route/loop` accepteert nu additief `avoidRouteEdgeSets` in de request-body, geeft 'm door.
- `app/page.tsx`'s `searchRoutes()` stuurt `getRiddenRoutes().map(r => r.edgeIds)` mee bij elke aanvraag.
- Geen naamgeving, geen gebruikersactie nodig -- volledig automatisch, zoals afgesproken.

**320/320 tests, `tsc` schoon.** Nog geen echte iPhone-validatie (vereist een daadwerkelijk voltooide rit om te bevestigen dat `ARRIVED`/opslag/dedup end-to-end werkt).

**Fase 3 — "Mijn routes" (bewust apart van fase 2). ✅ GEBOUWD (29-8-2026).**

Expliciete, door de gebruiker gekozen opslag ("♡ Opslaan in Mijn routes" op het detailscherm), optionele naam via een inline prompt. Zonder naam: automatisch "Route van [datum]" (`defaultSavedRouteName`). Nadrukkelijk een apart datamodel van Fase 2's automatische geschiedenis -- geen vermenging.

**Belangrijke ontwerpkeuze: GEEN volledige geometrie in localStorage.** Een bewaarde route bevat alleen `edgeIds`/`nodeIds`/`datasetVersionId`/naam/afstand/datum -- niet de volledige `GraphEdge[]`-geometrie (die zou al snel tientallen KB per route worden). Bij het opnieuw starten wordt de route "vers" teruggehaald via een nieuw endpoint:

- **`POST /api/route/resolve`** (nieuw) -- vertaalt `{datasetVersionId, edgeIds, nodeIds}` terug naar `{resolvedEdges, nodeDisplayNumbers, distanceM}`. Hergebruikt UITSLUITEND bestaande bouwstenen (`resolveRouteEdges()`, dezelfde displayNumber-mapping als `generateLoopRoutes()`) -- geen nieuwe resolutielogica. Bewaakt expliciet `datasetVersionId`-mismatch (409, duidelijke foutmelding "van een oudere datasetversie") -- zelfde discipline als reroute-versiepinning (sectie 19), geen stille corruptie als de dataset ooit ververst wordt.
- **`lib/history/saved-routes-store.ts`** (`getSavedRoutes`/`saveRoute`/`deleteSavedRoute`/`defaultSavedRouteName`) -- zelfde architectuur als Fase 2's `ridden-routes-store.ts` (localStorage, SSR-veilig, best-effort), maar een eigen, gescheiden opslagsleutel. 9 tests.
- **UI**: detailscherm kreeg een "♡ Opslaan in Mijn routes"-knop met inline naam-prompt (optioneel, "Annuleren" mogelijk). "Mijn routes"-tab toont de lijst (naam/datum, afstand, knooppuntaantal, "Start route"/"Verwijder"). Een herstarte opgeslagen route deelt hetzelfde `NavigationScreen`-component als de normale flow (geen tweede navigatie-implementatie) via een kleine `activeSavedRoute`-state naast het bestaande `selectedLoop`; de exit-knop keert terug naar de Mijn-routes-tab i.p.v. het detailscherm van de normale flow.

**329/329 tests, `tsc` schoon.** Nog geen echte iPhone-validatie. Hiermee zijn alle drie geplande fasen van de app-structuurherziening (tabbalk/Home=kaart, gereden-routes-tracking, Mijn routes) gebouwd.

**Twee layoutbugs gevonden en gefixt tijdens de eerste echte iPhone-tests van de tabbalk/Kaart-hometab (29-8-2026):**
1. De "Gebruik deze locatie"-knop werd afgesneden door de tabbalk. Root cause: `LiveLocationScreen` had zowel `inset:0` als een expliciete `height:"100%"` -- in CSS wint `height` het stilzwijgend van `bottom` als beide samen met `top` overconstrained zijn, waardoor de bedoelde `bottom:56`-marge genegeerd werd. Fix: geen expliciete `height` meer, `top`/`bottom` bepalen de hoogte volledig.
2. Tabbalk vergroot (iconen 20→28px, labels altijd zichtbaar i.p.v. alleen bij het actieve tabblad, meer padding) -- "moeilijk te zien tijdens het fietsen".

**Onopgeloste, eenmalige rendering-glitch (29-8-2026, niet reproduceerbaar):** bij één test verscheen het navigatiescherm zonder ENKEL overlay-element (geen kruisje, geen Start/Stop, geen richtingkaart) -- alleen de kale kaart+route. Grondige codereview vond geen aanwijsbare oorzaak (de topbalk is nooit voorwaardelijk). Een directe herhaling ("Opnieuw gestart, vanuit zoeken") werkte meteen correct. Vastgelegd als bekend, niet-reproduceerbaar incident -- niet als opgeloste bug, voor het geval het terugkeert.

---

## 6G. FASE A UITGEBREID: LIVE POSITIE + RICHTING TIJDENS HET AANRIJDEN (🆕 NIEUW, 29-8-2026)

**Aanleiding:** de eerste echte test met een nabije, straatvolgende route (niet de eerdere 24-45km-testgevallen) liet zien dat fase A ("Rijd naar het startpunt") aanvoelde als een statische overzichtskaart met een aftellende afstand, niet als navigeren -- geen eigen positie zichtbaar, geen richting.

**Gebouwd:** tijdens fase A wordt nu, naast de bestaande afstandsberekening, ook:
- de **ruwe GPS-positie** (geen matching -- die begint pas bij sessiestart) als kaartmarker getoond, hergebruikt dezelfde `goknoop-position`-bron als fase B/C.
- een **richtingpijl naar het startpunt** berekend en getoond (`bearingDegrees`, stap 4 -- dezelfde, al bestaande functie, geen nieuwe geometrieberekening), op dezelfde manier gevisualiseerd als de bestaande richtingpijl in fase C.

Bewust NIET toegevoegd: automatisch camera-volgen van de live positie (de kaart blijft, net als in fase B/C, vrij pan-/zoombaar door de gebruiker -- consistent met het "geen Google Maps-achtig gedwongen volgen"-uitgangspunt).

329/329 tests, `tsc` schoon (geen nieuwe testbare pure logica -- hergebruikt uitsluitend bestaande, al geteste bouwstenen).

---

## 6H. AUTO-FIT-MARGE GEFIXT + HEADING-UP-NAVIGATIE AANGESLOTEN (🆕 NIEUW, 29-8-2026)

**Auto-fit-fix:** de route paste bij een echte iPhone-test niet volledig in beeld -- `fitBounds()` gebruikte overal dezelfde marge (60px), terwijl de richtingkaart bovenin veel hoger is dan dat. Nu asymmetrisch: `padding: { top: 180, bottom: 140, left: 40, right: 40 }`, zodat de volledige route zichtbaar blijft ónder de overlay-UI.

**Heading-up-navigatie (stap 2 van sectie 6C, eindelijk daadwerkelijk aan de kaart gekoppeld):**

Naar aanleiding van een echte test ("ik wil dat er ingezoomd wordt en het knooppunt naar het noorden gebracht wordt, zodat ik kan zien of ik links of rechts moet") is de al eerder gebouwde, apart geteste reken-laag (`lib/navigation/direction/relative-direction.ts`, stap 1 van 6C) nu voor het eerst gekoppeld aan de daadwerkelijke MapLibre-kaart:

- **Uitsluitend tijdens fase NAVIGATING** (niet A/B, die blijven bewust noordgericht, sectie 5.3/10): `selectHeadingDeg()` (GPS-bewegingsrichting bij voldoende snelheid, anders laatst bekende stabiele richting) + `smoothHeadingDeg()` (circulaire smoothing, voorkomt nerveuze rotatie) bepalen een gesmoothede rijrichting, hergebruikt de bestaande `MOVEMENT_SPEED_THRESHOLD_MPS`-drempel (geen tweede, afwijkende snelheidsbeslissing).
- `map.easeTo({ center, bearing: gesmoothedeRichting, zoom: 17.5, duration: 500 })` -- kaart draait mee EN zoomt automatisch dichterbij tijdens het navigeren (bewust een uitzondering op de eerder vastgelegde "geen gedwongen camera-volgen"-regel voor fase A/B -- expliciet zo gevraagd voor de actieve navigatiefase).
- **Richtingpijl wordt RELATIEF** (`relativeAngleDeg(bearingToNextNode, huidigeRichting)`) i.p.v. absoluut zodra de kaart zelf heading-up gedraaid is -- anders zou de pijl dubbel roteren. Fase B (Start Guidance) blijft de absolute bearing gebruiken, want daar blijft de kaart noordgericht.
- **Terugval naar noordgericht**: als de fase van NAVIGATING terugvalt naar START_GUIDANCE (bijv. gestopt met bewegen), draait de kaart expliciet terug naar `bearing: 0` -- geen "vastzittende" rotatie. Ook gereset bij `stop()`.

**Bewust nog niet gebouwd:** links/rechts/rechtdoor-classificatie (`classifyDirection()`, ook al gebouwd en getest) wordt nog niet visueel getoond als tekst/icoon naast de pijl -- de pijlrotatie zelf is voor nu de eerste, geteste stap.

329/329 tests, `tsc` schoon (hergebruikt uitsluitend de 26 al bestaande tests van stap 1 -- deze stap is zelf UI-wiring, geen nieuwe pure logica). Nog geen echte iPhone-validatie van de daadwerkelijke rotatie/zoom-tijdens-het-fietsen.

---

## 6I. VIER VERBETERINGEN UIT ECHTE IPHONE-TESTS (🆕 NIEUW, 29-8-2026)

Naar aanleiding van meerdere echte tests met de Volendam-route (fase A/B, kaartcentrering-vragen, "99 vs 98"-verwarring die uiteindelijk verklaard bleek door fysieke verplaatsing van de gebruiker tussen twee tests, niet een bug):

1. **Voortgangsblok verborgen tot fase NAVIGATING** -- werd eerder ook al getoond tijdens Start Guidance (met altijd 0%), verwarrend vóórdat er daadwerkelijk gefietst wordt. Nu: `{progressInfo && phase === "NAVIGATING" && (...)}`.
2. **Echte richtingpijl in Start Guidance** (fase B) -- verving het statische 🧭-icoon door dezelfde geroteerde SVG-pijl als elders, gebaseerd op de al beschikbare absolute bearing (de kaart blijft noordgericht in deze fase, dus absolute bearing blijft correct -- geen wijziging aan de onderliggende berekening).
3. **Zoomknoppen/Stop-knop overlapten elkaar** -- MapLibre's eigen `NavigationControl` (top-right) wist niets van onze eigen topbalk (ook top-right). Gefixt met een gerichte CSS-override (`.maplibregl-ctrl-top-right { top: 68px !important; }`) die de zoomknoppen onder de topbalk duwt.
4. **Linksom/rechtsom-keuze** (nieuwe functie) -- een lus kan nu omgekeerd doorlopen worden vanaf het detailscherm ("↻ Andere kant op rijden"). Volledig CLIENT-SIDE, geen nieuwe serveraanroep: `reverseLoopCandidate()` (`app/page.tsx`) keert simpelweg `route.nodes[]`/`route.edges[]`/`resolvedEdges[]`/`nodeDisplayNumbers[]` om. Werkt correct dankzij de bestaande richtingscorrectie in `buildRouteProgressModel` (Naarden-bugfix, sectie 6D) -- die bepaalt de juiste geometrie-richting per edge aan de hand van de knooppuntvolgorde, dus een omgekeerde volgorde wordt vanzelf correct verwerkt. Bevestigd met een gerichte sanity-check-test: de omgekeerde route levert exact de voorwaartse geometrie in omgekeerde volgorde op, met dezelfde totale afstand.

330/330 tests (1 nieuw, de omkerings-sanity-check), `tsc` schoon.

---

## 6J. ECHTE BUG: OMKEERFUNCTIE WERKTE NIET (REMOUNT-KEY), + AANGEKOMEN-KAART + OMKEREN BIJ HET STARTPUNT (29-8-2026)

**Bevestigde bug:** de "↻ Andere kant op rijden"-knop uit sectie 6I veranderde de route-data intern wel correct (bevestigd met de sanity-check-test), maar `NavigationScreen` bouwt zijn kaart/navigatielogica EENMALIG bij het mounten (React). De `key` die bepaalt of het scherm opnieuw opgebouwd wordt, hield geen rekening met een omkering (dezelfde startlocatie = dezelfde `key` = geen remount) -- het scherm bleef dus stiekem de oude, niet-omgekeerde route tonen.

**Fix:** de `key` bevat nu ook `selectedLoop.route.edges.join(",")` -- verandert de edge-volgorde (door omkering), dan verandert de key, dan forceert React een echte remount, en wordt alles (kaart, matching, state machine) vers opgebouwd met de nieuwe data.

**Bijkomende, gerelateerde verbetering (op verzoek):** de omkeerknop is nu OOK beschikbaar tijdens Start Guidance (fase B, bij het startpunt zelf) via een nieuwe `onReverseDirection`-prop op `NavigationScreen` -- "je weet dan pas welke kant de knooppunten opgaan". Bij indrukken keert `app/page.tsx` de route om; dezelfde `key`-gebaseerde remount zorgt automatisch voor een schone herstart van de sessie (geen aparte in-place-reset-logica nodig binnen `NavigationScreen` zelf).

**Aangekomen-kaart toegevoegd:** `navState === "ARRIVED"` had voorheen GEEN eigen weergave -- de laatst bekende (verouderde) "Rijd deze richting op"-tekst bleef gewoon staan, wat aanvoelde als "vastzitten" i.p.v. een voltooide rit. Nu een expliciete 🏁 "Aangekomen!"-kaart, gecontroleerd VÓÓR de fase-gebaseerde logica.

330/330 tests, `tsc` schoon.

---

## 6K. ECHTE BUG 2: OMKEERKNOP GAF GEEN ZICHTBARE FEEDBACK (29-8-2026)

Ná de remount-key-fix (sectie 6J) werkte de omkeerfunctie zelf wel correct, maar de gebruiker zag nog steeds geen enkel verschil op het detailscherm. Oorzaak: `RoutePreview` tekent `route.geometry` als een simpele lijn -- een omgekeerde puntenreeks van een GESLOTEN lus tekent EXACT dezelfde vorm (dezelfde punten, alleen in omgekeerde volgorde), dus zonder een expliciet label lijkt de knop niets te doen.

**Fix:** `lib/route-engine/loop-orientation.ts` (`loopOrientation()`) -- pure geometrische berekening (shoelace-formule/signed area op de RD-coördinaten van `route.geometry`), geeft ondubbelzinnig "linksom" of "rechtsom" terug. Bewust GEEN losse toggle-state die kan afwijken van de werkelijke geometrie -- de daadwerkelijke puntenvolgorde is de enige bron van waarheid. 3 tests, incl. de garantie dat een omgekeerde lus altijd de tegenovergestelde uitkomst geeft.

Het detailscherm toont nu "Rijdrichting: linksom/rechtsom" direct onder de omkeerknop, die bij elke druk meteen (zichtbaar) verandert.

333/333 tests, `tsc` schoon.

---

## 6L. HEADING-UP OOK OP HET HOME-SCHERM (🆕 NIEUW, 29-8-2026)

Op verzoek: de live-locatiekaart op de Kaart-hometab (`LiveLocationScreen`, sectie 6E) draait nu ook mee met de rijrichting -- hergebruikt EXACT dezelfde, al geteste functies als het navigatiescherm (`selectHeadingDeg`/`smoothHeadingDeg`, sectie 6C/6H).

**Bewust bevestigd met de gebruiker vóór het bouwen, twee expliciete grenzen:**
- **Alleen rotatie, GEEN automatisch inzoomen** ("we navigeren niet, dus het scherm blijft groot") -- dat hoort specifiek bij actieve navigatie (sectie 6H), niet bij dit rustige overzicht.
- **Knooppunten-op-Home bewust NIET gebouwd** -- de gebruiker vroeg er ook naar, maar dit vereist een geheel nieuwe databehoefte ("welke knooppunten liggen er rond deze kaartuitsnede", los van een gekozen route) die nog niet bestaat. Expliciet als apart, later traject afgesproken, niet stilzwijgend meegenomen of vergeten.

Geen nieuwe pure logica (volledig hergebruik), dus geen nieuwe tests nodig -- 333/333 ongewijzigd, `tsc` schoon.

---

## 6M. ECHTE BUG 3: LOGPANEEL NIET VERBORGEN IN PRODUCTIE (29-8-2026)

Het monospace technische statuspaneel (map:/fase:/nav state:) kreeg bij een eerdere polish-stap terecht een `!onExit`-bescherming (alleen zichtbaar in debugmodus, niet in de echte app) -- maar het LOGPANEEL eronder (de tijdgestempelde regels, bijv. "onderweg naar startpunt, nog 1052m") stond daar per ongeluk BUITEN, en bleef dus altijd zichtbaar, ook in productie. Gefixt: zelfde `!onExit`-bescherming nu ook om het logpaneel.

**Open vraag, nog niet beantwoord:** de gebruiker vroeg ook "kunnen we niet naar het knooppunt navigeren?" tijdens fase A. Onduidelijk of dit een verzoek is om ECHTE, straatvolgende routing naar het startpunt (via de Route Engine, i.p.v. de huidige hemelsbrede afstand+richting) -- dat zou een groter, nieuw stuk werk zijn (een punt-naar-punt-routeberekening vanaf de live positie naar het startknooppunt, met een getekende lijn op de kaart net als bij de hoofdroute). Nog te verduidelijken met de gebruiker voordat hieraan begonnen wordt.

333/333 tests, `tsc` schoon.

---

## 6N. NAVIGEREN NAAR HET STARTPUNT: ECHTE, STRAATVOLGENDE ROUTE (🆕 NIEUW, 29-8-2026)

Op verzoek, optie B van de eerder gestelde vraag: fase A ("Rijd naar het startpunt") toonde tot nu toe alleen een hemelsbrede afstand + kompasrichting. Nu wordt er, zodra de eerste live positie binnenkomt, een ECHTE punt-naar-punt-routeberekening gedaan (via de Route Engine) en als eigen lijn op de kaart getekend.

**Server, hergebruikt exact het fallback-patroon van sectie 6B, geen nieuwe aanpak:**
- `lib/route-engine/route-to-point-fallback.ts` (`computeRouteWithFallback`) -- wraps de bestaande `computeRoute()` (punt-naar-punt Dijkstra, al langer bestaand maar nog niet gekoppeld aan de UI) met dezelfde kandidaat-fallback-logica als `generateLoopRoutesWithFallback`: als het dichtstbijzijnde geresolvede knooppunt geen route naar het doel oplevert, wordt de volgende kandidaat geprobeerd. 3 tests, incl. een fallback-scenario.
- `POST /api/route/to-start` (nieuw endpoint) -- accepteert `candidateNodeIds`/`candidateDistancesM` (dezelfde kandidatenlijst als `/api/location/resolve` al levert) + `toLogicalNodeId`, retourneert `resolvedEdges`/`nodeDisplayNumbers` net als de andere route-endpoints (dataketen-fix-patroon).

**Client (`NavigationScreen.tsx`):**
- Bij de EERSTE live positie tijdens fase A wordt eenmalig (niet bij elke sample -- bewust geen doorlopende herberekening) `/api/location/resolve` + `/api/route/to-start` aangeroepen.
- De teruggekregen route wordt getekend als een DUN, GESTIPPELD blauw lijntje, ONDER de hoofdroute-laag -- duidelijk te onderscheiden van de dikke, effen teal hoofdroute.
- De getoonde afstand in de richtingkaart schakelt over van hemelsbreed naar de ECHTE routeafstand zodra bekend.
- **Bugfix tijdens het bouwen zelf gevonden**: de eerste opzet gebruikte de React-state `routeToStartDistanceM` rechtstreeks in de GPS-sample-closure -- een stale-closure-bug (de closure van `start()` wordt maar ÉÉN keer aangemaakt en ziet nooit de bijgewerkte state-waarde). Gefixt met een aparte `routeToStartDistanceRef` die wél altijd de actuele waarde geeft, terwijl de React-state alleen voor de weergave-rerender dient.

**Bewust NIET gebouwd:** live herberekening als de gebruiker een andere weg neemt dan de getoonde route-naar-het-startpunt -- eerste, scoped versie, eenmalige berekening.

336/336 tests, `tsc` schoon. Nog geen echte iPhone-validatie.

---

## 6O. TWEE VERDUIDELIJKINGEN, GEEN CODE (29-8-2026)

**Navigeren-naar-startpunt gebruikt uitsluitend het knooppuntennetwerk, niet per se de objectief kortste weg.** Bevestigd n.a.v. een vraag: `computeRoute()` (sectie 6N) draait op dezelfde `GraphProvider` als de hoofdroute -- dat is uitsluitend het fietsknooppuntennetwerk (Phase 1: 11.003 knooppunten/16.345 edges), geen bredere, algemene stratengraaf. Als de werkelijk kortste weg via een straat loopt die geen deel is van dat netwerk, vindt GoKnoop die niet. Dit geldt voor de hele app, niet alleen deze nieuwe feature -- een inherente eigenschap van de architectuurkeuze (knooppuntennetwerk i.p.v. algemene stratenkaart). Een aparte, algemene stratengraaf (bijv. OSM) zou dit oplossen, maar is substantieel nieuw werk -- BEWUST NIET nu gebouwd, geen actie ondernomen.

**Portrait-modus-vergrendeling: bewust NIET gebouwd, op verzoek van de gebruiker.** Onderzocht en bevestigd (webzoekopdracht, 2026-bronnen): iOS/Safari ondersteunt de Screen Orientation Lock-API niet, ook niet als geïnstalleerde PWA -- een daadwerkelijke schermvergrendeling is op iPhone technisch niet haalbaar, punt. Het enige betrouwbare alternatief (een eigen "draai terug naar staand"-melding bij landscape-detectie, die rotatie niet voorkomt maar wel de kapotte layout verbergt) is voorgesteld en door de gebruiker afgewezen. Geen wijziging aangebracht -- expliciet vastgelegd als bewuste keuze, niet als vergeten actiepunt.

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

---

## 8. BACKLOG — VERZAMELD OVERZICHT VAN ALLE OPENSTAANDE PUNTEN (29-8-2026)

Deze sectie verzamelt alle nog-niet-gebouwde/nog-niet-gekalibreerde punten die verspreid
door dit document genoemd zijn, op één plek, zodat ze niet stilzwijgend verloren raken.
Niets hierin is nu al gebouwd -- dit is een TODO-overzicht, geen statusverslag.

### 8A. GPS-/navigatiekalibratie (uitgangspunten, nog niet definitief)

Deze waarden staan nu op een redelijke inschatting, maar zijn nog nooit tegen een
daadwerkelijke, langere fietsrit getest. Pas afstellen na echte tests (te snel/te traag
reagerend, valse afwijkingsmeldingen, hortende richtingaanwijzingen, etc.):

| Waarde | Huidige instelling | Waar |
|---|---|---|
| `deviationThresholdM` | 20 m | Afwijkingsdetectie (stap 6) |
| `deviationConfirmDurationMs` | ~5000 ms | Bevestigingsvenster vóór een afwijking "telt" |
| `rerouteCooldownMs` | ~10000 ms | Afkoelperiode tussen reroutes |
| `RECENT_ROUTE_MEMORY` | 200 m | Voorkomt heen-en-weer-springen tussen twee routes na reroute |
| `ARRIVAL_AT_START_THRESHOLD_M` | 25 m | Wanneer fase A → fase B overgaat |
| `ARRIVAL_AT_END_THRESHOLD_M` | 25 m | Wanneer `checkArrival()`/"Aangekomen" afgaat |
| `MOVEMENT_SPEED_THRESHOLD_MPS` | 0,5 m/s | Drempel voor "betrouwbare bewegingsrichting" |
| `HEADING_SMOOTHING_ALPHA` | 0,35 | Hoe snel de kaartrotatie een nieuwe richting volgt |
| `classifyDirection`-grenzen | 15° / 45° / 135° | Rechtdoor/licht-links-rechts/links-rechts/achteruit |

### 8B. Stabiliteitslagen

- **✅ GEBOUWD (29-8-2026): te vroeg "aangekomen"-melden.** `NavigationSessionController.checkArrival()` kreeg een optioneel bevestigingsvenster (`clock`/`arrivalConfirmDurationMs`-parameters, `ARRIVAL_CONFIRM_DURATION_MS = 3000` in `NavigationScreen.tsx`) -- exact hetzelfde patroon als `deviationConfirmDurationMs` (stap 6): de gebruiker moet CONTINU binnen de aankomstradius blijven gedurende het venster, en elke uitstap buiten de radius reset de timer. Volledig achterwaarts compatibel: zonder de nieuwe parameters (bestaande 2-argumenten-aanroep) blijft het gedrag exact zoals voorheen -- alle 14 bestaande tests bleven ongewijzigd slagen, plus 4 nieuwe tests voor het nieuwe gedrag.
- **⬜ Nog open: richtingclassificatie-flikkeren.** `classifyDirection()` kan nog rond een grenswaarde heen-en-weer springen (bijv. exact op de grens tussen "licht rechts" en "rechts") -- geen dempingslaag hiervoor, apart van de aankomst-stabiliteit hierboven.

### 8C. Slimmere startknooppunt-keuze — ✅ GEBOUWD (29-8-2026)

`lib/route-engine/start-node-scoring.ts` (`generateLoopRoutesWithScoring`) VERVANGT de simpele
"eerste-die-werkt"-fallback in `/api/route/loop`. Evalueert ALLE meegegeven kandidaten (niet
stoppen bij de eerste succesvolle) en combineert drie factoren tot één score (lager = beter):
- **afstand** (`distancePenaltyPerMeter`, uitgangspunt 1 punt/meter)
- **beschikbaarheid** (`availabilityBonusPerRoute`, uitgangspunt 500 punten per gevonden route)
- **kwaliteit** (`qualityPenaltyPerPercent`, uitgangspunt 20 punten per procentpunt afwijking
  van de doelafstand -- hergebruikt de al bestaande `deviationPercent`, geen nieuwe berekening)

Een kandidaat zonder ENKELE gevonden route krijgt score `Infinity` (nooit bruikbaar, harde
uitsluiting, ongeacht afstand). **Bewezen met een specifiek daarvoor gebouwde test**: twee
volledig gescheiden testnetwerken, één klein en dichtbij (lage kwaliteit voor de gevraagde
afstand), één groter en verder weg (hoge kwaliteit) -- de score kiest aantoonbaar de VERDERE,
betere kandidaat, niet de dichtstbijzijnde. De oude, simpele fallback
(`generateLoopRoutesWithFallback`) blijft gewoon bestaan in de codebase (niet verwijderd),
alleen niet meer de actieve keuze in `/api/route/loop`.

Response-veldnamen (`selectedStartNodeId`/`selectedCandidateRank`/`selectedStartNodeDistanceM`)
bewust ONGEWIJZIGD gehouden t.o.v. de oude fallback, zodat de bestaande UI ("Beste startpunt
gevonden"-banner, `app/page.tsx`) zonder enige codewijziging blijft werken.

345/345 tests, `tsc` schoon.

### 8F. ECHTE reroute-wiring — nog NOOIT concreet ingepland (vraag gesteld 30-8-2026: "wanneer wilde je reroute dan doen?")

Bestaat al, sinds Phase 4 Navigation Engine (stap 7/8): `RerouteExecutor`/`performReroute`/
`RerouteContextTracker`/`RECENT_ROUTE_MEMORY` (`lib/navigation/reroute/`), volledig getest in
isolatie. **Nooit aangesloten op `NavigationScreen.tsx`** -- stond al vroeg als openstaand
testpunt genoteerd ("Reroute... onder echte, gecombineerde belasting", sectie 7's oude
eindvalidatie-checklist), maar kreeg nooit een concrete "volgende stap"-status, steeds
overschaduwd door andere prioriteiten (Volendam-fallback, tabbalk, parkeerplaats-feature).

Sectie 9.17 bouwde inmiddels een MINIMALE stopgap (cyclet door de reroute-lifecycle heen
zonder een echte nieuwe route te berekenen, puur om de matching-freeze bij OFF_ROUTE op te
lossen) -- dat is dus GEEN vervanging van dit backlog-item, alleen een noodgreep tegen het
ergste symptoom. De ECHTE feature (bij een bevestigde afwijking een daadwerkelijk NIEUWE
route via de Route Engine berekenen, met dedup tegen de recent-gereden route) staat hiermee
nu voor het eerst expliciet als eigen, apart te plannen punt vastgelegd.

### 8D. Uit de GPT-mockup, nog niet gebouwd

- Gebogen afslagpijl (echte links/rechts/rechtdoor-symbolen i.p.v. alleen een geroteerde pijl)
- Verwachte aankomsttijd (ETA) -- wacht op een degelijk snelheidsmodel (`Route.durationEstimate` blijft `null`)
- Offline kaarten downloaden (aparte technische fase)
- Foto's in route-detail
- Donut-voortgangsring (als aanvulling op, niet vervanging van, de huidige balk)

### 8E. Andere genoemde, nog niet gebouwde features

- **Knooppunten tonen op het Home-scherm** (los van een gekozen route) -- vereist een nieuwe
  serverfunctionaliteit ("welke knooppunten liggen er rond deze kaartuitsnede")
- **Algemene stratengraaf (bijv. OSM) naast het knooppuntennetwerk** -- voor écht
  kortste-weg-routing buiten het knooppuntennetwerk om (sectie 6O: "navigeren naar het
  startpunt" kan nu alleen via knooppunten-netwerk-edges routeren, niet via willekeurige
  straten)
- **Live herberekening van de route-naar-startpunt** als de gebruiker een andere weg neemt
  dan de getoonde, eenmalig berekende route (sectie 6N)
- **Portrait-modus-vergrendeling** -- technisch niet haalbaar op iPhone (Screen Orientation
  Lock-API niet ondersteund door iOS/Safari, bevestigd via webzoekopdracht); het enige
  werkende alternatief (een "draai terug"-melding bij landscape) is voorgesteld en door de
  gebruiker afgewezen (sectie 6O) -- blijft bewust ongebouwd

---

## 9. PARKEERPLAATS → STARTKNOOPPUNT → ROUTE → BACK TO START (voorbereid 29-8-2026, BOUWEN IN EEN VERSE SESSIE)

**Status: volledig doordacht en vastgelegd, NOG NIET GEBOUWD.** Expliciete keuze: dit is een
echte nieuwe architectuurlaag met een externe afhankelijkheid (API-key, adapter, nieuw
datamodel) -- verdient een verse sessie, niet nog bovenop een toch al lange dag. Begin een
volgende sessie hiermee door dit hele hoofdstuk te lezen, dan is er geen nieuwe audit nodig.

### 9.1 Het kernprobleem

GoKnoop denkt nu alleen in "eerste knooppunt → knooppuntenroute". In werkelijkheid fietst een
gebruiker een complete tocht: auto naar een parkeerplaats, fietsen vanaf die parkeerplaats naar
het eerste knooppunt, de knooppuntenroute rijden, en aan het eind weer terug naar **dezelfde
auto** -- niet naar "knooppunt 24". Die twee concepten (fysiek vertrekpunt vs. route-
startpunt) zijn nu identiek (`route.nodes[0]` is het enige begrip van "start"), en moeten
technisch gescheiden worden.

### 9.2 Audit-bevindingen (al gedaan, hoeft niet opnieuw)

1. **Geen formeel `NavigationSession`-object.** `NavigationStateMachine`/`DeviationDetector`/
   `NavigationSessionController` worden vers, puur in-memory aangemaakt binnen
   `NavigationScreen.tsx`'s `start()`-functie. Niets wordt over de sessie als geheel bewaard.
2. **Startpunt = `route.nodes[0]`/`nodeSequence[0]`**, overal, zonder onderscheid tussen fysiek
   vertrekpunt en route-startpunt.
3. **"Navigeren naar startpunt" bestaat al** (sectie 6N, vandaag gebouwd) en is al bijna wat
   nodig is: een échte, straatvolgende(-ish) route van de live positie naar `nodeSequence[0]`,
   via `computeRouteWithFallback`. Beperking: routeert nu nog via het knooppuntennetwerk zelf,
   niet via algemene straten (zie 9.3), en er wordt nergens een vaste "parkeerplaats" bewaard
   voor later (Back to Start).
4. **Route Engine/GraphProvider kent uitsluitend het fietsknooppuntennetwerk**, geen
   algemene stratengraaf.
5. **Vrijwel alles verwacht dat het startpunt een knooppunt is**: `buildRouteProgressModel`
   (richtingscorrectie o.b.v. `nodeSequence[0]`), `NavigationScreen`-props, `SavedRoute`/
   `RiddenRoute` (slaan `startNodeId` op als knooppunt-ID).

### 9.3 Architectuurbeslissing: twee strikt gescheiden routinglagen

**Bijgewerkt (30-8-2026): `FirstMileRouter` hernoemd naar `LocalBikeRouter`.** Niet omdat de
scope groter wordt, maar omdat de onderliggende capaciteit (een kort fietsstukje naar een
willekeurig punt berekenen) sowieso als ÉÉN ding gebouwd wordt en gewoon vanuit meerdere
plekken in de UI aangeroepen wordt -- "First/Last Mile" dekte die volle lading niet.

```
Layer A -- KnotRouteEngine (knooppunt ↔ knooppunt)
  Bestaande GraphProvider/Route Engine/Dijkstra. ONGEWIJZIGD.
  Mag NOOIT afhankelijk worden van een externe routing-API.
  Blijft ook gebruikt zodra GoKnoop ooit zelf routes laat samenstellen.

Layer B -- LocalBikeRouter (korte fietsverbindingen buiten het knooppuntennetwerk,
           via gewone wegen/fietspaden)
  Scenario's die deze laag bedient:
    - 🅿️ Parkeerplaats → eerste knooppunt
    - 📍 Huidige locatie → een gekozen knooppunt (bijv. "ik wil eerst naar knooppunt 18")
    - 🔵 Laatste knooppunt → parkeerplaats
    - ↩️ Back to Start (grotendeels Layer A, zie 9.5 -- Layer B alleen het laatste stukje)
  Externe, gratis fietsrouting-API (OpenRouteService, zie 9.4) -- UITSLUITEND voor dit
  soort korte, incidentele stukjes. GEEN algemene routeplanner voor heel Nederland, geen
  eigen algemene stratengraaf bouwen (zou neerkomen op Phase 1 overdoen voor heel
  Nederland).
```

Voorbeeldflow:
```
Parkeerplaats
  ↓ LocalBikeRouter
Knooppunt 24
  ↓ KnotRouteEngine
24 → 31 → 36 → 42
  ↓ LocalBikeRouter
Parkeerplaats
```

Harde grens, expliciet zo gekozen door de gebruiker: **"Ik wil het stratenmodel alleen voor
[korte stukjes buiten het netwerk]. De knooppuntenroute navigeert alleen met de
knooppunten."** De scope blijft klein: geen algemene routeplanner, alleen korte
verbindingen waarbij GoKnoop van A naar B moet buiten de knooppuntenroute om.

### 9.4 OpenRouteService -- geverifieerd, geen aanname

Webzoekopdracht bevestigt (officiële ORS-documentatie): directions-endpoint, standaard
**2000 aanvragen/dag, 40/minuut** (een secundaire bron noemt 2500/dag, 40.000/maand -- in
beide gevallen ruim voldoende voor dit lage-volume-gebruik: bij de bredere scope uit 9.3
(parkeerplaats↔knooppunt, GPS↔gekozen knooppunt, Back to Start) typisch enkele aanvragen per
rit, niet per GPS-update). **Bewaar dit in de gaten voor later, niet nu blokkerend**: het
quotum geldt per API-key, dus voor de HELE app samen, niet per gebruiker -- bij veel
gelijktijdige gebruikers kan dit ooit een aandachtspunt worden.

Niet rechtstreeks hardcoden. Abstractielaag, zelfde patroon als `GraphProvider` al gebruikt in
deze codebase (interface + concrete implementatie):

```
LocalBikeRouter (interface)
  route(origin, destination, profile: "cycling" | "foot")
      ↓
OpenRouteServiceAdapter (concrete implementatie)
      ↓
ORS
```

**Bouw eerst uitsluitend `profile: "cycling"`.** Het type staat er zo breed bij zodat een
wandel-scenario later, als daar een concrete behoefte voor ontstaat, zonder herontwerp kan --
dat is nu GEEN bouwopdracht, alleen een bewust opengehouden deur in de interface.

Zodat een andere provider later mogelijk is zonder de navigatie-architectuur opnieuw te
bouwen.

### 9.5 Belangrijke vereenvoudiging, gevonden tijdens het doordenken (29-8-2026)

**"Back to Start" vanuit het MIDDEN van de route hoeft niet meteen naar Layer B te schakelen.**
Omdat een rondje altijd start én eindigt bij hetzelfde knooppunt, kan "Back to Start" vanaf
elk punt in de route eerst gewoon via de BESTAANDE Layer A (knooppunt-naar-knooppunt, met de
al bestaande fallback) teruggeroute worden naar het startknooppunt. **Layer B is dus alleen
nodig voor de allereerste/laatste korte stukjes** (parkeerplaats ↔ eerste/laatste knooppunt),
nooit voor "terug door de route heen". Dit maakt de bouw eenvoudiger dan aanvankelijk gedacht.

```
Back to Start, halverwege de route:
huidige positie → (Layer A, bestaande knooppunt-navigatie) → startknooppunt
                → (Layer B, alleen dit laatste stukje) → parkeerplaats
```

### 9.6 Auto naar parkeerplaats: GEEN eigen routing, gewoon een link

Bewust GEEN Google Maps Directions API (kost geld, botst met de €0-eis) en GEEN eigen
autonavigatie bouwen (zou een concurrerende navigatie-app binnen GoKnoop betekenen, volledig
buiten scope). In plaats daarvan: een simpele link die Apple Maps/Google Maps opent met de
parkeerplaats-coördinaten als bestemming (`https://maps.apple.com/?daddr=lat,lon` of het
Google Maps-equivalent) -- geen API-key, geen kosten, geen onderhoud.

**Detectie van aankomst bij de parkeerplaats vereist ook geen koppeling met Google Maps.**
Zodra de gebruiker terug in GoKnoop is en zijn GPS-positie dicht bij de opgeslagen
parkeerplaats-coördinaten komt, kan het BESTAANDE fase-A-mechanisme ("Rijd naar het
startpunt") gewoon hergebruikt worden -- zelfde patroon, nu toegepast op de parkeerplaats i.p.v.
een knooppunt.

### 9.7 Datamodel — ✅ FASE 2 GEBOUWD (30-8-2026)

`lib/navigation/physical-anchor.ts` -- puur datamodel, geen opslag, geen `LocalBikeRouter`-
aanroep (dat blijft Fase 3+, hierna nog te doen):

```typescript
export type PhysicalAnchor = {
  type: "parking";
  lat: number;
  lon: number;
  name?: string;
};

export function isPhysicalAnchor(value: unknown): value is PhysicalAnchor { ... } // runtime-guard,
  // zelfde patroon als isSavedRoute/isRiddenRoute (sectie 6F/8) -- nodig zodra Fase 3+ dit uit
  // opslag/een API-respons parst.

export type NavigationSessionInfo = {
  routeId: string;
  physicalStart: PhysicalAnchor | null; // null zolang er geen fysiek vertrekpunt gekoppeld is
  routeStartNodeId: string; // Route.nodes[0] -- BLIJFT apart van physicalStart
};
```

**Bewust NOG NIET ingevuld: `phase`/`currentPosition`** (wel genoemd in het oorspronkelijke
conceptuele model). Reden: dat vereist een beslissing over hoe dit zich verhoudt tot de
BESTAANDE `NavigationState` (stap 2) en `PreNavigationPhase` (sectie 6C) -- een derde,
ongerelateerde "fase"-enum zou verwarring riskeren. Die beslissing hoort bij Fase 3/4
(`LocalBikeRouter`-wiring), waar pas duidelijk wordt hoe "op weg naar de parkeerplaats/het
knooppunt" zich verhoudt tot de bestaande matching-state-machine -- hier niet vooruitgelopen.

`route.nodes[0]` blijft het eerste knooppunt -- wordt NIET de parkeerpositie. **Cruciale regel**
(nog te bewaken in Fase 4/5, dit type dwingt het zelf niet af): `physicalStart` mag tijdens een
sessie NOOIT overschreven worden, ook niet bij afwijken/rerouten/tijdelijk elders rijden. Dit
is essentieel voor Back to Start.

6 tests (de runtime-guard), `tsc` schoon. 351/351 tests totaal.

### 9.8 Wat NIET opnieuw gebouwd hoeft te worden (al af, vandaag gedaan)

De oorspronkelijke GPT-opdracht beschreef ook onderstaande punten -- die zijn AL GEBOUWD
vandaag (secties 6F/Fase 2/Fase 3 van dit document), dus GEEN nieuw werk, alleen hergebruiken:
- Gereden routes automatisch onthouden + dedup in de rondje-generator (`ridden-routes-store.ts`,
  `avoidRouteEdgeSets`)
- "Mijn routes" met optionele naam (`saved-routes-store.ts`, opslaan/verwijderen/starten)
- Tabbalk + Home=live kaart, "Waar wil je fietsen?"-knoppenlijst al verwijderd

Een volgende sessie hoeft deze dus niet opnieuw te specificeren of te bouwen -- alleen
`PhysicalAnchor` eraan koppelen waar relevant (bijv. `SavedRoute`/`RiddenRoute` een optioneel
`physicalAnchor`-veld erbij, additief).

### 9.9 Implementatievolgorde voor de volgende sessie

```
Fase 1  Audit -- AL GEDAAN (sectie 9.2), niet herhalen.
Fase 2  ✅ GEBOUWD (30-8-2026) -- PhysicalAnchor + minimale NavigationSessionInfo (sectie 9.7).
Fase 3  ✅ GEBOUWD (30-8-2026) -- LocalBikeRouter + RoutingProvider + OpenRouteServiceAdapter (sectie 9.4/9.11).
        Bestaande Layer A (Knot Route Engine) blijft volledig onaangeroerd.
Fase 4  ✅ GEBOUWD (30-8-2026) -- Parkeerplaats → eerste knooppunt, via LocalBikeRouter (sectie 9.13).
Fase 5  ✅ GEBOUWD (30-8-2026) -- Back to Start (sectie 9.18), met de vereenvoudiging uit 9.5.
Fase 6  Tests, minimaal:
        - Parkeerplaats → eerste knooppunt → volledige route → parkeerplaats
        - Back to Start halverwege de route (bewijst 9.5's Layer-A-eerst-aanpak)
        - Afwijken → reroute → Back to Start (physicalStart blijft ongewijzigd)
        - GPS niet exact op de parkeerpositie
        - Parkeerplaats buiten het knooppuntennetwerk
        - Dichtstbijzijnde knooppunt heeft geen bruikbare route (bestaande fallback moet
          blijven werken)
Fase 7  Google Maps/Apple Maps-link voor de autorit (sectie 9.6) -- simpel, geen API.
```

### 9.10 Harde grenzen (niet doen)

- Bestaande Knot Route Engine (Layer A) niet vervangen of aanpassen
- Geen algemene wegenrouting IN de knooppuntengraaf stoppen
- Geen Google Maps API voor fietsrouting (kost geld)
- Geen continue GPS-data naar een externe router sturen (alleen bij daadwerkelijke
  routebehoefte: naar startpunt, of Back to Start-activatie -- niet per sample)
- Geen betaalde infrastructuur
- Geen volledige Nederlandse OSM-stratengraaf bouwen in deze fase
- `route.nodes[0]` niet vervangen door een parkeerpositie
- `physicalStart` nooit overschrijven tijdens rerouting

### 9.11 Fase 3 — LocalBikeRouter + RoutingProvider + OpenRouteServiceAdapter — ✅ GEBOUWD (30-8-2026)

**Audit vóór het bouwen (zelfde discipline als Fase 2), bevindingen:**
1. **Bestaand provider-patroon**: `GraphProvider` (interface, `lib/route-engine/types.ts`) +
   concrete implementaties (`FirestoreGraphProvider`/`CachedGraphProvider`/
   `InMemoryGraphProvider`) -- `RoutingProvider`/`OpenRouteServiceAdapter` volgen exact
   hetzelfde patroon.
2. **Bestaande coördinatentypes**: `Point = {x, y}` (RD New, `route-engine/types.ts`) +
   `rdToWgs84`/`wgs84ToRd` (`coordinate-transform.ts`). `LocalBikeRouter` gebruikt BEWUST een
   eigen `LatLon = {lat, lon}` (WGS84) i.p.v. `Point` -- dit werkt met ruwe GPS-coördinaten en
   de native volgorde van externe API's, geen RD-omweg nodig voor deze laag.
3. **Bestaand secrets-patroon**: `lib/firebase-admin.ts` -- credentials uit
   `process.env.*`, nooit hardcoded, duidelijke foutmelding bij ontbrekende variabele.
   `OpenRouteServiceAdapter` volgt dit exact (`OPENROUTESERVICE_API_KEY`).
4. **Waar het logisch past**: nieuwe, aparte top-level map `lib/local-bike-router/` (naast
   de al bestaande `lib/route-engine/`/`lib/navigation/`/`lib/map/`/`lib/history/`) --
   geen vermenging met de knooppunten-engine.

**Gebouwd:**
- `lib/local-bike-router/types.ts` -- `LatLon`, `LocalBikeRoutingProfile`
  (`"cycling" | "foot"`, alleen `"cycling"` nu geïmplementeerd), `LocalBikeRouteResult`,
  `LocalBikeRoutingError`, `RoutingProvider`-interface.
- `lib/local-bike-router/open-route-service-adapter.ts` -- `OpenRouteServiceAdapter
  implements RoutingProvider`. Endpoint `POST /v2/directions/{profile}/geojson` (GeoJSON-
  variant, geen polyline-decoder nodig) -- **geverifieerd tegen de officiële ORS-
  documentatie (webzoekopdracht), NIET live getest met een echte API-key** (die is er nu
  niet -- expliciet zo vermeld, geen aanname dat de parsing al perfect klopt). Coördinaten
  in `[lon, lat]`-volgorde (GeoJSON-conventie). 10 tests met een gemockte `fetch`, incl. alle
  foutpaden (netwerkfout, non-ok status, lege/onverwachte respons).
- `lib/local-bike-router/local-bike-router.ts` -- `LocalBikeRouter`, de laag die de rest van
  de app daadwerkelijk aanspreekt (nooit rechtstreeks een `RoutingProvider`-implementatie).
  Simpele in-memory cache (sleutel: afgeronde coördinaten + profiel, ~1m precisie) --
  voorkomt dubbele aanvragen voor dezelfde origin/destination/profiel binnen één sessie.
  Foutresultaten worden NIET gecached. 6 tests, incl. bewijs dat GPS-ruis binnen ~1m
  dezelfde cache-entry treft, en dat verschillende profielen/coördinaten apart gecached
  worden.

**Nog NIET gedaan (bewust, dit was uitsluitend Fase 3):**
- Geen wiring in `NavigationScreen`/`app/page.tsx` (Fase 4/5)
- Geen opslag van `PhysicalAnchor` (Fase 2's `physical-anchor.ts` bestaat, wordt hier nog
  niet aan `LocalBikeRouter` gekoppeld)
- Geen live test met een echte ORS-API-key (nog aan te vragen)
- `profile: "foot"` blijft ongebruikt in de praktijk (het type staat er, geen bouwopdracht)

**16 nieuwe tests (6 + 10), 367/367 totaal, `tsc` schoon.** `lib/route-engine/` (de
Knot Route Engine) is dit hele Fase-3-traject NIET aangeraakt -- expliciet gecontroleerd.

### 9.13 Fase 4 — PhysicalAnchor + LocalBikeRouter geïntegreerd: parking → routeStartNode — ✅ GEBOUWD (30-8-2026)

**Audit vóór het bouwen (zelfde discipline als Fase 2/3), bevindingen (concreet uit de code,
niet aangenomen):**
1. Navigatie naar `route.nodes[0]` startte exact in `NavigationScreen.tsx`'s
   `fetchRouteToStart()`, getriggerd zodra `currentPhase === "TO_START"` (eenmalig, via
   `hasRequestedRouteToStartRef`).
2. GPS → eerste knooppunt liep tot nu toe via `computeRouteWithFallback()`
   (`lib/route-engine/route-to-point-fallback.ts`) -- dus via het KNOOPPUNTENNETWERK zelf
   (Layer A), niet via straten. Dat was precies het gat dat Fase 4 moest dichten.
3. `route.nodes[0]`/`nodeSequence[0]` werd op twee plekken als fysiek vertrekpunt behandeld:
   de `toLogicalNodeId` in de oude fetch-aanroep, en `bearingDegrees(rdPosition,
   model.geometry[0])` voor de richtingpijl -- nergens bestond een apart `physicalStart`-
   begrip.
4. De bestaande candidate-fallback (`/api/location/resolve` → kandidaten) bleek bij nader
   inzien NIET meer nodig voor de HERKOMST-kant: die was er alleen omdat de OUDE aanpak een
   knooppunt-kandidaat nodig had om Dijkstra vanaf te starten. `LocalBikeRouter` routeert
   rechtstreeks tussen twee willekeurige GPS-punten -- geen knooppunt-kandidaat nodig voor
   de herkomst. De candidate-fallback zelf blijft gewoon bestaan en gebruikt op ANDERE
   plekken (routezoeken, `/api/route/loop`) -- hier alleen niet meer nodig.

**Gebouwd:**
- **`POST /api/route/to-start` herschreven** (niet additief, de oude knooppunt-gebaseerde
  aanpak was zelf al een noodgreep): nieuw contract `{origin: {lat,lon}, destination:
  {lat,lon}} → {geometry, distanceM, durationS} | {error, reason}`. Roept `LocalBikeRouter`
  + `OpenRouteServiceAdapter` aan. Geen Firestore/GraphProvider-toegang meer nodig voor dit
  endpoint (de client bepaalt `destination` zelf, zie hieronder) -- **`lib/route-engine/`
  wordt door dit bestand zelfs niet meer geïmporteerd.**
- **`resolvePhysicalStart()`** (nieuw, `lib/navigation/physical-anchor.ts`) -- de "nooit
  overschrijven"-regel (sectie 9.7) als pure, apart geteste functie i.p.v. inline
  React-logica: `current !== null ? current : nieuw PhysicalAnchor van de sample`. 3 nieuwe
  tests (9 totaal in dit bestand), incl. een expliciete GPS-ruis-simulatie (drie licht
  verschillende samples na elkaar, bevestigt dat alleen de EERSTE telt).
- **`NavigationScreen.tsx`**: `physicalStartRef` toegevoegd, gevuld via
  `resolvePhysicalStart()` bij de eerste `fetchRouteToStart()`-aanroep, gereset bij `stop()`
  (tussen sessies, nooit tussentijds). `destination` wordt nu client-side bepaald
  (`rdToWgs84(model.geometry[0].x, model.geometry[0].y)` -- al lokaal bekend, geen
  serveraanroep nodig). De getekende "route naar startpunt"-lijn is nu een simpele
  GeoJSON `LineString` rechtstreeks uit `LocalBikeRouter`'s polylijn -- BEWUST GEEN
  `buildRouteProgressModel`/`buildRouteGeoJson` meer (die zijn specifiek voor het
  edge-gebaseerde knooppuntenmodel, dat past hier niet meer -- Layer B levert geen
  edges/nodes, alleen een puntenreeks + totaalafstand).

**De 8 verplichte tests, expliciet gedekt:**
1. parking → eerste node -- `local-bike-router.test.ts`, "[verplichte test 1]"
2. parking buiten het knooppuntennetwerk -- idem, "[verplichte test 2]" (bewijst dat
   LocalBikeRouter geen enkele relatie met het knooppuntennetwerk vereist)
3. parking dicht bij een node -- idem, "[verplichte test 3]"
4. GPS niet exact op parking -- `physical-anchor.test.ts`, "[verplichte test 4]"
   (GPS-ruis-simulatie)
5. bestaande nearest-node fallback blijft werken -- expliciet herbevestigd door
   `route-to-point-fallback.test.ts`/`start-node-scoring.test.ts` opnieuw te draaien
   (ongewijzigd, 3+5 tests, allemaal groen)
6. physicalStart blijft onveranderd -- `physical-anchor.test.ts`, "[verplichte test 6]"
7. bestaande node-route blijft werken -- `loop-route-generator.integration.test.ts`/
   `loop-route-generator-history.test.ts` opnieuw bevestigd (2+4 tests, ongewijzigd)
8. volledige testsuite blijft groen -- **373/373**, `tsc` schoon

**`lib/route-engine/` is dit hele Fase-4-traject NIET aangepast** (geen enkel bestand in die
map is deze fase gewijzigd) -- expliciet gecontroleerd, niet alleen aangenomen.

**Bewust NIET gedaan in Fase 4 (zoals afgesproken):** geen Back to Start (Fase 5), geen
UI-herontwerp, geen routegeschiedenis-wijziging, geen nieuwe opslag/API buiten wat hier
strikt nodig was.

**Volgende stap, per de gebruiker's eigen voorstel:** pas NU een echte ORS-API-key
aanvragen en één integratietest doen -- niet alleen de adapter los, maar de VOLLEDIGE keten
`parkeerplaats → LocalBikeRouter → eerste knooppunt → KnotRouteEngine`. Dat is nu voor het
eerst een zinvolle test, want de keten staat er nu daadwerkelijk.

### 9.14 KRITIEKE FIX: ORS-endpoint gemigreerd naar api.heigit.org — ✅ GEDAAN (30-8-2026)

**Bevestigd door de gebruiker (met een echte HeiGIT-accountscreenshot: actieve Basic Key,
Directions V2 2000/2000 quotum beschikbaar) en geverifieerd via webzoekopdracht tegen de
officiële HeiGIT-forumaankondiging:**

`api.openrouteservice.org` is gedeprecieerd t.g.v. `api.heigit.org`. **De officiële
aankondiging noemt 24 augustus 2026 als definitieve uitschakeldatum van de oude URL** --
dus op het moment van bouwen (2 september 2026) al ruim verlopen. Dit was dus geen
"nice to have"-correctie, maar noodzakelijk om de integratie sowieso te laten werken.

**Belangrijk detail, niet een simpele domeinvervanging:** de officiële mapping is:
```
api.openrouteservice.org/v2/directions  →  api.heigit.org/openrouteservice/v2/directions
```
Er zit een extra `/openrouteservice/`-servicenaam-segment in -- `api.heigit.org/v2/...`
(zonder dat segment) zou NIET werken. Algemene nieuwe structuur voor alle HeiGIT-API's:
`api.heigit.org/<servicenaam>/<versie>/`.

**Gefixt:** `OpenRouteServiceAdapter`'s standaard `baseUrl` bijgewerkt naar
`https://api.heigit.org/openrouteservice/v2/directions`, plus de bijbehorende
testassertions. 19/19 tests in `lib/local-bike-router/` opnieuw bevestigd correct,
373/373 totaal, `tsc` schoon.

**API-key zelf**: bewust NIET in code/GitHub/zip gezet (beveiligingsafspraak, expliciet
bevestigd) -- gaat als `OPENROUTESERVICE_API_KEY` in Vercel's environment variables, buiten
deze zip om. `OpenRouteServiceAdapter`'s constructor las dit al zo (sectie 9.11), geen
wijziging nodig aan dat deel.

**Volgende stap, ongewijzigd**: één echte integratietest van de volledige keten
`parkeerplaats → LocalBikeRouter → api.heigit.org → eerste knooppunt → KnotRouteEngine`,
zodra de key in Vercel staat.

### 9.15 Fase A: eenmalig inzoomen op de LocalBikeRouter-route zelf — ✅ GEBOUWD (30-8-2026)

Na de eerste succesvolle live-validatie (Edam, 1372m, echte straatvolgende route) bleek de
kaart tijdens fase A nog steeds uitgezoomd op de VOLLEDIGE gekozen route (soms 20-30km) --
de bestaande `fitBounds` bij sessiestart, ongewijzigd sinds vóór Fase 3/4. Dat maakte het
korte parkeerplaats→startpunt-stukje nauwelijks zichtbaar.

**Harde UX-regel, expliciet zo vastgelegd:**
1. Zodra de LocalBikeRouter-route (parking → routeStartNodeId) beschikbaar komt: teken 'm.
2. Voer daarna EENMALIG `fitBounds` uit, uitsluitend op de geometrie van DEZE verbinding
   (niet de volledige route).
3. Padding zodat de lijn niet tegen de randen ligt (70px).
4. Markeer dat deze fitBounds gebeurd is (`hasFitBoundsToStartRef`) -- GPS-updates,
   reroutes of state-updates mogen de camera daarna niet opnieuw automatisch aanpassen.

**Belangrijk onderscheid, bewust gescheiden gehouden:** dit is GEEN doorlopend camera-
volgen -- dat blijft exclusief voor fase C (sectie 6H). Fase A doet precies één gerichte
inzoom-actie en laat de camera daarna met rust; twee verantwoordelijkheden (eenmalig
oriënteren vs. continu volgen tijdens actieve navigatie) blijven gescheiden, niet vermengd.

Geen wijziging aan `lib/route-engine/`. 373/373 tests ongewijzigd (pure UI-wiring, geen
nieuwe testbare pure logica).

**Correctie, zelfde dag**: de eerste versie gebruikte een uniforme marge (70px alle kanten) --
bij een dicht ingezoomde weergave duwde de richtingkaart bovenin (die veel hoger is dan
70px) een stuk van de net getekende route uit beeld, erachter verborgen. Exact dezelfde les
als sectie 6H's fitBounds-fix voor het overzichtsscherm, nu opnieuw toegepast op déze,
nieuwe fitBounds-aanroep: asymmetrische marge (`{ top: 200, bottom: 80, left: 60, right: 60
}`). 373/373 tests ongewijzigd, `tsc` schoon.

### 9.16 Kaart-volgen + vloeiendere overgangen (Home-tab én navigatiescherm) — ✅ GEBOUWD (30-8-2026)

Feedback na echt fietsen: op de Kaart-hometab liep de positie tijdens het fietsen uit beeld
(de kaart draaide wel mee, maar volgde de positie niet), en op zowel de hometab als tijdens
echte navigatie (fase C) voelde het draaien "stukje voor stukje" i.p.v. vloeiend.

**Fix 1 -- positie-volgen op de Kaart-hometab** (`LiveLocationScreen.tsx`): `map.easeTo()`
kreeg er `center: [sample.lon, sample.lat]` bij, naast de al bestaande `bearing` --
hergebruikt exact hetzelfde patroon dat `NavigationScreen.tsx` al had. Zoom blijft
ongewijzigd (bewuste keuze blijft staan: "het scherm blijft groot", geen navigatiemodus).

**Fix 2 -- vloeiendere overgangen, beide schermen**: `EASE_DURATION_MS` verlengd van 500ms
naar 900ms (uitgangspunt, nog niet definitief). Oorzaak van het "stukje voor stukje"-gevoel:
elke GPS-sample triggerde een eigen, losstaande korte animatie -- als de pauze tussen twee
samples langer is dan de animatieduur, voelt elke afzonderlijke beweging aan als een korte
ruk i.p.v. een doorlopende beweging. Toegepast op zowel `LiveLocationScreen.tsx` als
`NavigationScreen.tsx`'s per-sample heading-up-animaties. De eenmalige reset-animaties (terug
naar noordgericht bij stoppen/terugvallen naar Start Guidance) bewust ONGEWIJZIGD gelaten op
500ms -- dat zijn geen herhaalde per-sample animaties, daar speelt dit probleem niet.

Geen wijziging aan `lib/route-engine/`. 373/373 tests ongewijzigd (pure UI-tuning, geen
nieuwe testbare pure logica).

### 9.17 Twee echte bugs uit een echte testrit (30-8-2026)

**Bug 1: bevroren afstandsweergave bij aankomst.** De "afstand naar startpunt"-teller
gebruikte, zodra beschikbaar, de EENMALIG opgehaalde LocalBikeRouter-totaalafstand
(`routeToStartDistanceRef.current`) i.p.v. de live, continu bijgewerkte hemelsbrede afstand
-- maar die statische waarde update nooit terwijl je dichterbij komt. Resultaat: de teller
bleef een oud, te hoog getal tonen (bijv. "150m") terwijl de aankomstdrempel (fase A→B) wél
op de LEVENDE afstand reageerde -- twee inconsistente maten door elkaar. **Fix**: de teller
en de aankomstcheck gebruiken nu allebei uitsluitend `distanceToStartM` (live, hemelsbreed).
De statische LocalBikeRouter-afstand blijft bestaan als informatieve state, niet meer
gebruikt voor de weergave.

**Bug 2 (belangrijker): positie bevroor volledig bij het verlaten van de route.** Root cause,
bevestigd in de code zelf (niet gegokt): `OFF_ROUTE` accepteert in de state machine
UITSLUITEND `startReroute()` als geldige overgang -- maar die werd nergens in
`NavigationScreen.tsx` aangeroepen. Elke sample ná het bereiken van OFF_ROUTE werd dus
afgewezen (`abstained: state_not_accepting_signal`), en omdat de positiemarker/voortgang
uitsluitend bij een GEACCEPTEERDE uitkomst wordt bijgewerkt, bevroor alles -- ook bij
terugkeer naar de route, want de state machine bleef voor altijd in OFF_ROUTE steken.

**Fix, expliciet een MINIMALE, eerlijke stopgap, GEEN volledige reroute-feature**: zodra dit
patroon gedetecteerd wordt, cyclet de code direct door `startReroute()` → `completeReroute()`
heen, ZONDER een daadwerkelijk nieuwe route te berekenen (dezelfde geometrie/model blijft
gelden) -- puur om matching te laten hervatten. Dit hergebruikt uitsluitend bestaande, al
uitgebreid geteste state-machine-methoden (18 verwijzingen in de bestaande tests) inclusief
de ingebouwde `rerouteCooldownMs`-bescherming, die voorkomt dat dit meteen weer terugflipt
naar OFF_ROUTE.

**Nog steeds ontbrekend, bewust niet nu gebouwd**: een ECHTE reroute-berekening (een nieuwe
route via de Route Engine, met `RerouteContextTracker`/`RECENT_ROUTE_MEMORY`-dedup) --
die machinerie bestaat al (stap 7/8) maar is nooit aan `NavigationScreen.tsx` gekoppeld. Deze
stopgap laat je gewoon tegen de OORSPRONKELIJKE route blijven matchen zodra je terugkeert;
als je een blijvend andere weg neemt, biedt de app nog geen alternatieve route aan.

373/373 tests ongewijzigd (geen wijziging aan de al geteste state machine zelf), `tsc`
schoon.

---

## 9.18 Fase 5 — Back to Start — ✅ GEBOUWD (30-8-2026)

**Kernvereenvoudiging, al eerder doordacht (sectie 9.5), nu daadwerkelijk zo gebouwd:**
Back to Start gebruikt vanuit het MIDDEN van de route eerst Layer A (de bestaande
knooppunten-navigatie, hergebruikt `computeRouteWithFallback` -- exact dezelfde fallback als
Fase 4 vóór de LocalBikeRouter-vervanging al gebruikte) om terug naar het startknooppunt te
komen. Layer B (`LocalBikeRouter`) is uitsluitend nodig voor het allerlaatste stukje:
startknooppunt → parkeerplaats.

**Tweede vereenvoudiging, bewust zo gekozen om de scope behapbaar te houden:** voor dat
laatste stukje wordt GEEN nieuwe in-app-navigatie-ervaring gebouwd -- in plaats daarvan
dezelfde, al eerder genomen beslissing als "auto naar parkeerplaats" (sectie 9.6): een link
naar Apple/Google Kaarten met de parkeerplaats-coördinaten. Geen nieuwe turn-by-turn-UI
nodig voor een kort, laatste stukje.

**Server**: nieuw endpoint `POST /api/route/back-to-start` -- berekent BEIDE benen in ÉÉN
serveraanroep (`candidateNodeIds`/`candidateDistancesM`/`routeStartNodeId`/`physicalStart` in,
`{knotLeg, lastMileLeg}` uit). Been 1 (`computeRouteWithFallback`, Layer A) en been 2
(`LocalBikeRouter`+`OpenRouteServiceAdapter`, Layer B) zijn beide al bestaande, al geteste
bouwstenen -- dit endpoint is puur compositie, geen nieuwe pure logica.

**Client (`NavigationScreen.tsx`)**:
- Nieuwe props: `onBackToStart` (callback, aanroeper berekent beide benen en remount met
  been 1 als nieuwe actieve route) en `lastMileInfo` (aanwezig wanneer DIT been 1 van een
  Back to Start-rit is).
- Nieuwe `lastSampleRef` -- houdt de meest recente live positie bij, nodig voor de knop.
- "↩️ Back to Start"-knop, zichtbaar tijdens NAVIGATING, alleen als zowel `onBackToStart` als
  een vastgelegd `physicalStart` beschikbaar zijn (dus nooit voordat fase A daadwerkelijk
  heeft plaatsgevonden).
- Aangepaste ARRIVED-kaart: als `lastMileInfo` aanwezig is, toont "🅿️ Bijna bij je auto" met
  de afstand + een "Open in Kaarten"-link, IN PLAATS VAN de generieke "🏁 Aangekomen!"-kaart.

**`app/page.tsx`**: nieuwe `activeBackToStartRoute`-state, hoogste prioriteit in dezelfde
ternary-keten als `activeSavedRoute`/`selectedLoop` (zelfde, al bewezen remount-via-key-
patroon als bij route-omkering en opgeslagen routes). Nieuwe `startBackToStart()`-functie:
resolvet de huidige positie naar kandidaten (hergebruikt `/api/location/resolve`), roept het
nieuwe endpoint aan, en zet de nieuwe state.

**Geen wijziging aan `lib/route-engine/`** -- het nieuwe endpoint importeert er wel uit
(`computeRouteWithFallback`, `CachedGraphProvider`), maar wijzigt niets, puur hergebruik.

**373/373 tests ongewijzigd** -- het nieuwe endpoint is pure compositie van al geteste
functies (`computeRouteWithFallback` + `LocalBikeRouter`), geen nieuwe pure logica die apart
getest moest worden. `tsc` schoon. Nog geen echte iPhone-validatie van deze specifieke,
grotere feature.

**Nog niet gebouwd, bewust**: live matching/turn-by-turn voor het laatste stukje
(startknooppunt → parkeerplaats) -- alleen afstand + Kaarten-link, geen gedetailleerde
in-app-navigatie. Dat zou, mocht het ooit gewenst zijn, dezelfde `fetchRouteToStart`-stijl
polylijn-weergave kunnen hergebruiken die fase A al heeft -- bewust nu niet gebouwd om de
scope van Fase 5 behapbaar te houden.

---

## 9.19 Pauzeknop met echte snapshot/hervatten — ✅ GEBOUWD (30-8-2026)

Naar aanleiding van een GPT-opdracht die veel verder ging (pauze + fietsdagboek: foto's,
notities, restaurants/terrassen) is bewust een SMALLERE scope vastgesteld: het fietsdagboek
is een apart, later product-idee, geen onderdeel van deze wijziging. De pauzefunctie zelf
werd wél als terecht en goed doordacht beoordeeld -- het kernprobleem was namelijk al door de
eigen audit blootgelegd: er bestaat geen enkele persistente sessie-state, alles leeft alleen
in het geheugen.

**Architectuurkeuze, expliciet zo gekozen**: het pauzescherm is een EIGEN, apart component
(`PauseScreen.tsx`), NIET binnen `NavigationScreen.tsx` gebouwd -- "blijft het
overzichtelijk, staat niet alles in het navigatiescherm". `NavigationScreen` bevat zelf geen
pauzelogica, alleen een knop + een callback die de huidige ritgegevens doorgeeft.

**Definitieve scope, bevestigd:**
- **Bij pauzeren opgeslagen**: route-nodes/edges (licht, zelfde patroon als `SavedRoute` --
  geometrie vers opgehaald bij hervatten via het bestaande `/api/route/resolve`, geen dubbele
  opslag), `physicalStart`, laatst bekende positie, gereden afstand, fietstijd, dataset-versie,
  pauze-tijdstip.
- **Pauzescherm-acties**: Rit hervatten / Naar startpunt / Kaart bekijken / Rit beëindigen
  (MET verplichte bevestiging, nooit één tik).
- **Pauze ≠ beëindigen**: de opgeslagen snapshot blijft simpelweg in localStorage staan totdat
  er expliciet hervat of beëindigd wordt -- geen aparte "PAUSED"-status in de bestaande
  `NavigationState`/`PreNavigationPhase` nodig (bewust geen derde, overlappende state-enum
  toegevoegd, zelfde afweging als bij Fase 2's `physicalStart`).
- **Detectie bij heropenen**: een banner op de Kaart-hometab ("⏸ Gepauzeerde rit -- X km,
  Bekijken") zodra er een snapshot in opslag staat -- werkt ook na het volledig sluiten van de
  app of een telefoon-herstart, want de snapshot staat gewoon in `localStorage`, niet
  afhankelijk van een actieve sessie.

**Gebouwd:**
- `lib/navigation/paused-ride-store.ts` (`getPausedRide`/`savePausedRide`/`clearPausedRide`)
  -- zelfde architectuur als `ridden-routes-store.ts`/`saved-routes-store.ts` (localStorage,
  SSR-veilig, best-effort). Eén actieve gepauzeerde rit tegelijk (geen lijst) -- een nieuwe
  pauze overschrijft een eventuele vorige. 8 tests.
- `components/navigation/PauseScreen.tsx` -- puur presentatie, geen navigatielogica. Bewaakt
  zelf de "Rit beëindigen?"-bevestigingsstap (geen losse actie kan per ongeluk ritdata
  wegvegen).
- `NavigationScreen.tsx`: nieuwe `onPause`-prop + "⏸ Pauze"-knop (naast de al bestaande
  "↩️ Back to Start"-knop, tijdens NAVIGATING), plus een `sessionStartedAtMsRef` om de
  daadwerkelijke rijtijd te kunnen berekenen (bestond nog niet).
- `app/page.tsx`: `pausedRide`-state (geladen bij mount -- de heropen-detectie),
  `getActiveRouteForPause()` (haalt de nodes/edges/datasetVersionId op ongeacht welke van de
  drie routebronnen -- normaal rondje, opgeslagen route, of Back to Start-been -- op dat
  moment actief is), en de drie handlers (`resumePausedRide`/`backToStartFromPause`/
  `endPausedRide`). Hervatten hergebruikt LETTERLIJK hetzelfde patroon als het al bestaande
  `startSavedRoute()` (edges vers ophalen via `/api/route/resolve`, dan `activeSavedRoute`
  vullen) -- geen nieuwe/afwijkende hervat-mechaniek. "Rit beëindigen" roept de al bestaande
  `recordRiddenRoute()` aan, zodat een voortijdig beëindigde rit toch meetelt voor
  routevariatie (sectie 6F/Fase 2), precies zoals de gebruiker vroeg.

**Geen wijziging aan `lib/route-engine/`.** 381/381 tests (373 + 8 nieuw), `tsc` schoon.

**Bewust NIET meegenomen, expliciet uitgesteld naar een later "Ritdagboek"-traject**: foto's,
notities, restaurants/terrassen-zoeken. Die vereisen een eigen opslaglaag (foto's passen niet
in localStorage) en een derde externe dienst (plaatsen-zoeken) -- een ander soort feature,
niet vermengd met deze wijziging.

### 9.20 Opruiming: Back to Start volledig naar het pauzemenu + compacte attributie (30-8-2026)

**Op verzoek: "Pauze menu wil ik alles in zetten. Is tevens controlekamer."** De standalone
"↩️ Back to Start"-knop tijdens NAVIGATING is verwijderd -- Back to Start is nu UITSLUITEND
bereikbaar via het pauzemenu (`PauseScreen.tsx`, al aanwezig sinds sectie 9.19). De
`onBackToStart`-prop is helemaal uit `NavigationScreen.tsx` verwijderd (dode plumbing na het
weghalen van de knop) -- `startBackToStart()` in `app/page.tsx` zelf blijft gewoon bestaan,
alleen niet meer via een directe knop in het navigatiescherm aangeroepen, uitsluitend via
`backToStartFromPause()`.

De overgebleven "⏸ Pauze"-knop kreeg een eigen, herkenbare vormgeving (ronde witte knop met
schaduw, 60px, teal icoon) i.p.v. een klein donker pilletje naast een andere knop -- consistent
met de al bestaande ronde-witte-knop-stijl (bijv. de "centreer op mijn locatie"-knop op de
Kaart-hometab).

**Kaartattributie compact gemaakt, NIET verwijderd.** De permanente "MapLibre | OpenFreeMap ©
OpenMapTiles Data from OpenStreetMap"-balk onderaan is waarschijnlijk een licentievereiste
(OpenStreetMap's ODbL-licentie vereist attributie) -- gewoon weghalen zou een compliance-
risico zijn. In plaats daarvan: `attributionControl: { compact: true }` bij beide
kaartinitialisaties (`NavigationScreen.tsx` en `LiveLocationScreen.tsx`) -- MapLibre's
ingebouwde compacte modus, klapt samen tot een klein "i"-icoontje dat pas uitklapt bij een tik,
in plaats van een permanente balk.

Geen wijziging aan `lib/route-engine/`. 381/381 tests ongewijzigd (pure UI-opruiming/-tuning,
geen nieuwe testbare pure logica).

---

## 9.21 "Route naar een adres" — ✅ GEBOUWD (30-8-2026)

Nieuwe functie: van de huidige locatie naar een willekeurig adres/plaats (bijv. "Hilversum,
Kerkstraat 5"), niet alleen rondjes of Back to Start. **Bevestigd tijdens het ontwerpgesprek:
géén nieuwe motor nodig** -- exact dezelfde drie-lagen-architectuur als Fase 4/5, nu op een
willekeurige bestemming toegepast:

```
herkomst (GPS)   -- LocalBikeRouter -- automatisch via fase A, GEEN nieuwe code nodig
  ↓ dichtstbijzijnde knooppunt bij herkomst
KnotRouteEngine, MET fallback aan BEIDE kanten (nieuw)
  ↓ dichtstbijzijnde knooppunt bij bestemming
LocalBikeRouter -- laatste stukje naar het exacte adres (hergebruik van Back to Start's
                   lastMileInfo-mechanisme, nu gegeneraliseerd)
```

**UI-beslissing, bewust zo gekozen (i.p.v. een centraal "Overzicht"-menu):** de eerder
vastgelegde keuze "Home = rustige, dominante kaart, geen knoppenlijst" bleef staan. In plaats
daarvan: een NIEUW, apart blok op de bestaande Zoeken-tab, met een eigen invoerveld -- niet
vermengd met de bestaande plaatsnaam-zoekfunctie (die gaat naar de "hoeveel km wil je
fietsen"-rondje-flow, functioneel iets anders).

**Nieuw, genuine engine-stuk**: `lib/route-engine/route-between-candidates.ts`
(`computeRouteBetweenCandidatesWithFallback`) -- de ENIGE echt nieuwe berekening. Herkomst-
fallback (`computeRouteWithFallback`, al bestaand) werkte al aan de vertrekkant; nu ook de
BESTEMMING kan een onbruikbare dichtstbijzijnde kandidaat hebben (zelfde Volendam-patroon,
sectie 6B, aan de andere kant van de route) -- dit probeert bestemmingskandidaten op volgorde,
gebruikt voor elk de volledige, al bestaande herkomst-fallback. 4 tests, incl. een test die
per ongeluk "van een node naar zichzelf" als fixture had (triviaal altijd geslaagd, geen
goede test) -- gecorrigeerd naar twee daadwerkelijk gescheiden, onbereikbare nodes.

**Kleine, additieve uitbreiding elders, nodig voor het laatste stukje**:
`resolveFromPlaceName()` (`location-resolver.ts`) gaf het geocodede punt zelf nooit terug
(alleen de dichtstbijzijnde knooppunt-kandidaten) -- het punt werd intern al berekend maar
weggegooid. Nu `geocodedLat`/`geocodedLon` ook in de respons, puur additief (bestaande
aanroepers die alleen `candidates`/`geocodedAs` lezen ongewijzigd).

**Nieuw endpoint** `POST /api/route/to-destination` -- zelfde structuur als
`/api/route/back-to-start` (sectie 9.18), nu met fallback aan BEIDE kanten i.p.v. een vast
doelknooppunt.

**Client**: `NavigationScreen`'s `lastMileInfo` kreeg een `kind?: "parking" | "destination"`-
veld, zodat de aankomstkaart "🅿️ Bijna bij je auto" (Back to Start) of "🎯 Bijna bij je
bestemming" (dit) toont, afhankelijk van de context -- zelfde kaart, gegeneraliseerd i.p.v.
gedupliceerd. `app/page.tsx` hergebruikt LETTERLIJK de bestaande `activeBackToStartRoute`-
state/render-pad (structureel identiek: knooppunten-been + laatste-stukje-info) -- geen
nieuwe state, geen nieuwe NavigationScreen-koppeling nodig.

Geen wijziging aan `lib/route-engine/`'s KERN (Dijkstra/GraphProvider zelf) -- alleen een
nieuw, dun bestand eromheen + een additieve responsuitbreiding.

**385/385 tests (381 + 4 nieuw), `tsc` schoon.** Nog geen echte iPhone-validatie.

---

## 9.22 ECHTE VERCEL-BUILDFOUT + gat in eigen verificatieproces gevonden (30-8-2026)

**De fout zelf:** `app/api/route/to-destination/route.ts` faalde op Vercel met "Property
'selectedDestinationNodeId' does not exist" -- een TypeScript-type-versmallingsfout. De code
gebruikte `if ("ok" in knotResult && knotResult.ok === false) { ... }`, waarna de rest van de
functie aannam dat `knotResult` het succesvolle type was. Deze samengestelde conditie bleek
niet betrouwbaar genoeg voor Next.js' striktere build-time typecontrole om te versmallen.

**Fix:** vereenvoudigd naar `if ("ok" in knotResult) { ... }` -- betrouwbaarder, want alleen
het faal-type heeft ÜBERHAUPT een `ok`-veld; de aanwezigheid van het veld alleen is al
voldoende om te onderscheiden. Toegepast op alle drie de endpoints met hetzelfde patroon
(`/api/route/loop`, `/api/route/back-to-start`, `/api/route/to-destination`) plus de
brondefinitie in `route-between-candidates.ts` zelf, uit voorzorg vóór een volgende build
hierop zou struikelen.

**Belangrijker: een gat in mijn eigen verificatieproces gevonden en gedicht.** Mijn sandbox-
`tsconfig.json` had `"include": ["lib/**/*.ts", "app/**/*.tsx", ...]` -- **alleen `.tsx`, niet
`.ts`, onder `app/`**. API-route-bestanden (`app/api/.../route.ts`) zijn `.ts`-bestanden --
dit betekent dat mijn lokale `tsc --noEmit`-controles gedurende (een deel van) deze sessie
API-routes NIET daadwerkelijk hebben meegecontroleerd, wat precies verklaart waarom deze fout
lokaal niet werd gevonden maar wel bij de echte Vercel-build. **Rechtgezet**: sandbox-
`tsconfig.json` nu bijgewerkt naar exact hetzelfde `include`-patroon als de echte repo
(`"**/*.ts", "**/*.tsx"`). Een volledige hercontrole met deze gecorrigeerde configuratie gaf
verder geen andere fouten (alleen 4 valse meldingen in oude, losstaande scratch-bestanden
buiten de echte repo-structuur, die zijn opgeruimd).

**Les voor volgende sessies**: bij het opzetten van een verificatie-sandbox altijd eerst de
ECHTE `tsconfig.json`/`package.json` (TypeScript-versie) van de repo ophalen en gebruiken,
niet een handmatig samengestelde variant -- ook al lijkt die functioneel gelijk.

385/385 tests ongewijzigd (pure typefix, geen gedragsverandering), `tsc` schoon (nu met een
betrouwbaarder controle-opzet).

---

## 9.23 Vastgelegd voor de volgende sessie: parkeerplaats-zoekfunctie via Overpass API

**Nog NIET gebouwd -- expliciet als plan vastgelegd, op verzoek.**

**Gewenste flow** (aansluitend op de "route naar een adres"-functie, sectie 9.21):
```
Route naar Hilversum gezocht
      ↓
GoKnoop toont ook: parkeerplaatsen in de buurt van de bestemming
      ↓
Gebruiker kiest een parkeerplaats
      ↓
Link naar Google/Apple Maps (zelfde patroon als sectie 9.6 -- geen eigen autorouting)
      ↓
Gebruiker rijdt er met de auto naartoe
      ↓
GoKnoop pakt het op zodra de gebruiker weer in de app is (fase A, zoals nu al werkt)
```

**Onderzocht, met geverifieerde cijfers (webzoekopdracht, 30-8-2026):** Overpass API
(`overpass-api.de`), de gratis, publieke query-dienst van de OpenStreetMap-gemeenschap zelf.
Parkeerplaatsen staan al standaard getagd in OSM-data (`amenity=parking`).
- **Geen API-key nodig, geen registratie**
- **Zachte richtlijn: ~10.000 aanvragen/dag** per applicatie op de publieke server -- ruim
  voldoende voor incidenteel gebruik (een paar zoekopdrachten per fietser, niet per
  GPS-update)
- 2 gelijktijdige aanvragen per IP-adres (zachte limiet, geen probleem voor dit gebruik)

**Architectuur, zelfde patroon als `LocalBikeRouter` (sectie 9.11):**
```
Navigation
    ↓
PlacesFinder (nieuwe, dunne laag)
    ↓
PlacesProvider (interface)
    ↓
OverpassPlacesAdapter (concrete implementatie)
```

**Belangrijk, bewust afgebakend:** dit is SPECIFIEK voor parkeerplaatsen, nauw verwant aan
`PhysicalAnchor`/Fase 4-5. De BREDERE "plaatsen zoeken"-functie (restaurants, terrassen,
koffie -- voor het latere Ritdagboek, sectie 9.19's uitgestelde scope) blijft een APART, later
traject, ook al zou die dezelfde onderliggende Overpass-dienst kunnen gebruiken. Niet
samenvoegen, ook al is de techniek gedeeld.

**Nog te bepalen bij het bouwen:** exacte zoekstraal rond de bestemming, hoeveel resultaten
tonen, of/hoe de link naar Kaarten per parkeerplaats verschijnt.

---

## 9.24 Vastgelopen zoom + tweede, groter gat in eigen verificatieproces (30-8-2026)

**Het gemelde probleem, uiteindelijk verklaard:** de gebruiker zag een navigatiescherm zonder
enige zichtbare knop (kruisje/Stop/Pauze) via de nieuwe "route naar een adres"-functie
(sectie 9.21). Eerst onderzocht als mogelijke React-crash/structurele JSX-fout (haakjes-
balans gecontroleerd op de live GitHub-versie -- klopte prima, geen structuurfout). Uiteindelijk
bleek de daadwerkelijke oorzaak: **de browserpagina zelf was per ongeluk ingezoomd (pinch-
zoom) en kon niet meer terug** -- een bekende iOS Safari-eigenaardigheid, geen codefout. Bij
een vastgelopen paginazoom verdwijnen vast-gepositioneerde elementen (`position: fixed`,
zoals het kruisje/Stop-knop) buiten het zichtbare deel van het scherm.

**Fix:** `app/layout.tsx` kreeg een expliciete Next.js `viewport`-export
(`maximumScale: 1, userScalable: false`) -- de HELE pagina kan niet meer pagina-breed
gepincht worden. De kaart zelf (MapLibre) heeft haar eigen, onafhankelijke zoomknoppen/
-gebaren, die blijven gewoon werken -- dit raakt alleen de browserpagina zelf, niet de kaart.

**Tweede, groter gat in mijn eigen verificatieproces gevonden tijdens het uitzoeken:** mijn
sandbox had **Next.js 16.3.3 en React 19.2.8 geïnstalleerd, terwijl de echte repo vastzit op
Next.js 14.2.35 / React 18.3.1** (`package.json`) -- een groot major-versieverschil. Dit
verklaarde een aparte, valse foutmelding tijdens het bouwen van deze fix zelf (een
Next.js-Fonts-API-verschil tussen versie 14 en 16). **Rechtgezet**: sandbox nu geïnstalleerd
met exact de gepinde versies uit de echte `package.json` (`next@14.2.35`, `react@18.3.1`,
`react-dom@18.3.1`, en de bijbehorende `@types/*`-pakketten).

**Herhaalde, belangrijke les (zelfde als sectie 9.22, nu uitgebreid)**: bij het opzetten van
een verificatie-sandbox altijd EERST de volledige, echte `package.json` ophalen en
ALLE dependency-versies exact matchen (niet alleen `tsconfig.json`) -- een sandbox met
afwijkende major-versies van kernafhankelijkheden (Next.js, React) kan zowel valse fouten
geven (zoals hier) als, potentieel gevaarlijker, ECHTE fouten MISSEN als een nieuwere
versie toevallig soepeler is dan de gepinde, oudere versie.

385/385 tests ongewijzigd, `tsc` schoon (nu met correct uitgelijnde dependency-versies).

### 9.25 Pauzeknop eerder beschikbaar: vanaf "Start", niet pas fase C (30-8-2026)

Op verzoek: de "⏸ Pauze"-knop stond eerder alleen tijdens fase NAVIGATING (fase C). Nu
zichtbaar vanaf het moment dat de sessie daadwerkelijk gestart is (`running`, dus zodra op
"Start" gedrukt wordt) -- ook tijdens fase A ("Rijd naar het startpunt") en fase B ("Je staat
bij het startpunt"). De bestaande `onPause`-handler hoefde niet aangepast: tijdens fase A/B is
`progressInfo`/`sessionStartedAtMsRef` nog niet gevuld, dus een pauze op dat moment legt
gewoon `distanceTraveledM: 0`/`rideTimeS: 0` vast -- correct gedrag, geen speciale afhandeling
nodig.

Geen wijziging aan `lib/route-engine/`. 385/385 tests ongewijzigd (pure UI-zichtbaarheids-
wijziging).

### 9.26 Twee echte fixes uit een echte testrit: score-regressie + pauzeknop-positie (30-8-2026)

**Bug 1 (belangrijk): "20km vroeg, kreeg routes van 30km+".** Bevestigde regressie in
`generateLoopRoutesWithScoring` (sectie 8C/9.11's opvolger): `availabilityBonusPerRoute: 500`
woog te zwaar t.o.v. `qualityPenaltyPerPercent: 20` -- een kandidaat met 4 matige routes
(bijv. 40% afwijking) kon een kandidaat met 1 uitstekende route (5% afwijking) verslaan, puur
omdat "meer opties" te zwaar meetelde. **Fix**: gewichten omgedraaid --
`qualityPenaltyPerPercent: 50` (was 20), `availabilityBonusPerRoute: 50` (was 500). Kwaliteit
(afstand tot de gevraagde doelafstand) is nu dominant, extra opties zijn een kleine
tie-breaker. De bestaande test die bewijst dat een verder-maar-beter-passende kandidaat kan
winnen bleef ongewijzigd slagen (de kernlogica klopte, alleen de balans was scheef) -- alleen
de test die de exacte gewichten hardcoded had is bijgewerkt.

**Bug 2 (kleiner, UX): pauzeknop-positie voelde inconsistent.** Stond `marginTop: 12` direct
onder de richtingkaart -- daardoor verschoof de knop per fase (TO_START/START_GUIDANCE/
NAVIGATING hebben elk een andere kaarthoogte), wat "zwevend"/inconsistent aanvoelde. **Fix**:
vaste `position: absolute`-plek rechtsonder (boven de voortgangsbalk, die bij `bottom:164`
begint, dus geen overlap), onafhankelijk van de richtingkaart -- altijd op dezelfde plek,
ongeacht de fase.

385/385 tests ongewijzigd (bug 1 raakte alleen configuratiewaarden binnen een al bestaande,
geteste functie; bug 2 is pure UI-positionering).

### 9.27 ECHTE REGRESSIE GEVONDEN: gereden-routes-dedup werd te agressief na een dag testen (30-8-2026)

**Het gerapporteerde probleem**: "20km gevraagd, kreeg routes van 38/42.8/65.6km" -- bevestigd
als een echte regressie (niet het oorspronkelijke gedrag: "hij was goed, de rondjes").

**Belangrijke les over het diagnoseproces zelf**: de eerste diagnose (sectie 9.26, de
score-gewichten) bleek FOUT -- beide fixes van die ronde waren bevestigd live op GitHub, maar
het probleem bleef identiek. Dat had ik moeten opmerken als signaal om de diagnose te
heroverwegen, niet om nogmaals aan dezelfde knop te draaien. Uiteindelijk gevonden door
terug te redeneren vanuit "hij was goed" (dus een regressie, geen structureel probleem) en te
zoeken naar wat er SPECIFIEK vandaag veranderd was in dit gebied: de gereden-routes-dedup
(sectie 6F/Fase 2), na een hele dag intensief testen in exact hetzelfde Volendam/Edam-gebied.

**Root cause, bevestigd in de code**: `avoidRouteEdgeSets` in `generateLoopRoutes()`
(`loop-route-generator.ts`) was een HARDE uitsluiting -- een kandidaat die matchte met een
eerder gereden route werd volledig overgeslagen, ongeacht hoe goed die verder paste. Na een
dag testen (tot 20 opgeslagen gereden routes, `MAX_STORED_ROUTES`) in hetzelfde kleine gebied
waren vrijwel alle goed-passende 20km-opties al "gereden" en dus uitgesloten -- de generator
moest noodgedwongen veel verder afwijkende routes (38-65km) teruggeven om toch `count` routes
te vinden.

**Fix**: van harde uitsluiting naar zachte voorkeur MET terugval. Eerste doorgang: frisse
(niet eerder gereden) routes hebben de voorkeur, op volgorde van beste afstandspassing.
Tweede doorgang, ALLEEN als er na de eerste doorgang nog ruimte over is (`accepted.length <
count`): vul aan met de best passende eerder-gereden routes. Zo blijft "liever een nieuwe
route" het uitgangspunt (ongewijzigd t.o.v. de oorspronkelijke intentie, sectie 24 van de
oorspronkelijke pauze-opdracht: "standaard liever een nieuwe route, maar gebruiker mag bewust
een oude route opnieuw kiezen"), maar wordt afstandskwaliteit nooit meer opgeofferd om
herhaling koste wat het kost te vermijden.

**Test bijgewerkt + nieuwe regressietest**: de bestaande test die het OUDE (harde) gedrag
verifieerde is herschreven naar het nieuwe, gewenste gedrag (terugval geeft nog steeds
routes, met afstandskwaliteit vergelijkbaar aan de ongefilterde beste route). Een NIEUWE test
bootst het exacte gerapporteerde scenario na (alle 4 baseline-routes als "gereden"
gemarkeerd) en bewijst dat de teruggegeven routes nooit extreem afwijken (< 50%) -- direct
tegen het gerapporteerde symptoom (~225% afwijking bij 65,6km i.p.v. 20km).

**Bijkomende, kleinere bevinding (NIET gefixt, bewust als apart punt genoteerd)**: de "Beste
startpunt gevonden"-banner op het resultatenscherm toonde een verwarrende, zelf-tegenstrijdige
tekst ("Knooppunt 98 -- Knooppunt 98 lag dichterbij") -- de onderliggende LOGICA bleek
correct (een daadwerkelijk andere, beter scorende kandidaat werd gekozen), maar er bestaan
blijkbaar twee verschillende, echte knooppunten in de dataset die toevallig hetzelfde
weergavenummer "98" delen (al eerder gezien op de kaart bij Volendam, sectie eerder in dit
document). Dit is een data-eigenaardigheid, geen codefout -- vereist knooppunten met dubbele
weergavenummers kunnen onderscheiden (bijv. door coördinaten of interne ID te tonen bij een
botsing) -- BEWUST NIET nu gefixt, apart vervolgpunt.

386/386 tests (385 + 1 netto: één test herschreven naar nieuw gedrag, één nieuwe
regressietest toegevoegd), `tsc` schoon.

### 9.28 Gereden routes: correctie + zichtbaar in "Mijn routes" + "al eerder gereden"-indicator (30-8-2026)

**Correctie op verzoek**: "gereden routes zijn gereden, niet op de helft gestopt". Eerder
riep `endPausedRide()` (sectie 9.19) ten onrechte `recordRiddenRoute()` aan bij een
voortijdig beëindigde rit vanuit het pauzemenu -- dat is nu verwijderd. Uitsluitend een
échte aankomst (`NavigationScreen.tsx`, de ARRIVED-stabiliteitslaag) legt nog een gereden
route vast.

**Drie uitbreidingen, op verzoek:**

1. **"Nooit weggooien"**: `MAX_STORED_ROUTES`-limiet (was 20) volledig verwijderd uit
   `ridden-routes-store.ts` -- alle gereden routes blijven permanent bewaard. Voor de
   PRAKTISCHE dedup-aanroep naar de server (avoid-lijst bij het zoeken van nieuwe routes)
   is een aparte, wél begrensde functie toegevoegd: `getRecentRiddenRoutesForDedup()`
   (standaard de meest recente 20) -- puur om de request-payload begrensd te houden, geen
   verwijdering uit de opslag zelf. `datasetVersionId` en een stabiel `id` toegevoegd aan
   het datamodel (ontbraken eerder) -- nodig om een gereden route later daadwerkelijk
   opnieuw te kunnen laden/rijden.

2. **Zichtbaar in "Mijn routes"**, als eigen sectie onder de bestaande "Opgeslagen routes":
   elke gereden route toont de afstand, "Gereden op [datum]" (de datum werd al vastgelegd,
   alleen nooit getoond), een "Start route"-knop (hergebruikt exact hetzelfde
   resolve-en-start-patroon als opgeslagen routes -- `startSavedRoute`/`startRiddenRoute`
   delen nu een gemeenschappelijke `startRouteFromReference()`-helper), en een "♡ Bewaar als
   favoriet"-knop die de route direct naar de bestaande opgeslagen-routes-opslag kopieert.

3. **"Al eerder gereden"-indicator bij het zoeken van een nieuw rondje**: op het
   resultatenscherm toont elke routekaart nu "✓ Al eerder gereden" als de route
   significant overlapt met een eerder gereden route -- hergebruikt dezelfde
   `edgeOverlapRatio()`-functie die ook server-side voor dedup gebruikt wordt
   (`lib/route-engine/route-diversity.ts`, een pure functie, veilig client-side
   te hergebruiken). Puur informatief, geen filtering -- de gebruiker ziet nu zelf welke
   voorgestelde routes nieuw zijn en welke al bekend zijn.

**Tests bijgewerkt**: bestaande opslagtest ("begrenst het aantal") vervangen door het
tegenovergestelde ("geen limiet meer"), plus een nieuwe test die bewijst dat de dedup-functie
wél begrensd blijft zonder de volledige opslag aan te tasten. 387/387 tests totaal
(386 + 1 netto), `tsc` schoon.

Geen wijziging aan `lib/route-engine/`'s kern (Dijkstra/GraphProvider zelf).

### 9.29 Eerste echte testrit (adres-navigatie) — drie bevindingen (30-8-2026)

**Positieve bevestiging**: de "route naar een adres"-functie (sectie 9.21) werkte in de
praktijk goed -- adres ingevoerd, GoKnoop bracht de gebruiker er correct naartoe, GPS-verlies
onderweg herstelde vanzelf, en de "Open in Kaarten"-link bij het laatste knooppunt (sectie
9.18's `lastMileInfo`) werkte zeer goed.

**Bevinding 1 -- pauzeknop-overlap, opgelost**: de vaste positie (`bottom: 190`) overlapte
alsnog met de voortgangsbalk (`bottom: 164`) tijdens NAVIGATING, waardoor de knop daar
onzichtbaar was -- pas zichtbaar bij ARRIVED (als de voortgangsbalk wegvalt). Pauzeknop
verplaatst naar `bottom: 280`, ruim boven de voortgangsbalk.

**Bevinding 2 -- voortgangsbalk dichter naar de rand**: op verzoek verplaatst van
`bottom: 164` naar `bottom: 20` -- meer kaartruimte zichtbaar. De kaartattributie (compacte
"i", sectie 9.20) kan hierdoor tijdens NAVIGATING onder de balk vallen -- expliciet
geaccepteerd door de gebruiker ("die is ook gelijk weg, haha"), geen zorg.

**Bevinding 3 -- ECHT ONTBREKEND, NIET NU GEBOUWD, apart vervolgpunt**: "Hervat rit" in het
pauzemenu start nu de HELE oorspronkelijke route opnieuw vanaf fase A (rijd naar het eerste
knooppunt), niet "ga verder vanaf de laatst bekende voortgang". Bij een rondje valt dit
zelden op (begin/eind liggen dicht bij elkaar); bij een punt-naar-punt-adres-rit (bijv.
Hilversum) is dit een echt probleem -- "hervatten" na bijna-aankomst probeerde de gebruiker
terug naar het OORSPRONKELIJKE startpunt (Volendam) te sturen. Dit vereist daadwerkelijk
"instappen op de juiste plek in de route", niet simpelweg de route opnieuw beginnen -- een
groter, apart te plannen stuk werk, bewust NIET nu gebouwd (net als de echte reroute-wiring,
sectie 8F).

### 9.30 "Open in Kaarten" ook tijdens fase A (30-8-2026)

Op verzoek: naast de bestaande eigen weergave (afstand + pijl naar het startpunt) staat er nu
ook een "Open in Kaarten"-link tijdens fase A -- ALS AANVULLING, niet als vervanging (de
gebruiker koos zelf per rit). Zelfde Apple Maps-deeplink-patroon als elders al gebruikt
(`lastMileInfo`'s kaart, sectie 9.6/9.18).

**Waarom dit geen verlies van functionaliteit betekent**: de aankomstdetectie werkt op basis
van de live GPS-positie, ongeacht of de gebruiker via Kaarten of de eigen weergave rijdt --
zolang GoKnoop actief blijft (wat sowieso al nodig is), blijft automatische herkenning gewoon
werken.

**Technische kanttekening**: `model` (de route-progress-model) zit in de effect-closure,
niet bereikbaar vanuit de render-body -- een nieuwe `startNodeWgs84Ref` toegevoegd, gevuld op
het moment dat `model` wél in scope is, zodat de render-laag de coördinaten kan gebruiken.

Geen wijziging aan `lib/route-engine/`. 387/387 tests ongewijzigd (pure UI-toevoeging/-tuning,
geen nieuwe testbare pure logica).

### 9.31 "Rit hervatten" hersteld: echte doorstart i.p.v. opnieuw beginnen — ✅ GEBOUWD (30-8-2026)

**Het gat, bevestigd in sectie 9.29**: "Hervat rit" startte de HELE oorspronkelijke route
opnieuw vanaf fase A (rijd naar het eerste knooppunt) -- geen probleem bij een rondje, wel bij
een punt-naar-punt-adres-rit, waar het beginpunt niets met de hervatlocatie te maken heeft.

**Kerninzicht van de fix**: de bestaande matching/afwijkingsdetectie werkt al overal langs de
route, niet uitsluitend vanaf het beginknooppunt -- fase A/B bestaan uitsluitend om "nog niet
op de route" (moet er nog fysiek naartoe) te overbruggen. Bij hervatten is de gebruiker
(waarschijnlijk) al ergens op/bij de route -- dus fase A/B kunnen gewoon worden OVERGESLAGEN,
direct de matching-modus in, en de bestaande, al geteste matching plaatst de gebruiker vanzelf
op de juiste plek langs de route.

**Gebouwd**: drie nieuwe, optionele props op `NavigationScreen`:
- `startInProgress` -- als waar, slaat de allereerste sample fase A/B-bepaling over en start
  de matching direct (`stateMachine.start()` meteen, i.p.v. pas bij aankomst bij het
  beginknooppunt).
- `initialPhysicalStart` -- zaadt `physicalStartRef` met het OORSPRONKELIJKE vertrekpunt (niet
  de hervat-locatie) -- cruciaal, anders zou Back to Start/een volgende pauze de verkeerde
  parkeerplaats gebruiken.
- `initialElapsedRideTimeS` -- telt terug bij het zetten van `sessionStartedAtMsRef`, zodat
  een VOLGENDE pauze de cumulatieve rijtijd toont, niet alleen de tijd sinds hervatten.

**Mooie bijkomstigheid, geen aparte code nodig**: de gereden afstand (voor een eventuele
volgende pauze) hoeft NIET apart opgeteld te worden -- `progressInfo.distanceAlongM` is
POSITIE-gebaseerd (hoe ver langs de route is de huidige gematchte positie), niet een
opgeteld GPS-spoor. Bij hervatten toont dit dus automatisch, vanaf de eerste geslaagde match,
de juiste cumulatieve afstand.

**`app/page.tsx`**: `activeSavedRoute`-state kreeg een optioneel `resumeContext`-veld
(`physicalStart`/`elapsedRideTimeS`), alleen gevuld door `resumePausedRide()` -- de normale
opgeslagen-routes-start (`startSavedRoute`) en gereden-routes-start (`startRiddenRoute`) laten
dit veld leeg, dus die blijven ongewijzigd fase A/B doorlopen zoals altijd.

Geen wijziging aan `lib/route-engine/` of aan de matching-logica zelf (`DeviationDetector`/
`NavigationStateMachine`) -- puur een nieuwe manier om de BESTAANDE matching eerder te laten
starten. 387/387 tests ongewijzigd, `tsc` schoon. Nog geen echte iPhone-validatie van deze
specifieke fix.

### 9.32 ECHTE ROOT CAUSE van de onzichtbare pauzeknop gevonden (30-8-2026)

**De vorige "fix" (sectie 9.26/9.29, vaste `bottom`-waarden bijstellen) loste het probleem
niet structureel op** -- de knop bleef op sommige plekken/rits onzichtbaar (bevestigd met een
screenshot: fase A, "Rijd naar het startpunt", geen pauzeknop zichtbaar, ondanks eerdere
positie-aanpassingen).

**Werkelijke oorzaak, nu wel gevonden**: de knop stond GENEST binnen dezelfde wrapper als de
richtingkaart (`position: absolute, top: 64`, GEEN `bottom`/`height` ingesteld) -- die wrapper
is daardoor alleen zo hoog als haar NORMALE-FLOW-inhoud (in de praktijk: alleen de
richtingkaart zelf, een paar honderd pixels). `bottom: 280` op de knop werd dus gemeten ten
opzichte van DIE kleine wrapper, niet ten opzichte van het echte scherm -- de knop belandde
zo ver BUITEN het zichtbare gebied, ver boven de kaart. Vandaar dat bijstellen van het
`bottom`-getal keer op keer niet hielp: het probleem zat niet in de waarde, maar in de
verkeerde referentie waaraan die waarde gemeten werd.

**Fix**: de knop verplaatst naar een ECHTE BROER van die wrapper (zelfde niveau als de
voortgangsbalk eronder, die wél altijd correct verscheen -- en dat had de aanwijzing moeten
zijn: de voortgangsbalk gebruikt exact dezelfde soort `position: absolute, bottom: X`, maar
dan WEL als broer van de wrapper, niet als kind).

**Les**: bij een herhaald "positie klopt niet"-probleem waarbij bijstellen van het getal niet
helpt, is de structuur (welke ouder is de containing block?) waarschijnlijker de oorzaak dan
de waarde zelf -- dat had bij de tweede mislukte poging al onderzocht moeten worden i.p.v.
een derde keer aan hetzelfde getal te draaien.

387/387 tests ongewijzigd (pure structurele UI-fix), `tsc` schoon.

**Openstaande vraag aan de gebruiker (nog niet gebouwd)**: attributie-icoontje ook
gecentreerd tonen -- moet dat letterlijk midden op het scherm (over de kaartinhoud heen), of
onderaan gecentreerd (i.p.v. rechtsonder in de hoek)? Antwoord nog niet ontvangen.

### 9.33 Deelbare route-link — ✅ GEBOUWD (30-8-2026)

**Architectuurkeuze, expliciet zo besloten**: de route wordt RECHTSTREEKS in de URL
gecodeerd, geen backend-opslag met een Route-ID. GoKnoop heeft bewust geen server-side
gebruikersopslag (geen account-systeem, alles lokaal in `localStorage`) -- een link die naar
een server-ID verwijst zou die architectuur doorbreken en nieuwe privacy-/misbruik-vragen
introduceren. Een link die de route zelf BEVAT levert voor de ontvanger exact hetzelfde
resultaat op (dezelfde route, geen nieuwe berekening), zonder die kosten.

**Gebouwd:**
- `lib/sharing/route-share-link.ts` -- `encodeRouteShareCode`/`decodeRouteShareCode`/
  `buildShareUrl`. URL-veilige base64 (geen `+`/`/`/`=`-tekens die geëscaped zouden moeten
  worden), UTF-8-veilig (Nederlandse namen met bijzondere tekens blijven intact). 6 tests,
  incl. een test die specifiek een payload construeert die anders wél `+`/`/`/`=` zou
  bevatten, om de URL-veilige vervanging daadwerkelijk te bewijzen, niet toevallig te missen.
- **"Delen"-knop** naast "Start route" bij elke opgeslagen route in "Mijn routes" -- gebruikt
  `navigator.share()` (de native iOS-deelfunctie, inclusief WhatsApp), met een
  klembord-kopieer-terugval voor omgevingen zonder die API (bijv. desktop).
- **Landingsflow**: `app/page.tsx` checkt bij het laden op een `?share=`-parameter, decodeert
  'm, resolvet de route via het bestaande `/api/route/resolve` (zelfde patroon als opgeslagen/
  gereden routes -- geen nieuwe server-logica nodig), en toont een VOORBEELDSCHERM -- NIET
  automatisch starten of opslaan. De ontvanger kiest zelf: "Start deze route" of "♡ Bewaar in
  Mijn routes".
- `window.history.replaceState()` na starten/bewaren -- haalt `?share=` uit de URL, voorkomt
  dat verversen de link opnieuw opent.

**Nog NIET gebouwd, bewust apart vervolgtraject (op verzoek)**: automatische, herkenbare
routenaam op basis van plaatsnamen langs de route (bijv. "Rondje Edam -- Volendam"). Vereist
eerst een technische verkenning van een geschikte reverse-geocoding-oplossing (coördinaten →
plaatsnaam -- het omgekeerde van de bestaande plaatsnaam-zoekfunctie) voordat er iets gebouwd
wordt. Voor nu gebruikt de deelbare link de handmatig ingevoerde naam (indien aanwezig) of
toont "Gedeelde route".

Geen wijziging aan `lib/route-engine/`. 393/393 tests (387 + 6 nieuw), `tsc` schoon.
