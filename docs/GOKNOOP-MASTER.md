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
Phase 4   — Navigation UI                ⬜ stap 12, nog niet gestart — dit document legt de scope vast
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

### 5.4 Start Guidance (🆕 NIEUW, als benoemd UX-concept)

Bij vertrek is de richting vaak onzeker (geen bewegingsrichting om op te varen, GPS-heading nog onbetrouwbaar bij lage snelheid — zie `lib/navigation/matching/candidate-matcher.ts`, headingcost-logica). Daarom een **aparte, nadrukkelijkere begeleiding bij het eerste knooppunt**, die overgaat naar de normale richtingaanwijzer zodra:
- de gebruiker daadwerkelijk in beweging is (via `speedMps`/opeenvolgende matched-posities, dezelfde signalen die de matcher al gebruikt — geen nieuwe databron), én
- er een betrouwbare bewegingsrichting is vastgesteld.

Dit is een concrete toepassing van **"overgang van kompas naar bewegingsrichting"**: vóór beweging een kompas-achtige indicatie (waar is knooppunt 42 t.o.v. waar ik nu sta), ná beweging een gewone voorwaartse richtingaanwijzer.

### 5.5 GPS-koers pas betrouwbaar gebruiken bij beweging (BESTAAND BESLUIT, architectuur al zo gebouwd)

Sluit direct aan op wat de candidate matcher al doet: `headingDeg` is nullable en wordt pas meegewogen als signaal wanneer het er is; bij stilstand levert de Geolocation API vaak geen (betrouwbare) heading. Geen nieuwe logica nodig — de UI moet dit gedrag alleen visueel volgen (Start Guidance, sectie 5.4), niet zelf een aparte heading-fallback bouwen.

### 5.6 Wat hier WEL gebouwd wordt (stap 12, deze fase)

- Richtingscherm (niveau 1)
- Noordgerichte kaart met route + positie + komende knooppunten (niveau 2)
- Voortgangsweergave (niveau 3)
- Start Guidance-overgang
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

## 6. TEST- EN ACCEPTANCECRITERIA VOOR STAP 12

1. Elk van de drie informatieniveaus (richting/kaart/voortgang) is gelijktijdig zichtbaar zonder scrollen, op een standaard iPhone-schermformaat.
2. De richtingaanwijzer (niveau 1) update binnen één GPS-sample-cyclus na een matched-position-wijziging — geen merkbare vertraging t.o.v. wat de debugharness al toont.
3. Start Guidance is actief bij sessiestart en schakelt aantoonbaar over naar de normale richtingaanwijzer zodra er een betrouwbare bewegingsrichting is (test met een gesimuleerde track die stilstand simuleert gevolgd door beweging, hergebruik `track-builder.ts`/`SimulatedGpsSource` uit stap 1).
4. De kaart toont noord altijd boven, ook tijdens beweging in een andere richting (visuele regressietest/handmatige check).
5. Voor minimaal de states `ON_ROUTE`, `POSSIBLE_DEVIATION`, `OFF_ROUTE`, `GPS_LOST`, `PERMISSION_DENIED`, `ARRIVED` bestaat een onderscheidbare visuele weergave (screenshot- of storybook-achtige verificatie per state, met gesimuleerde data — geen echte GPS nodig voor deze check).
6. Progress-weergave (niveau 3) komt exact overeen met wat `calculateProgress`/`ProgressTracker` teruggeven — geen aparte, dubbele berekening in de UI-laag.
7. Wake Lock-status is voor de gebruiker niet noodzakelijk zichtbaar (dat was een debugharness-behoefte, geen productie-UX-eis) — wél moet de UI zelf Wake Lock aanvragen/vrijgeven op dezelfde momenten als de harness al doet (sectie 3.4).
8. Alle nieuwe code: `tsc` schoon + waar zinvol testbaar (React-componenten met React Testing Library, of gelijkwaardig — te bepalen bij implementatie, geen bestaande conventie hiervoor in de repo).

---

## 7. EXACTE IMPLEMENTATIEVOLGORDE VOOR STAP 12

Zelfde discipline als Phase 4's engine-opbouw (stap 1-11): eerst een klein, geïsoleerd stuk bewijzen, dan uitbreiden — niet in één keer een compleet scherm bouwen.

```
12.1  Statische layout/wireframe van de drie niveaus (geen live data, geen GPS) --
      visuele/interactie-review vóórdat er logica aan gekoppeld wordt
12.2  Koppeling niveau 3 (voortgang) aan gesimuleerde data (SimulatedGpsSource,
      hergebruik van stap 1/10's testinfrastructuur) -- eenvoudigste niveau eerst
12.3  Koppeling niveau 1 (richting) aan gesimuleerde data, incl. Start Guidance-logica
12.4  Koppeling niveau 2 (kaart) -- vereist een kaartlibrary-keuze (nog niet gemaakt in
      dit document, te beslissen bij start van stap 12: welke library, hoe de
      noordgerichte weergave en route-geometrie erop getekend wordt)
12.5  Alle drie niveaus samen, nog steeds gesimuleerde data, volledige state-doorloop
      (ON_ROUTE -> POSSIBLE_DEVIATION -> OFF_ROUTE -> REROUTING -> REROUTED -> ARRIVED)
12.6  Koppeling aan echte iPhone-GPS (BrowserGeolocationSource, al gebouwd) --
      eerste echte-toestel-validatie van de UI zelf, los van de al-gevalideerde engine
12.7  Integratie in de bestaande Phase 3-flow (na routekeuze, "Start navigatie"-knop
      leidt hierheen) -- pas als 12.1-12.6 zelfstandig bewezen zijn
```

**Vóór 12.1 begint:** vaststellen welke kaartlibrary gebruikt wordt (stap 12.4 heeft dit nodig) — dit document legt dat nog niet vast, dat is de eerste openstaande beslissing bij het starten van deze fase.
