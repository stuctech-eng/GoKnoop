# GoKnoop — Phase 4: Navigation Master Design

**Datum:** 29 augustus 2026
**Status:** ONTWERP — TER REVIEW, NOG NIET GOEDGEKEURD (in tegenstelling tot Phase 2: dit document heeft nog geen externe review gehad. Niet implementeren vóór gezamenlijke review, zoals afgesproken.)
**Basis:** Phase 1 (data, `docs/phase1b-design.md`), Phase 2 (Route Engine, `docs/phase2-route-engine-design.md`), Phase 3 (Core UX, gevalideerd — zie `docs/HANDOFF.md` sectie 1), `lib/route-engine/types.ts`, `lib/route-engine/is-traversable.ts`, `lib/route-engine/location-resolver.ts` (geraadpleegd voor dit ontwerp, niet uit het geheugen aangenomen)

---

## 0. WAAROM EERST EEN ONTWERP, GEEN CODE

Phase 4 is een ander soort stap dan Phase 1–3. Phase 1–3 gingen over een **statisch, herhaalbaar probleem**: dezelfde data, dezelfde graph, dezelfde route-aanvraag levert altijd hetzelfde resultaat op. Phase 4 introduceert voor het eerst **live, niet-herhaalbare invoer** (GPS-signaal van een bewegende fietser) die continu tegen een statisch object (de gekozen `Route`) wordt afgezet. Dat is een fundamenteel andere categorie fouten: race conditions, sensor-ruis, state die "vast" kan lopen, en gedrag dat niet met een simpele unit-test op vaste input te vangen is.

Net als bij Phase 2 geldt: het contract (datamodel, state machine, API-grenzen) eerst vastleggen, dan pas bouwen. Dit document volgt bewust dezelfde structuur en discipline als `docs/phase2-route-engine-design.md`.

**Architectuurprincipe, aangeleverd door de gebruiker en hier als leidend uitgangspunt overgenomen:**

```
Route
  = wat de gebruiker heeft gekozen (statisch, uit Phase 2/3, NOOIT gemuteerd door navigatie)

NavigationSession
  = waar de gebruiker zich nu bevindt
  + voortgang
  + afwijking
  + navigatiestatus
  + eventueel herberekende route
```

Dit voorkomt dat een live GPS-sessie het oorspronkelijke, opgeslagen `Route`-object vervuilt — exact dezelfde reden waarom Phase 1 brondata nooit overschrijft (zie Phase 1B pre-flight-punt 2) en Phase 2 de graph nooit herschrijft naar `bidirectional` (zie Phase 2 sectie 5). Hetzelfde architectuurprincipe, nu toegepast op een nieuwe laag.

---

## 1. SCOPE & EXPLICIET BUITEN SCOPE

**Wel in Phase 4 (MVP), conform HANDOFF sectie 6:**

1. Een `NavigationSession` starten vanaf een bestaande, berekende `Route`
2. Client-side GPS-tracking tijdens het fietsen
3. Positie op de route bepalen (map matching)
4. Huidig knooppunt / volgend knooppunt tonen
5. Afstand tot het volgende knooppunt
6. Routeprogressie (hoever onderweg, hoeveel resterend)
7. Afwijkingsdetectie (rijdt de gebruiker nog op de route?)
8. Herberekening bij bevestigde afwijking, met hysterese tegen te snel/te vaak herberekenen
9. Robuust gedrag bij GPS-ruis, tijdelijke signaalverlies of lage nauwkeurigheid
10. Sessie kunnen pauzeren/hervatten/beëindigen

**Expliciet BUITEN scope van Phase 4 (Master Context sectie 23, ongewijzigd van kracht — zie ook HANDOFF sectie 6, laatste regel):**

- AI-routeassistent
- POI-laag
- Persoonlijke voorkeuren / `RoutePreferences`
- Weerbewuste routes
- E-bike/batterij-integratie
- Samen fietsen (groepsnavigatie, live locatie delen tussen gebruikers)
- Volledige offline-functionaliteit (wél: een toekomstvast *contract*, zie sectie 15 — niet de implementatie)
- Wearables (smartwatch-koppeling)
- Veiligheidslaag (bijv. automatische SOS, valdetectie)
- Route-kwaliteitsscoring, alternatieve-routekeuze tijdens navigatie (dat blijft een Phase 2/3-verantwoordelijkheid, vóór het starten van de sessie)
- Turn-by-turn **spraak**-instructies (audio) — Phase 4 MVP is visueel/tekstueel; audio is een latere uitbreiding op dezelfde `NavigationSession`-state, geen datamodel-wijziging
- Server-side opslag van volledige GPS-tracks (zie sectie 17, privacy)

---

## 2. NAVIGATIONSESSION-DATAMODEL

Aansluitend op het bestaande `Route`-type (`lib/route-engine/types.ts`) en de Phase 2-conventie van expliciete, getypeerde placeholder-velden voor latere fases.

```typescript
export type NavigationState =
  | "NOT_STARTED"
  | "ON_ROUTE"
  | "POSSIBLE_DEVIATION"
  | "OFF_ROUTE"
  | "REROUTING"
  | "REROUTED"
  | "GPS_LOST"
  | "PAUSED"
  | "ARRIVED"
  | "CANCELLED";

export type GpsSample = {
  lat: number;
  lon: number;
  accuracyM: number;          // Geolocation API `coords.accuracy`
  headingDeg: number | null;  // Geolocation API `coords.heading`, null indien onbeschikbaar
  speedMps: number | null;    // Geolocation API `coords.speed`, null indien onbeschikbaar
  timestamp: number;          // epoch ms, van het device, niet van ontvangst
};

/** Resultaat van map matching (sectie 5) — positie geprojecteerd op de routegeometrie. */
export type MatchedPosition = {
  edgeIndex: number;           // index in route.edges[] / route.geometry-segmenten
  segmentT: number;            // 0..1, positie binnen dat geometrie-segment
  point: Point;                // geprojecteerd punt, RD New (zelfde CRS als Route.geometry)
  perpendicularDistanceM: number; // afstand tussen ruwe GPS-positie en dit geprojecteerde punt
  cumulativeDistanceM: number; // afstand vanaf routestart tot dit punt, langs de route
};

export type NavigationSession = {
  id: string;
  routeId: string;              // verwijst naar Route.id — NOOIT een kopie van route-data
  datasetVersionId: string;     // overgenomen van de Route, voor consistentie-checks (sectie 19)
  startedAt: string;
  updatedAt: string;
  state: NavigationState;

  rawPosition: GpsSample | null;        // laatste ruwe GPS-sample
  matchedPosition: MatchedPosition | null; // laatste map-matched positie op de ORIGINELE route

  currentNodeId: string | null;   // laatst gepasseerde logicalNodeId uit route.nodes
  nextNodeId: string | null;      // eerstvolgende logicalNodeId uit route.nodes
  distanceToNextNodeM: number | null;

  progress: {
    distanceTraveledM: number;
    distanceRemainingM: number;
    fractionComplete: number;   // 0..1, afgeleid, geen aparte bron van waarheid
  } | null;

  deviation: {
    perpendicularDistanceM: number;
    sinceTimestamp: number | null; // wanneer de huidige afwijkingsperiode begon, null als ON_ROUTE
  } | null;

  reroute: {
    active: boolean;
    rerouteCount: number;         // hoe vaak deze sessie al herberekend heeft (sectie 11)
    lastRerouteAt: string | null;
    newRoute: Route | null;       // de herberekende Route, NOOIT de originele route overschrijven
  };

  gpsHealth: {
    lastSampleAt: number | null;
    consecutiveLowAccuracyCount: number;
    signalLostSince: number | null; // epoch ms, null als GPS actief is
  };

  offlineContract: NavigationOfflineContract; // sectie 15 — datamodel aanwezig, functionaliteit niet gebouwd

  metadata: {
    startedFromNodeId: string;     // route.nodes[0], vastgelegd bij sessiestart
    targetNodeId: string;          // route.nodes[route.nodes.length - 1]
    deviceInfo: {
      userAgent: string | null;
    };
  };
};
```

**Waarom dit ontwerp:** exact dezelfde reden als bij het `Route`-object in Phase 2 (sectie 6) — elk "nog niet gebouwd"-veld (`offlineContract`, delen van `reroute`) staat er al met een expliciete waarde, niet gewoon afwezig. Dat voorkomt een toekomstige datamodel-rewrite zodra offline-ondersteuning of spraaknavigatie wordt toegevoegd.

---

## 3. RELATIE MET HET BESTAANDE ROUTE-OBJECT

**Kernregel: `NavigationSession` refereert naar `Route` via `routeId`, en muteert het nooit.**

```
Route (Phase 2/3, Firestore of client-side gecached)
   │  immutable zodra opgeslagen — zelfde principe als sourceNodes/edges in Phase 1
   │
   ▼
NavigationSession.routeId → Route.id   (read-only referentie)
   │
   ▼
NavigationSession draagt ZELF alle live/veranderlijke state
```

Concreet betekent dit:

- `route.nodes[]`, `route.edges[]`, `route.geometry` worden **gelezen**, nooit geschreven, tijdens een navigatiesessie.
- Als herberekening nodig is (sectie 10), wordt een **nieuwe** `Route` aangemaakt (via de bestaande Route Engine, `POST /api/route` of een equivalent) en opgeslagen in `NavigationSession.reroute.newRoute` — niet teruggeschreven naar de oorspronkelijke `route.id`.
- `Route.navigation` (het bestaande `null`-placeholder-veld, zie `types.ts`) blijft in Phase 4 MVP nog steeds `null`. Er is bewust **geen** wijziging nodig aan het `Route`-type zelf — de relatie loopt via `NavigationSession.routeId`, niet via een veld ín `Route`. Dit is een expliciete architectuurkeuze: als `Route.navigation` ooit gevuld wordt (bijv. voor een lichte "laatst-bekende-voortgang"-samenvatting bij het heropenen van een opgeslagen route), is dat een aparte, latere beslissing — geen vereiste voor Phase 4.
- Een gebruiker die tijdens navigatie herberekend wordt, "ziet" dus in feite door de `NavigationSession` heen kortstondig een andere `Route`, zonder dat de oorspronkelijke, door de gebruiker gekozen route ooit verandert. Dit maakt "terug naar oorspronkelijke route" (mocht dat ooit een feature worden) triviaal — de data bestaat nog gewoon, ongewijzigd.

---

## 4. GPS-TRACKING: CLIENT-SIDE ALS UITGANGSPUNT

**Beslissing (per gebruikersinstructie): client-side, via de browser's Geolocation API (`navigator.geolocation.watchPosition`).**

Rationale, analoog aan Phase 2 sectie 4 (graph-loadingstrategie — eerst het simpele, correcte pad, optimalisatie pas bij bewezen noodzaak):

| Aspect | Client-side (gekozen) | Server-side alternatief |
|---|---|---|
| Latency | Geen netwerk-round-trip nodig voor elke positie-update | Elke GPS-sample zou naar de server moeten, dan terug |
| Privacy | Positie hoeft nooit het device te verlaten (zie sectie 17) | Server ziet elke ruwe locatie |
| Offline-geschiktheid | Basis voor toekomstige offline-navigatie (sectie 15) | Vereist per definitie een verbinding |
| Batterij | `watchPosition` met verstandige opties (sectie 16) is de standaard-aanpak voor mobiele navigatie-apps | Extra netwerkverkeer kost ook batterij |

**Consequentie voor de architectuur:** map matching, afwijkingsdetectie, progressie-berekening en de state machine (secties 5–14) draaien **in de browser/app**, niet op de server. De server wordt alleen aangeroepen wanneer een echte herberekening nodig is (sectie 18 — hergebruik van de bestaande Route Engine-API).

**Voorbereid, niet nu gebouwd:** een `NavigationEngine`-interface analoog aan `GraphProvider` (Phase 2 sectie 4), zodat de kernlogica (matching, deviation, state machine) niet hard-coded afhankelijk is van de Geolocation API zelf. Dat maakt toekomstige alternatieve bronnen (bijv. een gesimuleerde GPS-track voor tests, sectie 20, of een externe hardware-GPS) mogelijk zonder de kernlogica te wijzigen:

```
GpsSource
 ├── subscribe(callback: (sample: GpsSample) => void): unsubscribe
 └── getLastKnown(): GpsSample | null

Implementaties:
  BrowserGeolocationSource   (MVP — navigator.geolocation.watchPosition)
  SimulatedGpsSource         (test-eerst-strategie, sectie 20)
  toekomstig: externe hardware-bron
```

---

## 5. MAP MATCHING / POSITIE OP ROUTE

**Doel:** een ruwe GPS-positie (WGS84, lat/lon, met meetonzekerheid) omzetten naar een punt ergens ván de routegeometrie — niet zomaar "de dichtstbijzijnde node" (dat is een ander probleem, al opgelost door `resolveNearestNodes()` in Phase 2/3, maar niet geschikt voor continue tracking tijdens het fietsen).

**Stappen:**

1. GPS-sample (WGS84) → RD New via de bestaande `wgs84ToRd()` (`lib/route-engine/coordinate-transform.ts`, al gebruikt door de Location Resolver — hergebruiken, niet dupliceren).
2. De routegeometrie (`route.geometry`, een aaneengesloten lijn opgebouwd uit `route.edges[].geometry`, zie Phase 2 sectie 6) bestaat uit lijnsegmenten. Voor elk segment: bereken de loodrechte projectie van de GPS-positie op dat segment (standaard "closest point on line segment"-berekening, geen externe library nodig — vergelijkbare schaal als de matching-berekeningen uit Phase 1B sectie 5).
3. Kies het segment met de kleinste `perpendicularDistanceM`, **met een venster-beperking**: alleen segmenten rond de laatst bekende `matchedPosition` worden overwogen (bijv. het huidige segment ± N segmenten vooruit), niet de hele route opnieuw. Dit voorkomt twee problemen tegelijk:
   - Performance (een route van 100km heeft honderden segmenten; bij elke GPS-update de hele route doorzoeken is onnodig werk).
   - Correctheid bij lussen/kruisende routes: zonder venster zou een GPS-positie foutief kunnen "springen" naar een ver weg gelegen, toevallig dichtbij liggend stuk van dezelfde route (bijv. bij een rondje dat zichzelf kruist).
4. Resultaat: `MatchedPosition` (sectie 2) — inclusief `cumulativeDistanceM`, nodig voor progressie (sectie 8).

**Expliciete grens, niet nu op te lossen:** als de gebruiker een significant ander pad neemt dan de route (bijv. een straat verderop), levert map matching nog steeds "het dichtstbijzijnde punt op de originele route" — een grote `perpendicularDistanceM`. Dát signaal is precies wat afwijkingsdetectie (sectie 9) gebruikt. Map matching zelf beslist niet of dat een probleem is; dat is een aparte verantwoordelijkheid, met opzet gescheiden (zelfde laagscheiding-principe als `isTraversable()` in Phase 2 sectie 5: één functie, één verantwoordelijkheid).

**Venstergrootte:** te bepalen empirisch bij implementatie (test-eerst, sectie 20) — voorlopig voorstel: het venster schaalt mee met de laatst bekende snelheid (`speedMps` uit de GPS-sample) plus een vaste marge, zodat een stilstaande fietser geen onnodig groot venster krijgt, maar een snelle fietser niet buiten het venster valt tussen twee GPS-updates in.

---

## 6. HUIDIG KNOOPPUNT / VOLGEND KNOOPPUNT

Afgeleid uit `MatchedPosition.edgeIndex` en `route.nodes[]`/`route.edges[]` (die, zoals vastgelegd in Phase 2 sectie 6, altijd in dezelfde volgorde en lengte-relatie staan: `edges.length === nodes.length - 1`).

```
currentNodeId  = route.nodes[edgeIndex]       -- het knooppunt waar de huidige edge vandaan komt
nextNodeId     = route.nodes[edgeIndex + 1]   -- het knooppunt waar de huidige edge naartoe gaat
```

**Randgeval: aankomst.** Zodra `edgeIndex === route.edges.length - 1` én `segmentT` dicht genoeg bij `1.0` ligt (drempel te bepalen, zie sectie 21 acceptatiecriteria), wordt `nextNodeId = null` en de state machine gaat naar `ARRIVED` (sectie 14).

**Randgeval: sessie start midden op een edge (niet exact op `route.nodes[0]`).** Mogelijk als de gebruiker pas GPS-signaal krijgt nadat hij al is vertrokken, of de startlocatie niet exact op het knooppunt lag. `edgeIndex` bij sessiestart wordt dan bepaald door dezelfde map-matching-stap (sectie 5) toegepast op de eerste GPS-sample, zonder venster-beperking (er is nog geen "laatst bekende positie" om een venster omheen te leggen) — dit is de enige uitzondering op de venster-regel uit sectie 5.

---

## 7. AFSTAND TOT VOLGEND KNOOPPUNT

```
distanceToNextNodeM = cumulativeDistanceM(nextNode) - matchedPosition.cumulativeDistanceM
```

Waarbij `cumulativeDistanceM(nextNode)` de vooraf berekenbare, langs-de-route-afstand is vanaf routestart tot dat knooppunt (som van `route.edges[0..edgeIndex].distanceM`, éénmalig te berekenen bij sessiestart en te cachen in de `NavigationSession` — geen reden om dit bij elke GPS-update opnieuw op te tellen vanaf nul).

**Let op, consistent met Phase 2 sectie 3:** dit gebruikt `distanceM` uit de brongeometrie (lengte langs de lijn), nooit de Euclidische afstand tussen de matched-positie en het knooppunt — dezelfde reden als bij de oorspronkelijke Dijkstra-berekening: bij een bochtige edge zou de Euclidische afstand systematisch te kort zijn.

---

## 8. ROUTEPROGRESSIE

```
distanceTraveledM  = matchedPosition.cumulativeDistanceM
distanceRemainingM = route.distanceM - distanceTraveledM
fractionComplete   = distanceTraveledM / route.distanceM
```

**Belangrijk bij herberekening (sectie 10):** na een reroute wijst `route` (binnen de sessie-context) naar `reroute.newRoute`, niet meer naar de oorspronkelijke route. Progressie wordt vanaf dat moment berekend tegen de **nieuwe** route, met `distanceTraveledM` gereset naar de matched-positie op de nieuwe route (die begint bij de huidige positie, niet bij het oorspronkelijke startpunt). De oorspronkelijke route's progressie-cijfers tot het reroute-moment blijven behouden in de sessiegeschiedenis (niet gespecificeerd in dit MVP-contract of dat server-side gelogd wordt — zie sectie 17, privacy-afweging eerst).

---

## 9. AFWIJKINGSDETECTIE

**Basissignaal:** `matchedPosition.perpendicularDistanceM` — de afstand tussen de ruwe (RD-geconverteerde) GPS-positie en het dichtstbijzijnde punt op de route.

**Expliciet NIET het ontwerp (per gebruikersinstructie, en terecht — zie sectie 11 voor de reden):**
```
GPS > X meter van lijn → onmiddellijk nieuwe route.
```

**Wel het ontwerp:** een drempelwaarde (`DEVIATION_THRESHOLD_M`, te kalibreren empirisch — zie sectie 20/21, voorlopig voorstel 25–35m als uitgangspunt voor tests, in dezelfde orde grootte als de Phase 1 node/edge-matchtolerantie van 5m maar ruimer, omdat consumer-GPS typisch een nauwkeurigheid van 5–15m heeft, niet de survey-grade nauwkeurigheid van de brondata) bepaalt alleen **wanneer een afwijkingsperiode begint** — niet wanneer herberekend wordt. Die twee zijn losgekoppeld: zie de state machine in sectie 14.

**Twee aparte constanten, zelfde principe als Phase 1B sectie 5 (matchtolerantie vs. clusterdrempel — nooit samenvoegen tot één generieke waarde):**
```
DEVIATION_THRESHOLD_M        -- wanneer is een positie "niet meer op de route"
DEVIATION_CONFIRM_DURATION_S -- hoe lang moet dat aanhouden vóór het als bevestigd geldt (sectie 11)
```

---

## 10. HERBEREKENING: WANNEER WEL/NIET

**Wel herberekenen:**
- State machine bereikt `OFF_ROUTE` (dus: bevestigde afwijking, niet alleen een enkele ruis-sample — zie sectie 11)
- De gebruiker expliciet "herbereken route" aantikt (handmatige trigger, altijd toegestaan ongeacht de state machine — een gebruiker die weet dat hij bewust afwijkt, hoeft niet te wachten op automatische detectie)

**Niet herberekenen:**
- `POSSIBLE_DEVIATION` (nog niet bevestigd — zie sectie 14)
- Tijdens `REROUTING` zelf (voorkom overlappende herberekeningsaanvragen — zie sectie 11, cooldown)
- Kort ná een `REROUTED`-transitie, binnen de cooldown-periode (sectie 11), zelfs als de afwijking blijft aanhouden — de nieuwe route krijgt eerst de kans om zelf weer "on route" te worden vóór een volgende herberekening serieus wordt genomen
- Bij `GPS_LOST` (er is geen betrouwbare positie om een zinnige herberekening op te baseren — zie sectie 12)

**Herberekeningsaanvraag zelf:** hergebruikt de bestaande Route Engine (sectie 18) — geen nieuw pathfinding-algoritme. `fromLogicalNodeId` wordt de dichtstbijzijnde routeerbare node bij de huidige matched-positie (via `resolveNearestNodes()`, Phase 2/3, die al geïsoleerde nodes uitsluit — zie de Amsterdam-bugfix in Phase 2 sectie 9C, direct herbruikbaar hier), `toLogicalNodeId` blijft het oorspronkelijke doel (`route.nodes[route.nodes.length - 1]`).

**Open vraag voor de gezamenlijke review (bewust hier benoemd, niet stilzwijgend ingevuld):** moet herberekening rekening houden met "niet terug over hetzelfde stuk waar de gebruiker net vandaan komt" (bijv. via `avoidEdgeIds`, al beschikbaar in het Route Engine-contract, sectie 8 van Phase 2)? Dit voorkomt een pingpong-effect waarbij de herberekende route de gebruiker terug over de afgeweken route stuurt. Voorstel: ja, maar dit raakt aan hoeveel van de recent bereden edges vermeden moeten worden — een parameter die eerst empirisch getest moet worden (sectie 20), niet nu vastgelegd als hard getal.

---

## 11. COOLDOWN/HYSTERESE TEGEN VOORTDUREND HERBEREKENEN

Dit is het kernprobleem dat de state machine (sectie 14) oplost. Zonder hysterese leidt GPS-ruis (typisch enkele meters, soms tientallen meters bij slechte ontvangst — tussen gebouwen, onder bomen) tot een fietser die continu tussen "op route" en "van route af" springt, met bijbehorende herberekeningen.

**Twee aparte beschermingsmechanismen, beide nodig:**

1. **Bevestigingsvenster (`DEVIATION_CONFIRM_DURATION_S`):** een enkele GPS-sample boven de afwijkingsdrempel triggert alleen `POSSIBLE_DEVIATION`, niet `OFF_ROUTE`. Pas als de afwijking **aanhoudt** over een tijdvenster (bijv. meerdere opeenvolgende samples, of een vaste duur — te kalibreren, sectie 20/21) wordt de state `OFF_ROUTE` en pas dán volgt een herberekening.

2. **Cooldown na reroute (`REROUTE_COOLDOWN_S`):** ná een succesvolle herberekening (`REROUTED`) start een cooldown-periode waarin een hernieuwde afwijking niet meteen tot weer een herberekening leidt, zelfs als de afwijkingsdrempel opnieuw wordt overschreden. Reden: direct na een reroute is de kans op een korte, tijdelijke mismatch tussen GPS en de nieuwe route (bijv. terwijl de nieuwe route nog "inlaadt" in de UI) hoger, en een fietser die net een nieuwe route kreeg, heeft tijd nodig om die daadwerkelijk te gaan volgen.

**Beide constanten zijn te kalibreren tegen gesimuleerde GPS-tracks (sectie 20), niet nu als hard getal vast te leggen — dit document legt het *mechanisme* vast, niet de exacte waarden.**

---

## 12. WAT ER GEBEURT BIJ ONNAUWKEURIGE OF WEGVALLENDE GPS

**Onnauwkeurige samples (hoge `accuracyM`):** een GPS-sample met een `accuracyM` boven een drempel (`GPS_ACCURACY_THRESHOLD_M`, te kalibreren) wordt **niet gebruikt voor map matching of afwijkingsdetectie**, maar telt wel mee voor `gpsHealth.consecutiveLowAccuracyCount`. De laatst bekende, wél voldoende nauwkeurige `matchedPosition` blijft actief getoond (met een visuele indicatie dat de positie mogelijk verouderd is — een UI-verantwoordelijkheid, niet dit document).

**Tijdelijk signaalverlies:** als er langer dan een drempel (`GPS_TIMEOUT_S`) geen nieuwe sample binnenkomt, gaat de state naar `GPS_LOST` (sectie 14). In deze state:
- Geen afwijkingsdetectie, geen herberekening (er is simpelweg geen betrouwbare data om op te reageren)
- De laatst bekende `matchedPosition`, `currentNodeId`, `progress` blijven zichtbaar (gebruiker ziet "laatste bekende positie", niet een lege/foutieve state)
- Zodra een nieuwe, voldoende nauwkeurige sample binnenkomt: terug naar `ON_ROUTE` of `POSSIBLE_DEVIATION`, afhankelijk van waar die nieuwe positie zich bevindt — geen aparte "hervat"-logica nodig, de normale matching-stap (sectie 5) handelt dit al af. **Uitzondering:** als de nieuwe positie ver buiten het laatst gebruikte matching-venster ligt (bijv. na een lang signaalverlies waarin de fietser is doorgereden), valt de matching terug op de venstervrije aanpak uit sectie 6 (randgeval sessiestart) — hetzelfde mechanisme hergebruikt, geen nieuwe logica.

**Nooit:** een automatische herberekening puur op basis van signaalverlies zelf. Signaalverlies is geen bewijs van afwijking.

---

## 13. RICHTING/HEADING EN EVENTUEEL SNELHEID

**Gebruik van `headingDeg` (indien beschikbaar via de Geolocation API):**
- Disambiguatie bij map matching wanneer een GPS-positie ongeveer even dicht bij twee verschillende segmenten van de route ligt (bijv. bij een scherpe bocht of een plek waar de route zichzelf kruist) — de segmentrichting die het beste overeenkomt met de bewegingsrichting van de fietser krijgt voorrang.
- UI-weergave (pijl "deze kant op") — buiten scope van dit document (Route Engine/navigatielogica, geen UI-ontwerp).

**Niet betrouwbaar aanwezig:** `headingDeg` is `null` bij lage snelheid of stilstand (de meeste GPS-chips kunnen koers alleen afleiden uit beweging). **Fallback:** koers afleiden uit de laatste twee `matchedPosition`-punten zelf (vector tussen vorige en huidige matched-positie), alleen wanneer `headingDeg` ontbreekt én er voldoende afgelegde afstand is tussen de twee samples om een betrouwbare richting te bepalen (te klein verschil → ruis, niet gebruiken).

**Gebruik van `speedMps`:**
- Input voor de dynamische venstergrootte bij map matching (sectie 5).
- Mogelijk input voor het bevestigingsvenster (sectie 11) — een stilstaande fietser (bijv. gestopt bij een verkeerslicht, net buiten de route) hoeft niet dezelfde tijdsdrempel te doorlopen als een snel bewegende fietser die daadwerkelijk wegrijdt. **Voorstel, te valideren bij implementatie:** niet nu als harde regel vastleggen, wel als expliciete kalibratie-vraag meenemen in sectie 20/21.

---

## 14. NAVIGATION STATE MACHINE

**Basis, per gebruikersinstructie, hier uitgewerkt tot een volledige machine inclusief de randgevallen uit secties 6/12:**

```
                    ┌─────────────┐
                    │ NOT_STARTED │
                    └──────┬──────┘
                           │ sessie gestart, eerste GPS-fix ontvangen
                           ▼
                    ┌─────────────┐
              ┌────▶│  ON_ROUTE   │◀────┐
              │     └──────┬──────┘     │
              │            │ afwijking gedetecteerd (sectie 9)
              │            ▼            │
              │  ┌──────────────────┐   │ afwijking verdwijnt vóór bevestiging
              │  │POSSIBLE_DEVIATION│───┘
              │  └─────────┬─────────┘
              │            │ afwijking bevestigd (sectie 11, DEVIATION_CONFIRM_DURATION_S)
              │            ▼
              │     ┌─────────────┐
              │     │  OFF_ROUTE  │
              │     └──────┬──────┘
              │            │ herberekening gestart (sectie 10)
              │            ▼
              │     ┌─────────────┐
              │     │  REROUTING  │
              │     └──────┬──────┘
              │      succes│  │ mislukt (sectie 19 — netwerkfout, 422, etc.)
              │            │  └──────────────▶ terug naar OFF_ROUTE (retry-beleid, sectie 19)
              │            ▼
              │     ┌─────────────┐
              └─────│  REROUTED   │  (cooldown actief, sectie 11)
                    └─────────────┘
                    (na cooldown: normale ON_ROUTE/POSSIBLE_DEVIATION-detectie hervat,
                     nu tegen de NIEUWE route)

Onafhankelijke, "overlay"-transities (kunnen vanuit vrijwel elke actieve state optreden):

  * → GPS_LOST     (sectie 12, GPS_TIMEOUT_S overschreden)
  GPS_LOST → *      (nieuwe sample: terug naar de state die past bij de nieuwe positie)

  * → PAUSED        (gebruiker pauzeert expliciet)
  PAUSED → *         (gebruiker hervat: normale detectie vanaf de huidige positie)

  ON_ROUTE → ARRIVED  (sectie 6, aankomst-randgeval)

  * → CANCELLED       (gebruiker beëindigt de sessie expliciet)
```

**Expliciet vastgelegd:**
- `POSSIBLE_DEVIATION → ON_ROUTE` is een geldige transitie (afwijking was tijdelijk/ruis) — dit is precies het mechanisme dat voorkomt dat GPS-ruis tot een herberekening leidt.
- `REROUTING` is een tussentoestand, geen "permanente" state — de sessie kan hier niet blijven hangen zonder tijdslimiet (zie sectie 19, foutafhandeling: een herberekeningsaanvraag die te lang duurt of faalt, moet expliciet terugvallen naar `OFF_ROUTE`, niet oneindig blijven wachten).
- `ARRIVED` en `CANCELLED` zijn eindstadia — geen transities weg van deze states binnen dezelfde sessie (een nieuwe navigatie start een nieuwe `NavigationSession`).
- `PAUSED` en `GPS_LOST` zijn beide "overlay"-achtig, maar niet identiek: `PAUSED` is een bewuste gebruikersactie (sessie blijft geldig, gebruiker verwacht geen updates), `GPS_LOST` is onbedoeld (sessie blijft geldig, systeem probeert actief te herstellen). Ze worden bewust als aparte states gemodelleerd, niet samengevoegd — een UI zou ze anders moeten tonen (bijv. `PAUSED` toont een pauze-icoon, `GPS_LOST` toont een waarschuwing).

---

## 15. OFFLINE-ARCHITECTUUR ALS TOEKOMSTVAST CONTRACT

**Niet nu bouwen — wel het datamodel voorbereiden, zelfde principe als de placeholder-velden in het Phase 2 `Route`-object.**

```typescript
export type NavigationOfflineContract = {
  offlineCapable: false;          // MVP: altijd false, veld bestaat al voor toekomst
  cachedRouteGeometry: null;      // toekomst: route.geometry lokaal opgeslagen (bijv. IndexedDB)
  cachedRegionBounds: null;       // toekomst: welk gebied is gedownload voor offline gebruik
  lastSyncedAt: null;
};
```

**Waarom dit relevant is voor Phase 4, ook al wordt het nu niet gebouwd:** de architectuurkeuze uit sectie 4 (client-side GPS-tracking, client-side map matching) is een **randvoorwaarde** voor offline-navigatie later — als matching/afwijkingsdetectie server-side had gedraaid, zou offline-ondersteuning een fundamentele herarchitectuur vereisen. Nu niet: alleen `route.geometry` zelf (al een simpel, serialiseerbaar array van coördinaten) hoeft ooit lokaal gecached te worden, de rest van de navigatielogica werkt al zonder netwerkafhankelijkheid (behalve sectie 18's herberekeningsaanvraag, die bij offline-gebruik vanzelfsprekend niet beschikbaar is — een expliciete beperking, geen bug).

---

## 16. PERFORMANCE/BATTERIJ

**`watchPosition`-configuratie (Geolocation API `PositionOptions`):**
- `enableHighAccuracy: true` tijdens een actieve navigatiesessie (nodig voor bruikbare map matching) — bewust een batterij-afweging die de gebruiker impliciet accepteert door navigatie te starten, net zoals andere fietsnavigatie-apps.
- Geen vaste `timeout`/`maximumAge` hier voorgeschreven — te kalibreren bij implementatie tegen echte devices (buiten scope van een ontwerpdocument om hier al een hard getal te claimen zonder meting, conform KERNPRINCIPES sectie 1: geen aannames).

**Throttling van verwerkte updates:** niet elke ruwe GPS-sample hoeft de volledige matching/deviation/state-machine-cyclus te doorlopen. Voorstel: een minimale tijd- en/of afstandsdrempel tussen verwerkte updates (bijv. "verwerk een nieuwe sample alleen als er ≥N meter of ≥M seconden verstreken zijn sinds de vorige verwerkte sample"), met een uitzondering voor de eerste sample na een langere pauze. Exacte waarden: empirisch te bepalen (sectie 20/21), niet hier vastgelegd als aanname.

**Vermijd continue re-renders:** de `NavigationSession`-state wordt bijgewerkt per verwerkte GPS-sample, niet per losse berekeningsstap — UI-laag (buiten dit document) kan zelf bepalen hoe vaak ze daadwerkelijk herrendert.

**Wake lock:** een navigatiesessie op een telefoonscherm dat uitgaat, kan `watchPosition` laten pauzeren (browser/OS-afhankelijk gedrag, niet door GoKnoop zelf te garanderen). Dit is een bekende PWA/iOS-beperking (zie sectie 13 van HANDOFF/Master System: "iOS: pushnotificaties vereisen beginscherminstallatie" — vergelijkbare categorie beperking). **Niet nu op te lossen, wel expliciet te benoemen als bekende grens van dit MVP**, geen stilzwijgende aanname dat navigatie op de achtergrond feilloos doorloopt.

---

## 17. PRIVACY: LOCATIEGEGEVENS ZO VEEL MOGELIJK LOKAAL

**Uitgangspunt, consistent met de architectuurkeuze in sectie 4:** ruwe GPS-samples, matched-posities en de volledige state machine-voortgang blijven **client-side**, in het geheugen van de `NavigationSession` op het device van de gebruiker. Er is in dit MVP-contract **geen** server-side opslag van:
- Individuele GPS-samples of -tracks
- De volledige geschiedenis van state-transities binnen een sessie
- `NavigationSession`-documenten zelf, als doorlopend opgeslagen server-side collectie

**Enige moment waarop locatiedata de client verlaat:** een herberekeningsaanvraag (sectie 18) — en dan alleen de **huidige, dichtstbijzijnde routeerbare node** (via `resolveNearestNodes()`, dus al vertaald van een ruwe coördinaat naar een `logicalNodeId`), niet de ruwe GPS-coördinaat zelf of de tracking-geschiedenis. Dit is een bewuste dataminimalisatie: de Route Engine-API heeft nooit meer nodig dan een `fromLogicalNodeId`, exact zoals het bestaande contract (Phase 2 sectie 7) al voorschrijft — Phase 4 introduceert hier geen nieuw, ruimer server-contract.

**Open vraag voor review:** als een toekomstige feature (buiten Phase 4 MVP) ooit "sla mijn gereden route op" wil aanbieden, is dat een **expliciete, aparte opt-in-beslissing** op een later moment — niet iets wat dit ontwerp alvast impliciet mogelijk maakt door de datastructuur ruimer te maken dan nodig. `NavigationSession` zoals hier ontworpen is bewust een **vluchtig, sessiegebonden object**, geen historisch archief.

---

## 18. API-CONTRACTEN — ALLEEN WAAR SERVERCOMMUNICATIE ECHT NODIG IS

**Consistent met sectie 4/17: de meeste navigatielogica heeft geen eigen server-endpoint nodig.** Er is precies één punt waar Phase 4 de server raakt:

```
Herberekening (sectie 10) — HERGEBRUIKT het bestaande contract, geen nieuw endpoint:

POST /api/route
Body:
  {
    fromLogicalNodeId: string,   // dichtstbijzijnde routeerbare node bij de huidige matched-positie
    toLogicalNodeId: string,     // ongewijzigd: het oorspronkelijke doel
    constraints?: {
      avoidEdgeIds?: string[]    // optioneel, zie sectie 10's open vraag over "niet terug hetzelfde stuk"
    }
  }

Response: Route  (zie Phase 2 sectie 6 — ongewijzigd contract)
```

**Geen nieuw endpoint voor:**
- Het starten/bijwerken/beëindigen van een `NavigationSession` — dit is client-side state (sectie 17). Als een toekomstige feature ooit sessies server-side wil kunnen hervatten op een ander device, is dát een expliciete, latere uitbreiding met een eigen privacy-afweging (zie sectie 17's open vraag) — geen onderdeel van dit MVP-contract.
- Map matching, afwijkingsdetectie, progressie — allemaal client-side berekend (secties 5, 8, 9), geen server-roundtrip nodig.

**Waarom dit bewust minimaal is:** elk extra endpoint is een extra plek waar locatiedata de client zou verlaten (privacy, sectie 17) en een extra netwerkafhankelijkheid (die de offline-toekomstvastheid, sectie 15, zou ondermijnen). Het herberekeningscontract is de enige plek waar dat compromis onvermijdelijk is — de Route Engine's graph staat niet op het device.

---

## 19. FOUT- EN RECOVERY-SCENARIO'S

Expliciet, geen stille failures (zelfde principe als Phase 2 sectie 7's 404/422-contract):

| Scenario | Gedrag |
|---|---|
| Herberekeningsaanvraag faalt (netwerkfout, 5xx) | State blijft `REROUTING` gedurende een beperkte retry-poging (aantal/timeout te kalibreren); bij definitief falen: terug naar `OFF_ROUTE`, gebruiker ziet expliciete melding "herberekenen mislukt, probeer opnieuw" — nooit stil terugvallen naar `ON_ROUTE` alsof er niets aan de hand is |
| Herberekeningsaanvraag geeft 422 (`disconnected`/`no_traversable_edges`/`all_paths_blocked_by_constraints`, zie Phase 2 sectie 7) | Zelfde principe: terug naar `OFF_ROUTE` met de specifieke `reason` doorgegeven aan de UI-laag — een gebruiker die zich op een geïsoleerde node bevindt (Phase 1 sectie 7: 389 zulke nodes bestaan) heeft recht op een begrijpelijke foutmelding, niet een oneindige `REROUTING`-spinner |
| `datasetVersionId` van de actieve dataset wijzigt tijdens een lopende sessie (nieuwe import geactiveerd, zie Phase 1B sectie 8) | De lopende sessie blijft de originele `Route` en `datasetVersionId` gebruiken tot expliciete beëindiging — een sessie switcht nooit stilzwijgend van dataset-versie halverwege. Een herberekeningsaanvraag ván die sessie gebruikt dus nog steeds de oude `datasetVersionId`, ook al is de live dataset inmiddels gewijzigd — consistentie binnen de sessie weegt zwaarder dan altijd de nieuwste data gebruiken. **Openstaande vraag voor review:** is dit acceptabel, of moet een dataset-wijziging tijdens navigatie een expliciete gebruikersmelding triggeren? Niet hier stilzwijgend besloten. |
| Browser/OS weigert Geolocation-toestemming | Sessie kan `ON_ROUTE`-detectie nooit starten — expliciete foutstate nodig (niet in de huidige `NavigationState`-enum opgenomen; **toe te voegen bij review**: bijv. `PERMISSION_DENIED` als aparte state, of behandelen als een permanente vorm van `GPS_LOST` — te beslissen, hier bewust niet stilzwijgend ingevuld) |
| App/tab wordt gesloten tijdens een actieve sessie | Sessie is client-side (sectie 17) — bij een volledige sluiting gaat de sessie verloren, geen server-side hervatpunt in dit MVP-contract. Bewuste consequentie van de privacy-eerst-keuze, niet een over het hoofd geziene bug — expliciet te communiceren aan de gebruiker (UI-verantwoordelijkheid) |

---

## 20. TEST-EERST-STRATEGIE MET GESIMULEERDE GPS-TRACKS

Zelfde discipline als Phase 2's "Volgende stap"-sectie: eerst de kernlogica bewijzen tegen bekende, gecontroleerde input, dan pas een echte GPS/UI eromheen bouwen.

```
1. Graph-fixture hergebruiken (dezelfde kleine, handmatige testgraph als Phase 2 sectie "Volgende stap")
        ↓
2. Een vaste, handmatig samengestelde Route op die fixture (bekende nodes/edges/geometry)
        ↓
3. SimulatedGpsSource (sectie 4) — een vooraf gedefinieerde reeks GpsSample's, met tijdstempels,
   die een fietser simuleert die exact de route volgt
        ↓
4. Map matching op die reeks → verwachte matchedPosition/currentNode/nextNode/progress,
   met de hand berekend en vergeleken
        ↓
5. Een tweede simulatie: GPS-ruis toegevoegd (kleine willekeurige afwijkingen rond de route)
   → verwacht: state blijft ON_ROUTE / POSSIBLE_DEVIATION, GEEN OFF_ROUTE, GEEN herberekening
   (dit is de kern-test voor sectie 11's hysterese — het scenario dat de gebruiker expliciet
   benoemde als risico)
        ↓
6. Een derde simulatie: een bewuste, aanhoudende afwijking (bijv. een parallelle straat)
   → verwacht: POSSIBLE_DEVIATION → (na confirm-venster) OFF_ROUTE → REROUTING → REROUTED,
   binnen een verwacht aantal samples/tijdvenster
        ↓
7. Een vierde simulatie: signaalverlies (gat in de sample-reeks) → verwacht: GPS_LOST,
   daarna herstel zodra samples hervatten
        ↓
8. Een vijfde simulatie: lage-nauwkeurigheid-samples (hoge accuracyM) tussen goede samples
   → verwacht: lage-nauwkeurigheid-samples genegeerd voor matching, gpsHealth-teller omhoog
        ↓
9. Kalibratie van de nog open constanten (DEVIATION_THRESHOLD_M, DEVIATION_CONFIRM_DURATION_S,
   REROUTE_COOLDOWN_S, GPS_ACCURACY_THRESHOLD_M, GPS_TIMEOUT_S, matching-venstergrootte)
   TEGEN deze gesimuleerde scenario's — dezelfde aanpak als Phase 1's threshold-sensitivity-analyse
   (phase1b-design.md sectie 6), nu toegepast op tijd/afwijking in plaats van ruimtelijke clustering
        ↓
10. Pas dán: koppeling aan een echte `BrowserGeolocationSource` en UI
        ↓
11. Pas dán: veldtest met een echte fietsrit (analoog aan Phase 3's Amsterdam-praktijktest,
    Phase 2 sectie 9C) — een reëel scenario ving daar een echte bug (geïsoleerde startnode)
    die geen enkele fixture-test had voorzien; dezelfde verwachting hier voor GPS-specifieke
    edge cases (bijv. tunnel-signaalverlies, dichte bebouwing)
```

**Waarom dit belangrijker is dan bij Phase 1–3:** live sensordata is per definitie niet volledig te voorspellen. Het doel van gesimuleerde tracks is niet "elk mogelijk GPS-gedrag dekken" (onmogelijk), maar wél: bewijzen dat de state machine en hysterese-mechanismen **doen wat ze beloven** op bekende, reproduceerbare input, vóór ze worden blootgesteld aan echte, niet-reproduceerbare ruis.

---

## 21. ACCEPTANCE CRITERIA

**Voor Phase 4 MVP als "klaar voor validatie" geldt (analoog aan Phase 2/3's expliciete GO-criteria):**

1. Een `NavigationSession` kan gestart worden vanaf een bestaande `Route`, zonder dat `Route` zelf ooit wijzigt (verifieerbaar: `route`-object identiek vóór en ná een volledige navigatiesessie, inclusief een reroute).
2. Map matching produceert een `matchedPosition` binnen een gedefinieerde foutmarge (te kalibreren, sectie 20) tegen bekende gesimuleerde tracks.
3. `currentNodeId`/`nextNodeId`/`distanceToNextNodeM`/`progress` zijn intern consistent: `progress.distanceTraveledM === matchedPosition.cumulativeDistanceM`, en de node-sequence komt overeen met `route.nodes[]` (zelfde soort invariant-test als Phase 2 sectie 6's distance-invariant, nu toegepast op `NavigationSession`).
4. GPS-ruis (gesimuleerd, binnen realistische consumer-GPS-marges) leidt **niet** tot een herberekening — dit is de kern-acceptatiecriterium die de gebruiker expliciet als risico benoemde.
5. Een bevestigde, aanhoudende afwijking leidt wél tot herberekening, binnen een acceptabele tijd/afstand (exacte grens: te kalibreren, niet hier als hard getal beweerd zonder meting).
6. Ná een reroute wordt de oorspronkelijke `Route` niet overschreven; `reroute.newRoute` bevat een volwaardig, zelfstandig `Route`-object dat aan hetzelfde Phase 2-contract voldoet (inclusief de distance-invariant).
7. Signaalverlies en herstel worden correct gedetecteerd en getoond zonder dat de sessie "vastloopt" in `GPS_LOST` na herstel van het signaal.
8. Elk foutscenario uit sectie 19 heeft een gedefinieerd, getest eindresultaat — geen scenario eindigt in een undefined/onbeschreven state.
9. Alle nieuwe code doorstaat `tsc` en `vitest run` vóór "klaar" (zelfde discipline als HANDOFF sectie 3, les 9).

---

## 22. EXPLICIETE "NIET NU BOUWEN"-LIJST

Ter aanvulling op sectie 1 (buiten scope), specifiek de dingen die tíjdens het ontwerpen van dit document als verleiding naar voren kwamen maar bewust niet zijn opgenomen:

- **Server-side sessie-persistentie/hervatten-op-ander-device** — zie sectie 17/18, expliciete latere beslissing
- **Automatische snelheids-/tijdmodel-gebaseerde ETA** (`durationEstimate` op het Route-object staat al op `null` sinds Phase 2 — blijft zo)
- **Turn-by-turn spraak/audio-instructies** — bouwt ooit voort op dezelfde state machine, geen onderdeel van dit contract
- **Multi-device/groepsnavigatie** (Master Context: "samen fietsen", expliciet uitgesloten)
- **Adaptieve herberekening die rekening houdt met routekwaliteit/voorkeuren** (`RoutePreferences` bestaat nog niet, Master Context sectie 23)
- **Precomputed/geoptimaliseerde map-matching-datastructuren** (bijv. een spatial index specifiek voor navigatie) — pas te overwegen als sectie 20/21 een concreet performance-probleem aantoont op een echt device, zelfde "niet vooruitlopen op onbewezen optimalisatie"-principe als Phase 2 sectie 4
- **Volledige offline-navigatie-implementatie** — sectie 15 legt alleen het contract vast
- **Achtergrond-navigatie (scherm uit, app op achtergrond) als gegarandeerde functionaliteit** — sectie 16 benoemt dit expliciet als bekende, niet-opgeloste grens

---

## STATUS: WACHT OP GEZAMENLIJKE REVIEW

Dit document legt het functionele en architecturale contract van Phase 4 vast, inclusief een aantal expliciet open vragen (sectie 10, 17, 19) die bewust niet zijn dichtgeredeneerd zonder gezamenlijke beslissing. Geen implementatie totdat dit gereviewd is — zelfde volgorde als Phase 2 (`docs/phase2-route-engine-design.md`, sectie 0/10).
