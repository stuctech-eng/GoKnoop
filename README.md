# GoKnoop

Knooppunt-first fietsrouteplatform. Zie Master Plan v1.0 (CodeSnap) voor de volledige productvisie en architectuur.

**Live:** https://go-knoop.vercel.app

## STATUS (9 september 2026)

```
Phase 1 — Data Foundation           ✅ COMPLETE
Phase 2 — Graph + Route Engine      ✅ COMPLETE (benchmark-onderbouwd)
Phase 3 — Core GoKnoop UX (MVP)     ✅ VALIDATED op echte productiedata
Phase 4 — Navigation                ⬜ nog niet gestart
NWB-netwerkonderzoek                🔄 Fase 2/7 lopend (zie docs/HANDOFF.md 1a)
```

**Belangrijk lopend traject:** GoKnoop onderzoekt een architectuurwijziging (GoKnoop-knooppunten als voorkeurslaag binnen een breder fietsnetwerk, aangevuld met NWB). Dit is een gefaseerd, streng gecontroleerd onderzoeks-/bouwtraject (7 fasen, elke fase apart goedgekeurd vóór de volgende start). Zie **[`docs/HANDOFF.md`](docs/HANDOFF.md)**, sectie 1a, voor de volledige context — begin daar bij een nieuwe sessie.

Voor een volledige, gedetailleerde briefing (bedoeld om een nieuwe ontwikkelsessie snel op snelheid te brengen): zie **[`docs/HANDOFF.md`](docs/HANDOFF.md)**.

Voor de architectuurbeslissingen zelf: **[`docs/phase1b-design.md`](docs/phase1b-design.md)** (databasekeuze, importer, composite-node-clustering, graph-validatie) en **[`docs/phase2-route-engine-design.md`](docs/phase2-route-engine-design.md)** (Route Engine, Location Resolver, RoutePlanner, rondje-generator).

## ARCHITECTUUR IN HET KORT

```
Routedatabank (WFS)
      ↓
Import + normalisatie (Firestore: sourceNodes, edges)
      ↓
Composite-node-resolutie (logicalNodes)
      ↓
Edge-matching (5m tolerantie)
      ↓
Route Engine (Dijkstra, in-memory graph-cache)
      ↓
Location Resolver · RoutePlanner (alternatieven) · Rondje-generator
      ↓
GoKnoop UX (app/page.tsx)
```

**Stack:** Next.js 14 (App Router), TypeScript, Firebase/Firestore, Vercel (Hobby-plan, regio `fra1`), Vitest voor tests.

## SETUP

Environment variables (Vercel → GoKnoop → Settings → Environment Variables):
- `ROUTEDATABANK_URL`, `ROUTEDATABANK_USER`, `ROUTEDATABANK_PASS` — alleen nodig voor een nieuwe import
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` — Firebase Admin SDK
- `DEBUG_SECRET` — beveiligt alle `/api/debug/*` en `/api/import/*`-routes

## TESTEN

```
npm test
```

546+ tests (Vitest, groeit met elke sessie) over de volledige Route Engine-kern: Dijkstra, parallelle edges, constraints, disconnected-gevallen, route-reconstructie, distance-invariant, RoutePlanner-diversiteit, Location Resolver, rondje-generator, navigatie, en (tijdelijk, onderzoek) NWB-analyse.

## PUBLIEKE API

- `POST /api/route` — A→B kortste route
- `POST /api/route/alternatives` — meerdere A→B-alternatieven
- `POST /api/route/loop` — rondje van een gewenste afstand vanaf één startpunt
- `POST /api/location/resolve` — plaatsnaam/GPS → dichtstbijzijnde knooppunten

## PRIVACY & DATA

Routedatabank-data mag niet worden doorgeleverd aan derden. 
