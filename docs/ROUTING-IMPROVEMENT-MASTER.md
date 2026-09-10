# GoKnoop — Routingverbetering: Master-traject-document

**Gestart:** 9 september 2026 · **Status:** actief traject, meerdere fasen in uitvoering
**Doel van dit document:** een volledig nieuwe Claude-chat moet dit hele traject kunnen reconstrueren en zelfstandig voortzetten, zonder de oorspronkelijke chatgeschiedenis nodig te hebben.

**Statusonderscheid, overal in dit document strikt gehanteerd:**
`RESEARCH` → `DESIGNED` → `IMPLEMENTED` → `TESTED` → `DEPLOYED`

**Belangrijk, vooraf:** op het moment van schrijven is **geen enkele regel productiecode gewijzigd**. Alle onderzoek leeft in `lib/nwb-analysis/`, `app/debug/*`, `app/api/debug/*`. De productie-route-engine gebruikt niets hiervan. Dit onderscheid moet gedurende het hele traject expliciet blijven.

---

## STATUSOVERZICHT (bijgewerkt bij elke fase)

| Onderdeel | RESEARCH | DESIGNED | IMPLEMENTED | TESTED | DEPLOYED |
|---|---|---|---|---|---|
| NWB als aanvullende laag | PASS | — | — | — | NEE |
| Connectorlaag | PASS | — | — | — | NEE |
| Combined graph | PASS | — | — | — | NEE |
| Cost model (F-factor) | PASS | — | — | — | NEE (kandidaat: 1,20–1,25) |
| Route-kwaliteitsvalidatie | PASS | JA | JA (onderzoek) | JA (35 tests) | NEE |
| Valhalla-fallback | **PASS (dit document)** | NEE | gedeeltelijk (adapter bestaat, ongebruikt) | contract-only, niet live | NEE |
| Productie-integratie (totaal) | — | — | — | — | **NEE** |

---

## FASE-LOG

### FASE: A — Valhalla feasibility
**DATUM:** 9 september 2026
**STATUS:** PASS
**DOEL:** vaststellen of Valhalla als onafhankelijke validator/fallback zinvol is, en of dit nu prioriteit moet krijgen.

**INPUT:**
- Bestaande, al eerder gebouwde `lib/local-bike-router/valhalla-adapter.ts` + `valhalla-adapter.test.ts` (8 september 2026, vóór het NWB-onderzoek).
- Actueel webonderzoek naar Valhalla self-hosting, licentie, operationele complexiteit (9 september 2026).
- Bestaande testset (Amsterdam-Hilversum, Volendam-Amsterdam, Lochem, 337km-anomalie, 22 Fase 5B-paren).

**UITGEVOERD:**
1. Bestaande adapter-code gelezen (niet aangenomen dat die klopt/compleet is).
2. Bestaande tests gelezen: contract-tests met gemockte responses, bevestigd géén live Valhalla-server ooit aangeroepen.
3. Webonderzoek: licentie, self-hosting-vereisten (Docker), resourcebehoefte voor een regionale (Nederland-schaal) extract, publieke-demo-server-beperkingen.

**RESULTATEN:**
- **Licentie:** Valhalla-engine zelf is MIT-licentie (zeer permissief). De onderliggende OSM-data is ODbL (share-alike + attributie-verplichting) — een aparte, relevante licentie-laag, los van de engine.
- **Self-hosting:** goed gedocumenteerd, Docker-gebaseerd. Voor een single-country-extract (Nederland past in deze categorie) wordt 4–8GB RAM als typisch genoemd — niet in de buurt van de 16–64GB die voor een planet-wide graph nodig is.
- **Tile-build:** regionale builds zijn proportioneel sneller dan de 4–12 uur die voor een volledige planet-build wordt genoemd — voor Nederland alleen vermoedelijk in de orde van minuten tot een uur, niet dagen.
- **Publieke demo-server** (`valhalla.openstreetmap.de`) heeft een harde rate-limit (1 call/gebruiker/sec, 100 totaal) — expliciet NIET geschikt voor productiegebruik door een echte app met meerdere gebruikers.
- **Architecturale mismatch met de huidige GoKnoop-infrastructuur:** Valhalla vereist een permanent draaiend serverproces (Docker-container), wat fundamenteel niet past bij Vercel Hobby (serverless, geen persistente compute). Dit is dezelfde constatering als in het allereerste architectuurrapport van deze onderzoeksreeks ("Optie C+D vereisen permanente server → financiële beslissing nodig") — nu opnieuw bevestigd, niet toevallig.

**TESTS:**
- Geen nieuwe tests toegevoegd in deze fase (puur onderzoek/documentatie). Bestaande 8 contract-tests in `valhalla-adapter.test.ts` blijven ongewijzigd en groen.

**BELANGRIJKE CIJFERS:**
- Self-hosting resourcebehoefte (single-country extract): 4–8GB RAM, storage proportioneel klein t.o.v. planet-wide (90–150GB).
- Publieke-server rate-limit: 1 req/s/gebruiker, 100 req/s totaal.

**BEVESTIGDE HYPOTHESES:**
- Valhalla is technisch een realistische, niet-buitensporig zware self-hosting-optie voor een Nederland-schaal dataset.

**VERWORPEN HYPOTHESES:**
- "Valhalla kan zonder aanvullende infrastructuur binnen de bestaande Vercel Hobby-opzet draaien" — VERWORPEN. Vereist een aparte, permanente server.

**BLOKKADE (technisch, geen keuze):** er bestaat op dit moment geen live, self-hosted Valhalla-instantie. Een volledige empirische vergelijking (daadwerkelijke routeafstanden/-kwaliteit van Valhalla tegen de testset) kan daarom nu niet worden uitgevoerd. Dit is de enige reden waarom dit onderdeel niet 100% empirisch is afgerond — conform de eigen regel van deze opdracht ("technisch geblokkeerd door ontbrekende toegang") is dit gemeld, niet omzeild met een aanname.

**BESLUIT:** zie DECISION LOG hieronder.

**PRODUCTIE GEWIJZIGD:** NEE

**VOLGENDE STAP:** Fase B — architectuur (dit document, hieronder).

---

## DECISION LOG

### DECISION: Valhalla — NO-GO voor nu, architectuur blijft open
**DATUM:** 9 september 2026
**CONTEXT:** Fase A-onderzoek (hierboven).
**PROBLEEM:** moet Valhalla nu als productieprioriteit worden opgepakt naast/i.p.v. de al bewezen GoKnoop+NWB+connector+cost+validation-architectuur?
**OPTIES:**
1. GO — nu self-hosting opzetten en Valhalla als fallback integreren.
2. NO-GO — architectuur laten staan zoals ontworpen (`RoutingProvider`-abstractie, bestaande adapter), infrastructuur later opzetten wanneer nodig.
3. Volledig afzien van Valhalla.

**BEWIJS:**
- De reeds bewezen architectuur (GoKnoop + NWB + gevalideerde connectors + cost model + route-kwaliteitsvalidatie) heeft in het onderzoek alle geteste probleemgevallen zelf al opgelost of correct gedetecteerd (Amsterdam-Hilversum, Lochem, de 337km-anomalie).
- Valhalla's toegevoegde waarde is daarmee op dit moment primair theoretisch: een vangnet voor gevallen die de eigen architectuur niet aankan — geen geval daarvan is in het onderzoek tot nu toe daadwerkelijk aangetroffen.
- Self-hosting is technisch haalbaar maar vereist een aparte, permanente server — een infrastructuur-/kostenbeslissing die losstaat van de routinglogica zelf, en niet nodig is om de rest van de architectuur (Fase B-D) te ontwerpen of te testen.
- Geen empirische data beschikbaar (zie blokkade hierboven) om een concrete kwaliteitsvergelijking te maken.

**BESLUIT:** NO-GO als huidige prioriteit. De architectuur (`RoutingProvider`-interface, bestaande `ValhallaAdapter`) blijft **expliciet open** voor toekomstige activering — geen code verwijderd, geen deur dichtgedaan. Conform de opdracht ("Bij NO-GO: ga automatisch verder zonder Valhalla") wordt nu doorgegaan naar Fase B zonder Valhalla als onderdeel van de kernarchitectuur.

**REDEN:** de bestaande, al bewezen architectuur lost de bekende problemen zelfstandig op. Een aparte server opzetten voordat er een concreet, aangetoond gat is dat alleen Valhalla kan dichten, zou voorbarige infrastructuurkosten en -complexiteit toevoegen zonder aangetoonde noodzaak.

**GEVOLGEN:**
- Fase B (architectuur) ontwerpt de fallback-laag WEL generiek genoeg om Valhalla later alsnog aan te sluiten (`RoutingProvider`-interface blijft de aansluiting), maar de interne validatielaag (route-kwaliteitsvalidatie, al gebouwd) is de PRIMAIRE fallback-trigger, niet Valhalla zelf.
- Als productie-gebruik ooit een geval oplevert waarin de interne architectuur structureel tekortschiet (bijvoorbeeld: validatie wijst een route af, en er is geen intern alternatief), is dát het concrete signaal om dit besluit te heropenen — niet een vooraf ingeschatte behoefte.

**STATUS:** definitief voor dit traject, tenzij nieuwe productiedata dit besluit expliciet noodzaken te heroverwegen.

---

## DATASET REGISTER (aangevuld, niet herhaald uit eerdere documentatie)

| Dataset | Bron | Versie/datum | Status |
|---|---|---|---|
| GoKnoop/Routedatabank | Firestore, `uINZ3y2QsgBdEyky3duq` | actief sinds voor dit traject | Baseline, ongewijzigd |
| NWB (Hilversum/Lochem/Volendam) | PDOK WFS, CC0 | verzameld 8-9 september 2026 | Onderzoek, niet in productie |
| Valhalla/OSM | n.v.t. — geen dataset verzameld, geen live instantie | — | Niet van toepassing (NO-GO) |

---

*Dit document wordt gedurende het hele traject aangevuld, nooit met terugwerkende kracht overschreven.*

---

### FASE: B — Architectuur
**DATUM:** 9 september 2026
**STATUS:** PASS
**DOEL:** de definitieve architectuur vastleggen, gebaseerd op wat vandaag al gebouwd EN empirisch getest is — geen nieuw ontwerp vanaf nul, maar formalisering van bewezen code.

**INPUT:** `lib/nwb-analysis/combined-graph.ts` (525 regels, 15 tests), `lib/nwb-analysis/connector-candidates.ts` (10 tests), `lib/nwb-analysis/route-quality.ts` (35 tests, empirisch getoetst tegen echte routes), `lib/nwb-analysis/bridge-finder.ts` (5 tests).

**UITGEVOERD:** bestaande, al-geteste modules samengevoegd tot één samenhangend architectuurbeeld; geen nieuwe code geschreven in deze fase.

**RESULTATEN — de definitieve dataflow:**

```
ROUTE REQUEST (origin, destination)
        │
        ▼
┌───────────────────────────────────┐
│ CombinedGraph                      │
│  = GoKnoop-graaf (ongewijzigd)     │
│  + NWB Set B (geclassificeerd)     │
│  + gevalideerde connectors         │
│    (alleen high/lower, nooit       │
│     rejected -- Fase 3)            │
└───────────────────────────────────┘
        │
        ▼
dijkstraWithCostModel(graph, from, to, makeCostFn(F_nwb, F_connector))
  -- kosten (padkeuze) en distanceM (werkelijke afstand) ALTIJD gescheiden
        │
        ▼
┌───────────────────────────────────┐
│ evaluateRouteQuality()             │
│  hard: deviationFactor > 3,5       │
│  zacht: deviationFactor > 2,5 EN   │
│         switchesPerKm > 0,2        │
└───────────────────────────────────┘
        │
   ┌────┴────┐
   ▼         ▼
PASS       FAIL
   │         │
   ▼         ▼
gebruiker   interne fallback
            (Valhalla: NO-GO, zie Fase A --
             niet aangesloten)
```

**Datamodel (reeds geïmplementeerd, `combined-graph.ts`):**
- `CombinedEdge.source`: `"goknoop" | "nwb" | "connector"` — optioneel veld, bestaande GoKnoop-edges blijven werken zonder wijziging (backward-compatible, bevestigd door de 5 oorspronkelijke `buildCombinedGraph`-tests die na alle latere wijzigingen nog steeds slagen).
- `ValidatedConnectorInput`: koppelt een specifiek GoKnoop-knooppunt aan een specifiek NWB-segment-eindpunt, met `confidence: "high" | "lower"` — nooit blinde nabijheid (Fase 3-besluit, hier herbevestigd als definitief).

**Waarom dit robuust is — samenvatting van vandaag se bewijs:**
1. Kostenmodel wiskundig begrensd (D_g ≤ D_n × F) — bewezen in `combined-graph.test.ts`, empirisch bevestigd op 5+22 echte routeparen (Fase 5/5B).
2. Connectorlaag: drie criteria samen (afstand, echt-eindpunt, richtingscompatibiliteit) — nooit één criterium alleen. Visueel gedeeltelijk bevestigd (6 steekproef-gevallen, Fase 3).
3. Validatielaag: vangt de enige bekende anomalie (337km) zonder ook maar één van de 27 bekende gezonde routes af te wijzen — GEEN route-specifieke code, uitsluitend generieke drempels (deviationFactor, switchesPerKm).

**TESTS:** geen nieuwe -- deze fase hergebruikt de bestaande 55+ tests in `lib/nwb-analysis/` als bewijs.

**BEVESTIGDE HYPOTHESES:** "de architectuur kan volledig uit reeds bewezen onderzoekscode worden geformaliseerd, zonder herontwerp" — bevestigd.

**BESLUIT:** deze architectuur is definitief voor het vervolg van het traject (Fase C-N). Wijzigingen hierop vereisen een nieuwe Decision Log-entry, geen stilzwijgende aanpassing.

**PRODUCTIE GEWIJZIGD:** NEE

**VOLGENDE STAP:** Fase C — F-factor definitief kalibreren.

---

### FASE: C — F-factor definitief
**DATUM:** 9 september 2026
**STATUS:** PASS
**DOEL:** een definitieve F-waarde kiezen, onderbouwd met bestaande data (Fase 5/5B), geen nieuwe verzameling.

**INPUT:** Fase 5B-aggregatie over 22 schone routeparen (drie regio's), F=1,10 t/m 1,50.

**UITGEVOERD:** marginale-toename-analyse per F-stap (hoeveel extra GoKnoop-aandeel en hoeveel extra afstandskosten levert elke volgende stap op).

**RESULTATEN:**

| F | Gem. GoKnoop-aandeel | Δ t.o.v. vorige stap | Gem. deviationFactor | Δ t.o.v. vorige stap |
|---|---|---|---|---|
| 1,10 | 9,8% | — | 1,18 | — |
| 1,15 | 17,8% | **+8,0pp** | 1,20 | +0,02 |
| 1,20 | 24,1% | **+6,3pp** | 1,21 | +0,01 |
| 1,25 | 24,6% | **+0,5pp** | 1,22 | +0,01 |
| 1,30 | 28,5% | +3,9pp | 1,24 | +0,02 |
| 1,40 | 32,9% | +4,4pp | 1,26 | +0,02 |
| 1,50 | 40,5% | +7,6pp | 1,28 | +0,02 |

**Cruciale waarneming:** de stap van 1,20 naar 1,25 levert vrijwel niets op (+0,5pp) — een duidelijke uitzondering tussen twee stappen die allebei wél substantieel bijdragen (+6,3pp resp. +3,9pp). Dat is het "elleboogpunt": bij F=1,20 is het punt van afnemende meeropbrengst al bereikt; verder verhogen naar 1,25 kost evenveel (afstand blijft vrijwel gelijk oplopen) maar levert nauwelijks extra GoKnoop-voorkeur op.

**BESLUIT: F_nwb = 1,20** (productie-kandidaat, geen absolute garantie tegen toekomstige heroverweging).

**REDEN:**
1. Datagedreven elleboogpunt — de kwantitatief zwakste stap in de hele reeks is precies 1,20→1,25, wat 1,20 tot het efficiëntste punt maakt (bijna evenveel voorkeur als 1,25, tegen dezelfde kosten).
2. Kleinere F = minder ingrijpen in de natuurlijke kortste-padkeuze — bij twee bijna-gelijkwaardige opties heeft de conservatievere waarde de voorkeur.
3. Ruimschoots binnen het empirisch bewezen veilige gebied (geen absurde omwegen tot minstens F=20 in de kernroutes, zie Fase 4/5).

**Connector-kosten:** F_connector = 1,0 (neutraal) — Fase 5 toonde dat connector-kosten (0,5×-2×) vrijwel geen effect hebben op routekeuze bij deze schaal (connectors zijn typisch een paar meter lang). Geen verdere afstemming nodig.

**TESTS:** hergebruikt de bestaande empirische Fase 5B-data-tests; geen nieuwe tests (dit is een parameterkeuze, geen nieuwe logica).

**BEVESTIGDE HYPOTHESES:** "een elleboogpunt is kwantitatief aanwijsbaar in de bestaande data" — bevestigd.

**VERWORPEN:** F=1,25 als "vanzelfsprekend middelpunt" — de data wijst specifiek naar 1,20 als efficiënter punt, niet naar het midden van het eerder genoemde 1,20-1,25-bereik.

**PRODUCTIE GEWIJZIGD:** NEE — dit is een gedocumenteerde parameterkeuze, nog niet in productiecode toegepast.

**VOLGENDE STAP:** Fase D — route-validatie generiek bevestigen.

---

### FASE: D — Route-validatie generiek bevestigd
**DATUM:** 9 september 2026
**STATUS:** PASS
**DOEL:** aantonen dat `evaluateRouteQuality()` (reeds gebouwd, 35 tests) generiek is — geen kennis van specifieke knopen/routes, kan onbekende toekomstige anomalieën detecteren.

**UITGEVOERD:** code-inspectie van `lib/nwb-analysis/route-quality.ts` tegen het expliciete verbod uit de opdracht ("mag NIET specifiek weten van VQdRuD4Ms8f0sigZTCWP, 337 km, of één specifieke route").

**RESULTATEN:** bevestigd — de functie-signatuur accepteert uitsluitend `{distanceM, straightLineDistanceM, switchCount}`, drie generieke getallen. Geen enkele node-ID, route-naam of regio-specifieke waarde komt in de implementatie voor. De 35 tests demonstreren dit generieke gedrag tegen 27+ verschillende, echte routes zonder dat de functie ooit hoefde te weten welke route het betrof.

**BESLUIT:** Fase D is hiermee direct PASS — er was geen nieuwe code nodig, alleen bevestiging dat de bestaande implementatie al aan de eis voldoet.

**PRODUCTIE GEWIJZIGD:** NEE

**VOLGENDE STAP:** Fase E — productie-audit. **Dit is de eerste fase waarin daadwerkelijk de bestaande productiecode gelezen wordt** (nog niet gewijzigd) — een kwalitatief andere stap dan alles hiervoor, expliciet als zodanig gemarkeerd conform sectie 30/31 van de opdracht.

---

### FASE: E — Productie-audit (kerndataflow bevestigd)
**DATUM:** 9 september 2026
**STATUS:** PASS (kerndataflow) — bredere audit (caching-gedrag in de praktijk, client-side consumptie, deployment-specifics) nog niet uitgeput, zie "volgende stap".
**DOEL:** de daadwerkelijke productiecode lezen, niet aannemen.

**UITGEVOERD:** `app/api/route/route.ts`, `lib/route-engine/route-engine.ts`, `lib/route-engine/cached-graph-provider.ts` gelezen (letterlijke code, niet uit documentatie afgeleid).

**RESULTATEN — bevestigde, echte productie-dataflow:**

```
POST /api/route
  { fromLogicalNodeId, toLogicalNodeId, constraints? }
        │
        ▼
config/activeDataset (Firestore) → datasetVersionId opzoeken
        │
        ▼
CachedGraphProvider(datasetVersionId).load()
  -- module-niveau in-memory cache, warme aanvraag snel,
     cold start laadt opnieuw (bevestigd, geen aanname)
        │
        ▼
computeRoute() → findShortestPath() (lib/route-engine/dijkstra.ts)
  -- PLAIN Dijkstra, edge.distanceM rechtstreeks als kosten
        │
        ▼
buildRoute() → Route-object → 200 OK
```

**Bevestigd, niet aangenomen:**
- **Geen NWB** in deze dataflow. Geen enkele import van `lib/nwb-analysis/*` in `app/api/route/route.ts` of `route-engine.ts`.
- **Geen `BridgeAugmentedGraphProvider`, geen `ENABLE_NETWORK_BRIDGES`** in de productie-API — de eerder (vóór dit NWB-traject) gebouwde Bridge Layer is dus, net als NWB, niet actief. Bevestigt de eerdere documentatie hierover.
- **Geen kostenmodel, geen route-validatie** — `findShortestPath` gebruikt uitsluitend `edge.distanceM`, identiek aan de "F=1,0-baseline" uit het onderzoek.
- Dit betekent: de productie-app geeft op dit moment voor Amsterdam→Hilversum letterlijk de bekende 366,9km-omweg, ongefilterd, aan de gebruiker.

**BESLUIT:** de kerndataflow is voldoende in kaart gebracht om Fase F (productie-data-infrastructuur) technisch te kunnen ontwerpen. De bredere audit-punten (exacte client-side routeconsumptie, caching-gedrag onder productiebelasting, deployment-pipeline-details) zijn nog niet uitgeput.

**PRODUCTIE GEWIJZIGD:** NEE — uitsluitend gelezen, niets aangepast.

**VOLGENDE STAP:** Fase F — NWB productie-data-infrastructuur (dataset-versionering, reproduceerbaarheid) ontwerpen; daarna pas daadwerkelijke productiecode-wijzigingen (Fase G-I), telkens met volledige test/typecheck/build-verificatie zoals de rest van vandaag.

---

### FASE: F — Productie-data-infrastructuur (ontwerp)
**DATUM:** 9 september 2026
**STATUS:** PASS (ontwerp) — nog geen implementatie, dat is bewust Fase G/H.
**DOEL:** NWB gecontroleerd, reproduceerbaar en met rollback-mogelijkheid in productie kunnen krijgen — zonder nu al daadwerkelijk te schrijven naar productie-Firestore.

**UITGEVOERD:** het bestaande, in Fase E bevestigde GoKnoop-dataset-versioneringspatroon (`config/activeDataset` → `datasetVersionId`, zie `app/api/import/activate-dataset/route.ts`) hergebruikt als sjabloon — geen nieuw patroon verzonnen.

**ONTWERP:**

```
config/activeNwbDataset  (nieuw Firestore-document, naast het bestaande activeDataset)
  { nwbDatasetVersionId: string, activatedAt, activatedBy }

nwbDatasetVersions/{nwbDatasetVersionId}  (nieuwe collectie -- metadata, geen segmenten)
  {
    bron: "PDOK WFS, service.pdok.nl/rws/nwbwegen",
    licentie: "CC0 -- bevestigd rechtstreeks uit GetCapabilities, Fase 2",
    opgehaaldOp: ISO-datum,
    regios: string[],
    setAClassificatie: "bstCode=FP",
    setBClassificatie: "FP+HR+RB, excl. motorways/buslanes",
    segmentCount: number,
    reproduceerbaar: true,
  }

nwbSegments/{nwbDatasetVersionId}/segments/{segmentId}  (subcollectie, SLIM formaat)
  -- exact het formaat dat vandaag al bewezen veilig is voor Firestore
     (id, bstCode, wegnummer, straatnaam, from, to, lengthM) --
     GEEN volledige geometrie, zelfde reden als de eerdere 413-fix.
```

**Rollback:** simpelweg `config/activeNwbDataset.nwbDatasetVersionId` terugzetten naar een eerdere waarde — geen data wordt ooit verwijderd, exact hetzelfde rollback-mechanisme als GoKnoop's bestaande `activeDataset`.

**Reproduceerbaarheid:** elke `nwbDatasetVersions`-entry legt vast onder welke voorwaarden (bron, licentie, regio's, classificatieregels, datum) de data is verzameld -- een toekomstige her-verzameling produceert een NIEUWE versie-ID, overschrijft nooit een bestaande.

**Secrets:** PDOK WFS vereist geen API-sleutel (publieke, CC0-dienst) — bevestigd in Fase 2 van vandaag. Geen secret-management nodig voor deze specifieke bron.

**Datasetupdate:** NWB wordt periodiek (maandelijks, bevestigd in Fase 2) bijgewerkt door RWS. De hierboven ontworpen versionering ondersteunt dit direct: een nieuwe collectieronde produceert een nieuwe `nwbDatasetVersionId`, activeren is een enkele documentwijziging.

**BESLUIT:** dit ontwerp is definitief voor Fase G/H (daadwerkelijke implementatie). Nog geen Firestore-schema daadwerkelijk aangemaakt in productie.

**PRODUCTIE GEWIJZIGD:** NEE — uitsluitend ontwerp, geen schema aangemaakt, geen data geschreven.

**VOLGENDE STAP:** Fase G — connectors productieklaar maken (implementatie, met volledige tests/typecheck/build).

---

### BELANGRIJKE, NIEUW ONTDEKTE BEPERKING (tijdens ontwerp Fase G/H)
**DATUM:** 9 september 2026
**GEVONDEN TIJDENS:** ontwerp van de productie-route-engine-integratie.

**HET PROBLEEM:** alle vandaag verzamelde NWB-data (`SlimNwbSegment`) bevat bewust alleen eindpunten + lengte, geen volledige geometrie — een bewuste keuze om de eerdere 413-payloadfout en Firestore-documentgrootte-limiet te vermijden. Dat is voldoende voor alles wat vandaag onderzocht is: afstand, topologie, connectiviteit, kostenmodel, validatie.

**Het is NIET voldoende voor productie-navigatie.** Een gebruiker die een route via NWB krijgt, moet de daadwerkelijke lijn op de kaart kunnen zien en volgen — daarvoor is de volledige polylijn-geometrie van elk NWB-segment nodig, niet alleen de twee eindpunten.

**GEVOLG VOOR DIT TRAJECT:** de productie-integratie die nu volgt (Fase G-I) kan een route se **afstand, samenstelling (GoKnoop/NWB/connector-aandeel) en kwaliteitsoordeel** correct berekenen en teruggeven — dat is direct bruikbaar en testbaar. Maar de **daadwerkelijke, volgbare geometrie** voor het NWB-deel van zo'n route kan nog niet worden geleverd zonder een aanvullende, nieuwe dataverzamelingsronde die WEL de volledige geometrie bewaart (met een andere opslagstrategie dan vandaag, om de eerdere 413/documentgrootte-problemen niet te herintroduceren).

**BESLUIT:** dit wordt expliciet als open punt vastgelegd, niet stilzwijgend genegeerd. Fase G-I worden nu gebouwd met dit scope-onderscheid expliciet zichtbaar in de API-respons (`geometryAvailable: boolean` per route-segment-type), zodat niemand — inclusief een toekomstige Claude-sessie — kan aannemen dat dit al opgelost is.

**STATUS:** open, apart te plannen na Fase I.

---

### FASE: G/H/I — Connectors + cost routing + validatie, productiecode (samengevoegd, praktische reden)
**DATUM:** 9 september 2026
**STATUS:** PASS
**DOEL:** de bewezen architectuur (Fase B) daadwerkelijk als productiecode implementeren — additief, zonder de bestaande `/api/route` te wijzigen.

**WAAROM SAMENGEVOEGD:** connectors, kostenmodel en validatie worden in één route-berekening gebruikt; drie aparte, halfwerkende deploys zou geen zelfstandig bruikbare functionaliteit opleveren. Elk sub-besluit is wel apart gelogd (zie hieronder).

**GEBOUWD (nieuw, niets bestaands gewijzigd):**
- `lib/route-engine/combined-route-engine.ts` — nieuwe, aparte module. Gebruikt de al-bewezen `buildValidatedCombinedGraph`, `dijkstraWithCostModel`, `makeCostFn`, `evaluateRouteQuality` (allemaal vandaag eerder al gebouwd en getest in `lib/nwb-analysis/`) — geen nieuwe kernlogica, uitsluitend samengevoegd tot één productie-entrypoint.
- `app/api/route/combined/route.ts` — nieuw, apart API-eindpunt (`POST /api/route/combined`).

**VEILIGHEIDSEIGENSCHAPPEN, EXPLICIET GEVERIFIEERD:**
- `git status` bevestigt: uitsluitend nieuwe bestanden, **`app/api/route/route.ts` (bestaand) is geen byte gewijzigd**.
- **Veilige degradatie**: als `config/activeNwbDataset` nog niet bestaat (het huidige geval — Fase F is ontwerp, nog geen data gevuld), gebruikt het nieuwe eindpunt gewoon lege NWB/connector-lijsten en gedraagt zich als GoKnoop-only. Geen crash, geen onverwacht gedrag.
- Bestaande volledige testsuite: **612/612 slaagt** (was 606 vóór deze fase, +6 nieuw) — bevestigt dat niets bestaands brak.
- `tsc --noEmit`: exit 0.
- Productie-build: geslaagd, nieuw eindpunt correct gecompileerd als serverless function (bevestigd in de build-output).

**Fase G — connectors (sub-besluit):** productie-opslagschema ontworpen (Fase F), maar de daadwerkelijke connector-generatie-batchjob (analoog aan de bestaande `generate-bridges`-generator) is nog NIET gebouwd — de nieuwe API leest een lege lijst als de `nwbConnectors`-collectie niet bestaat. **Open deelpunt.**

**Fase H — cost routing (sub-besluit):** `F_nwb = 1,20`, `F_connector = 1,0` toegepast (Fase C-besluit), geverifieerd via een expliciete test (`bevestigt de definitieve, Fase-C-gekozen productiewaarden`).

**Fase I — validatie (sub-besluit):** `evaluateRouteQuality` rechtstreeks geïntegreerd — een afgewezen route geeft HTTP 422 met de reden, nooit een stilzwijgend geaccepteerde slechte route. Getest met een nagebouwd 337km-achtig scenario (synthetisch, zelfde deviationFactor-orde-grootte) dat daadwerkelijk wordt afgewezen door de productie-module zelf.

**TESTS:** 6 nieuwe tests (`combined-route-engine.test.ts`): productiewaarden-check, node-not-found, disconnected, normale-route-geaccepteerd, anomalie-afgewezen, computeTimeMs-aanwezig.

**BEVESTIGDE HYPOTHESES:** "de architectuur kan additief, zonder regressie, als productiecode geïmplementeerd worden" — bevestigd, met bewijs (git status + volledige testsuite + build).

**PRODUCTIE GEWIJZIGD:** **JA, voor het eerst vandaag** — maar uitsluitend nieuwe, ongebruikte code totdat (a) deze zip daadwerkelijk gepusht wordt, EN (b) `config/activeNwbDataset` daadwerkelijk wordt aangemaakt met echte data. Tot die tijd is dit nieuwe eindpunt aanwezig maar functioneel identiek aan GoKnoop-only.

**OPEN PUNTEN VOOR VERVOLG:**
1. Connector-generatie-batchjob (Fase G, technische implementatie) nog te bouwen.
2. NWB-data daadwerkelijk in productie-Firestore krijgen (Fase F, technische uitvoering van het ontwerp).
3. Geometrie-beperking (zie eerder) nog niet opgelost.
4. Dit nieuwe eindpunt is nog nergens door de UI aangeroepen — dat is bewust, en een aparte, latere beslissing.

**VOLGENDE STAP:** Fase J — productieregressies (dezelfde bekende testgevallen via de ECHTE `/api/route/combined` draaien, zodra er NWB-data beschikbaar is om tegen te testen).

---

### FASE: G (vervolg) — NWB-migratietooling naar productie
**DATUM:** 9 september 2026
**STATUS:** PASS (tooling gebouwd en geverifieerd) — MIGRATIE ZELF NOG NIET UITGEVOERD (vereist een bewuste actie door Te via de nieuwe pagina).
**DOEL:** het eerste open punt uit Fase G/H/I oplossen: de al-verzamelde, al-gevalideerde onderzoeksdata (drie regio's, ~144k segmenten) naar het Fase F-productieschema krijgen — GEEN nieuwe PDOK-aanroepen.

**GEBOUWD:**
- `app/api/admin/migrate-nwb-to-production/route.ts` — schrijft een chunk segmenten naar `nwbSegments/{nwbDatasetVersionId}/segments/*`, maakt bij de eerste chunk ook `nwbDatasetVersions/{id}` (metadata) aan.
- `app/api/admin/activate-nwb-dataset/route.ts` — **bewust apart** van het schrijven van data: zet `config/activeNwbDataset`. Rollback = simpelweg opnieuw aanroepen met een eerdere versie-ID.
- `app/debug/migrate-nwb-runner/page.tsx` — leest de drie regio's uit `nwbResearchTiles` (onderzoeks-collectie, al bestaand), dedupliceert, migreert in chunks van 400. Activeren is een aparte tweede knop, verschijnt pas na een geslaagde migratie.

**VEILIGHEIDSEIGENSCHAPPEN:**
- `git status`: alleen nieuwe bestanden + de hub-pagina (link toegevoegd) — niets bestaands gewijzigd.
- 612/612 tests slagen, tsc exit 0, productie-build geslaagd, beide nieuwe eindpunten correct gecompileerd.
- **"Schrijven" en "live zetten" zijn twee aparte, bewuste stappen** — een gemigreerde dataset heeft geen enkel effect op `/api/route/combined` totdat de activatie-knop expliciet wordt ingedrukt.
- Geen nieuwe PDOK-aanroepen — puur een overzetting van al-gevalideerde data.

**BELANGRIJK, NOG NIET GEDAAN:** de daadwerkelijke migratie is nog niet uitgevoerd — dat vereist dat Te de code eerst pusht en dan de pagina daadwerkelijk gebruikt. Dit is bewust: het daadwerkelijk vullen van productie-Firestore met ~144k nieuwe documenten is een reële, niet-triviale actie die een expliciete handeling verdient, niet een stille bijwerking van het schrijven van code.

**PRODUCTIE GEWIJZIGD:** NEE (nog niet — de tooling bestaat, is niet uitgevoerd).

**VOLGENDE STAP:** zodra de migratie + activatie daadwerkelijk zijn uitgevoerd, kan Fase G (connector-generatie) en daarna Fase J (productieregressies) tegen echte productie-NWB-data worden getest.

---

### FASE: G (afronding) — Connector-generator productieklaar
**DATUM:** 9 september 2026
**STATUS:** PASS (tooling gebouwd en geverifieerd) — UITVOERING WACHT OP de migratie+activatie hierboven.
**DOEL:** het tweede open punt uit Fase G/H/I oplossen: connectoren daadwerkelijk kunnen genereren en opslaan tegen productie-NWB-data, zodra die er is.

**GEBOUWD:**
- `app/api/admin/goknoop-bearings-national/route.ts` — landelijke variant (geen regio-beperking) van het onderzoeks-eindpunt.
- `app/api/admin/read-active-nwb-segments/route.ts` — cursor-gebaseerde paginering (niet offset — bij ~144k documenten blijft dit snel, waar offset-paginering zou vertragen naarmate de offset groeit).
- `app/api/admin/save-nwb-connectors/route.ts` — slaat alleen niet-afgewezen connectoren op, gebatched.
- `app/debug/generate-nwb-connectors-runner/page.tsx` — brengt alles samen: landelijke GoKnoop-richtingen + actieve NWB-data ophalen, `generateConnectorCandidates` (dezelfde, al-geteste onderzoeksfunctie) client-side draaien, resultaat opslaan.

**Consistent hergebruik, geen nieuwe kernlogica:** deze fase voegt uitsluitend haal/schrijf-eindpunten toe; de daadwerkelijke connector-validatielogica is letterlijk dezelfde, vandaag al 10x geteste `generateConnectorCandidates`-functie uit `lib/nwb-analysis/connector-candidates.ts`.

**VEILIGHEIDSEIGENSCHAPPEN:**
- 612/612 tests, tsc exit 0, build geslaagd.
- `git status`: alleen nieuwe bestanden + twee documentatie-updates — niets bestaands gewijzigd.
- Als `config/activeNwbDataset` nog niet bestaat, geeft `read-active-nwb-segments` een duidelijke 404 ("eerst migreren + activeren") — geen crash, geen stille lege data.

**PRODUCTIE GEWIJZIGD:** NEE (tooling klaar, nog niet uitgevoerd — wacht op de migratie).

**VOLGENDE STAP:** zodra Te de migratie + activatie + connector-generatie daadwerkelijk heeft uitgevoerd (drie handelingen, elk bewust apart), is Fase J (productieregressies tegen echte data) mogelijk.

---

### FASE: J — Productieregressies (echte /api/route/combined)
**DATUM:** 9 september 2026
**STATUS:** PASS
**DOEL:** de bekende testgevallen draaien tegen het ECHTE, live productie-eindpunt — geen onderzoekstool meer.

**INPUT:** productie-migratie (144k NWB-segmenten) + activatie + connector-generatie (1.178 opgeslagen) waren op dit moment al door Te uitgevoerd.

**RESULTATEN — bewezen in echte productie, niet meer onderzoek:**

| Testgeval | Oorspronkelijk | Productie (`/api/route/combined`) | deviationFactor | Status |
|---|---|---|---|---|
| Amsterdam → Hilversum | 366,9 km | **29.978 m** | 1,18 | ACCEPTED |
| Volendam → Amsterdam | ~25,2 km (gezond) | 19.927 m | 1,13 | ACCEPTED |
| Lochem l1 | (netwerkgat) | 10.502 m | 1,16 | ACCEPTED |
| Lochem l3 | (netwerkgat) | 12.719 m | 1,12 | ACCEPTED |

**Statusonderscheid, expliciet:**

```
Amsterdam → Hilversum:  RESEARCH: PASS   PRODUCTION: PASS
Volendam → Amsterdam:   RESEARCH: PASS   PRODUCTION: PASS
Lochem:                 RESEARCH: PASS   PRODUCTION: PASS
```

**BELANGRIJKE NUANCE — 337km-anomalie, exact zo gedocumenteerd, geen overclaiming:**

| Testgeval | Onderzoek (eerder vandaag) | Productie (nu) |
|---|---|---|
| v1 (3Sx24A→AG9myG) | 336.719–337.390 m, deviationFactor ~20 | **37.733 m, deviationFactor ~2,25, ACCEPTED** |
| v7 (AG9myG→nKfPyX) | 336.284 m, deviationFactor ~18 | **40.172 m, deviationFactor ~2,17, ACCEPTED** |

```
337-km anomaly:
  RESEARCH: REPRODUCED
  PRODUCTION: NOT REPRODUCED
  VALIDATION REJECTION IN PRODUCTION: NOT OBSERVED
```

**Correcte formulering (letterlijk vastgelegd, zodat dit niet later verkeerd wordt samengevat):** de oorspronkelijke 337-km-anomalie reproduceerde niet in de huidige productieconfiguratie. De validatielaag is afzonderlijk, geïsoleerd getest op afwijzing van extreme routes (`combined-route-engine.test.ts`, een nagebouwd anomalie-scenario) — maar die afwijzingsroute is tijdens deze productie-run **niet daadwerkelijk getriggerd**, omdat er niets was om af te wijzen. Niet schrijven: "validatie heeft de 337km-route opgelost." Dat is niet wat er is aangetoond.

**PRODUCTIE GEWIJZIGD:** NEE tijdens deze documentatiestap (de eerdere migratie/activatie/generatie was al gebeurd vóór dit moment).

**VOLGENDE STAP:** gerichte trace naar de oorzaak van het niet-reproduceren (hieronder) — geen brede heranalyse, exact afgebakend.

---

### GERICHTE TRACE — waarom reproduceerde de 337km-anomalie niet in productie?
**DATUM:** 9 september 2026
**STATUS:** tooling gebouwd, uitvoering wacht op Te (geen netwerktoegang tot productie vanuit deze omgeving).
**AFBAKENING, EXPLICIET:** uitsluitend het verschil tussen regionaal-begrensde (onderzoek) en landelijke (productie) connector-generatie voor v1/v7. Geen bredere heranalyse, geen architectuurwijziging, geen fix.

**GEBOUWD:**
- `app/api/admin/read-nwb-connectors/route.ts` — leest de daadwerkelijk OPGESLAGEN productie-connectoren (niet opnieuw gegenereerd).
- `app/debug/trace-337km-cause/page.tsx` — bouwt de echte gecombineerde graaf (landelijke GoKnoop + actieve NWB + echte, opgeslagen connectoren), traceert het pad voor v1/v7, en checkt voor elke gebruikte connector-knoop of die BINNEN of BUITEN de oude Volendam-onderzoeksgrens (`latMin 52.38, latMax 52.58, lonMin 4.85, lonMax 5.2`) ligt.

**HYPOTHESE (nog niet bevestigd, expliciet zo behandeld):** de landelijke connector-generatie heeft mogelijk een GoKnoop-knoop gebruikt die buiten de oude, regionaal-begrensde onderzoeksgrens lag — in het onderzoek van vanmiddag dus onzichtbaar, in productie wel gevonden.

**VEILIGHEIDSEIGENSCHAPPEN:** 612/612 tests, tsc exit 0, build geslaagd, alleen nieuwe bestanden (`git status` bevestigd). Geen productiegedrag aangepast — uitsluitend leesoperaties.

**PRODUCTIE GEWIJZIGD:** NEE.

**VOLGENDE STAP:** zodra Te de trace-pagina draait en de uitkomst terugstuurt: hypothese bevestigen of expliciet als ONBEWEZEN markeren en stoppen met dit specifieke spoor — daarna automatisch door naar de eerstvolgende onvoltooide fase.

---

### GERICHTE TRACE — RESULTAAT (bevestigd)
**DATUM:** 9 september 2026
**STATUS:** PASS — hypothese bevestigd, hard bewijs, geen aanname.

**BEVINDING:** voor zowel v1 als v7 gebruikt de productie-route een GoKnoop-connectorknoop die daadwerkelijk BUITEN de oude Volendam-onderzoeksgrens ligt:
- v1: knoop `609ZZjTtmvsbsONm8At1` (RD y=481.670) — **6.361 m** ten zuiden van de oude grens (minY=488.031).
- v7: knoop `As36HbY9doHxbRF8oztt` (RD y=483.438) — **4.594 m** ten zuiden van de oude grens.

**Antwoord op de zes onderzoeksvragen:**
1. Connectoren: v1 → `609ZZjTtmvsbsONm8At1` ↔ NWB `c77ea6a6-...`; v7 → `As36HbY9doHxbRF8oztt` ↔ NWB `cc13c2f7-...`.
2. GoKnoop-nodes aan beide kanten: geïdentificeerd, exacte coördinaten in de ruwe trace-data.
3. **NWB-componenten: NIET apart geverifieerd in deze trace — expliciet open gelaten, geen aanname ingevuld.**
4. Aanwezig in de oude regionale set: **structureel onmogelijk** — de oude `generateConnectorCandidates`-aanroep kreeg uitsluitend bbox-gefilterde GoKnoop-nodes als input; een node buiten die grens kon nooit als kandidaat ontstaan (een scope-beperking, geen afwijzing op basis van kwaliteit).
5. Levert een node buiten de oude bbox de ontbrekende verbinding: **JA, bevestigd voor beide gevallen.**
6. Padverkorting: v1 336.719m → 37.579m; v7 336.284m → 39.013m.

**CONCLUSIE:** de landelijke (productie) connector-generatie vond een echte, structureel niet eerder overwogen verbinding — een positief, verklaard neveneffect van landelijk i.p.v. regionaal genereren. Geen datafout, geen architectuurprobleem, geen fix nodig.

**BESLUIT (Decision Log-waardig):** de 337km-anomalie wordt beschouwd als **verklaard en niet-reproduceerbaar in de huidige productieconfiguratie**, met een bekende, bewezen oorzaak (scope-verschil regionaal vs. landelijk). Dit is een ANDERE uitspraak dan "opgelost door de validatielaag" — dat onderscheid blijft in de documentatie behouden.

**ANOMALY REGISTER-UPDATE:**
```
ANOMALIE: 337km-omweg (v1/v7, Volendam-regio)
ONTDEKT: 9-9-2026, Fase 5B-kalibratie
REPRODUCEERBAARHEID: RESEARCH: ja (regionale connectorset) / PRODUCTION: nee (landelijke connectorset)
OORZAAK: bevestigd -- ontbrekende connector lag buiten de regionale onderzoeksgrens, landelijke generatie loste dit vanzelf op
VALIDATIELAAG GETRIGGERD IN PRODUCTIE: nee (niets om af te wijzen)
STATUS: verklaard, niet apart op te lossen -- geen actie vereist
```

**PRODUCTIE GEWIJZIGD:** NEE — uitsluitend documentatie.

**VOLGENDE STAP:** automatisch door naar de eerstvolgende onvoltooide fase. Fase J-data toont `computeTimeMs` van 5.047–5.867ms per aanvraag in productie — dat is een concreet, hard performance-signaal. **Fase K (performance) is daarmee de logische eerstvolgende stap**, niet een keuze maar direct af te leiden uit de al-verzamelde productiedata zelf.

---

### FASE: K — Performance
**DATUM:** 9 september 2026
**STATUS:** PASS
**DOEL:** de in Fase J waargenomen 5-6 seconden per aanvraag verklaren en oplossen.

**ROOT CAUSE, bevestigd door code-inspectie (niet aangenomen):** `/api/route/combined` las de ~144.000 NWB-segment-documenten bij ELKE aanvraag opnieuw uit Firestore, zonder enige caching. GoKnoop wordt via `CachedGraphProvider` al sinds eerder wél gecached (module-niveau, warme herbruik binnen dezelfde serverless-instance) — NWB had dat mechanisme nooit gekregen.

**OPLOSSING, geen nieuw patroon:** `lib/route-engine/cached-nwb-provider.ts` — **exact hetzelfde** module-niveau-cachingpatroon als het al-bewezen `CachedGraphProvider`, nu ook voor NWB-segmenten + connectoren. `/api/route/combined` aangepast om deze te gebruiken i.p.v. rechtstreeks Firestore te lezen.

**VEILIGHEIDSEIGENSCHAPPEN:**
- 612/612 tests slagen (inclusief de 6 `combined-route-engine.test.ts`-tests, ongewijzigd geslaagd — bevestigt dat de kernlogica niet is geraakt, alleen de data-toevoer).
- tsc exit 0, build geslaagd.
- `git status`: 1 bestaand bestand gewijzigd (`app/api/route/combined/route.ts`, zelf pas vandaag toegevoegd in Fase G/H/I — dus geen wijziging aan iets dat al langer in productie stond), 1 nieuw bestand.
- Respons bevat nu `nwbCacheHit: boolean` — direct zichtbaar of een aanvraag warm of koud was, voor toekomstige monitoring.
- Veilige degradatie blijft volledig intact (geen actieve NWB-dataset → lege lijsten, geen crash).

**VERWACHTE VERBETERING (nog niet zelf gemeten — vereist een nieuwe productie-aanroep om te bevestigen):** de eerste aanvraag na een koude start blijft ~5-6s (cache moet gevuld worden), maar elke volgende aanvraag binnen dezelfde warme instance zou aanzienlijk sneller moeten zijn (vergelijkbaar met hoe GoKnoop's eigen warme aanvragen al snel zijn).

**PRODUCTIE GEWIJZIGD:** JA — wijziging aan een bestaand (maar zelf ook pas-vandaag-toegevoegd) productie-bestand.

**VOLGENDE STAP:** deze wijziging moet gepusht worden, en dan een herhaalde `/api/route/combined`-aanroep (via Fase J's runner-pagina) om de daadwerkelijke verbetering te meten — theoretische verbetering is niet hetzelfde als bewezen verbetering.

---

### FASE: K (correctie) — eerste hypothese was onjuist, herziene, bewezen root cause
**DATUM:** 9 september 2026
**STATUS:** PASS
**DOEL:** de eerste Fase K-fix (caching van ruwe NWB-segmenten) bleek bij meting geen verbetering te geven — dit eerlijk vastleggen en de daadwerkelijke oorzaak vinden.

**WAT DE PRODUCTIEMETING LIET ZIEN:** na het pushen van de eerste fix bleef `computeTimeMs` nagenoeg ongewijzigd (~5000-5700ms), ook bij `nwbCacheHit: true`. Aangezien `computeTimeMs` strikt gemeten wordt NA het laden van data (binnen `computeCombinedRoute`), bewees dit dat de Firestore-lees NIET de dominante kostenpost was — mijn eerste hypothese was **fout**, niet gedeeltelijk juist.

**HERZIENE ROOT CAUSE, bevestigd door code-inspectie:** de VOLLEDIGE gecombineerde graaf (NWB-clustering via union-find over tot 144k segmenten, GoKnoop-edges toevoegen, connectoren verwerken) werd bij ELKE aanvraag opnieuw gebouwd — ook wanneer de ruwe data al in het geheugen zat. Het clustering-algoritme zelf is overigens wel degelijk efficiënt (grid-bucketing, niet O(n²)) — de kostenpost zat in het feit dát het bij elke aanvraag opnieuw draaide, niet in hoe het draait.

**HERZIENE FIX:**
- `cached-nwb-provider.ts` herschreven: cachet nu de **volledig gebouwde `CombinedGraph`** (adjacency + nodePosition), niet de ruwe segmenten.
- `combined-route-engine.ts`: `computeCombinedRoute` accepteert nu een AL-GEBOUWDE graaf als parameter i.p.v. zelf te bouwen — haalt coördinaten voor de hemelsbrede-afstand nu uit `graph.nodePosition` (bevat zowel GoKnoop- als NWB-knopen), geen aparte `GraphProvider` meer nodig in deze functie.
- `route.ts`: gebruikt de nieuwe `loadCachedCombinedGraph`, respons bevat nu `graphCacheHit` (preciezer dan het eerdere `nwbCacheHit` — dit meet de daadwerkelijk dure stap).

**VEILIGHEIDSEIGENSCHAPPEN:**
- 613/613 tests (7 in `combined-route-engine.test.ts`, +1 t.o.v. eerder, plus een expliciete test dat coördinaten nu uit `graph.nodePosition` komen).
- tsc exit 0, build geslaagd.
- Alle gewijzigde bestanden zijn bestanden die zelf pas vandaag zijn toegevoegd (Fase G/H/I) — geen wijziging aan iets dat al langer, ongewijzigd in productie stond.

**LES, expliciet vastgelegd (zoals de opdracht zelf vraagt bij ontdekkingen):** een genoemde oorzaak moet geverifieerd worden op basis van waar de meting daadwerkelijk begint/eindigt in de code, niet op basis van een aannemelijk klinkend verhaal. De eerste fix "voelde" logisch (NWB heeft geen caching, GoKnoop wel) maar mat niet waar de tijd echt heenging.

**PRODUCTIE GEWIJZIGD:** JA — herziening van de Fase K-wijziging van eerder vandaag, zelf nog niet gepusht.

**VOLGENDE STAP:** pushen, dan Fase J's runner-pagina nogmaals draaien om de daadwerkelijke verbetering te bevestigen (`graphCacheHit: true` zou nu een merkbaar lagere `computeTimeMs` moeten geven dan bij `false`).

---

### FASE: K — BEWEZEN (niet langer theoretisch)
**DATUM:** 9 september 2026
**STATUS:** PASS, met daadwerkelijke productiemeting.

**RESULTAAT, gemeten in echte productie, alle 6 met `graphCacheHit: true`:**

| Testgeval | Vóór | Ná | Factor |
|---|---|---|---|
| Amsterdam → Hilversum | 5.564ms | 205ms | 27× |
| Volendam → Amsterdam | 5.032ms | 25ms | 201× |
| v1 (337km-anomalie) | 5.720ms | 153ms | 37× |
| v7 (337km-anomalie) | 5.206ms | 178ms | 29× |
| Lochem l1 | 5.369ms | 3ms | 1.790× |
| Lochem l3 | 4.887ms | 14ms | 349× |

**Statusonderscheid:**
```
Performance-fix (graafcaching):
  RESEARCH: n.v.t. (productieprobleem, geen onderzoeksvraag)
  DESIGNED: PASS
  IMPLEMENTED: PASS
  TESTED: PASS (613/613 unit tests + bewezen productiemeting)
  DEPLOYED: PASS
```

**PRODUCTIE GEWIJZIGD:** JA, bevestigd effectief.

**VOLGENDE STAP:** automatisch door naar Fase L — failure/rollback.

---

### FASE: L — Failure/Rollback
**DATUM:** 9 september 2026
**STATUS:** PASS
**DOEL:** controleren dat een routingprobleem nooit tot crash/corrupte state/extreme route/onverklaarde lege route/gedeeltelijke migratie leidt, en het enige gevonden gat dichten.

**REEDS AANWEZIG, bevestigd bij controle (geen nieuwe code nodig):**
- Crash: `/api/route/combined` heeft een try/catch om de hele handler, geeft 502 met details.
- Extreme route: route-kwaliteitsvalidatie (Fase I).
- Onverklaarde lege route: expliciete `node_not_found`/`disconnected`-redenen, nooit stilzwijgend leeg.
- Gedeeltelijke migratie: migreren en activeren zijn bewust gescheiden stappen (Fase G) — een onderbroken migratie kan nooit per ongeluk live gaan.
- Data-rollback: `activate-nwb-dataset` opnieuw aanroepen met een eerdere versie-ID (geen data ooit verwijderd).

**GEVONDEN GAT, nu gedicht:** de Fase K-graafcache kon alleen via een herdeploy geleegd worden. Als ooit foute data wordt gemigreerd en later gecorrigeerd, zou de oude, foute graaf onnodig lang blijven hangen.

**GEBOUWD:** `POST /api/admin/clear-nwb-graph-cache` — leegt de in-memory graafcache. **Eerlijk gedocumenteerd als best-effort**: raakt alleen de specifieke serverless-instance die de aanvraag toevallig afhandelt, geen gegarandeerde landelijke invalidatie bij meerdere warme instances. Bij twijfel blijft een herdeploy de zekere weg.

**VEILIGHEIDSEIGENSCHAPPEN:** 613/613 tests, tsc exit 0, build geslaagd, `git status` bevestigt alleen de verwachte, kleine wijziging.

**PRODUCTIE GEWIJZIGD:** JA — kleine, additieve toevoeging.

**VOLGENDE STAP:** automatisch door naar Fase M — deployment (grotendeels al impliciet gebeurd via de incrementele pushes vandaag; dit wordt een consolidatie-controle, geen nieuwe stap) en Fase N — post-productie.

---

### FASE: M — Geometry Integration Audit
**DATUM:** 9 september 2026
**STATUS:** GEDEELTELIJK BLOCKED — expliciet zo gedocumenteerd, niet omzeild.
**ARCHITECTUURBESLUIT (Te, dit gesprek):** géén dubbele route-engine op basis van "past het wel/niet volledig binnen GoKnoop" — de gecombineerde engine wordt de ENIGE route-engine. Een Geometry Resolver-laag moet ervoor zorgen dat elke gebruikte routecomponent een tekenbare geometrie heeft, niet een voorwaarde die soms de oude engine gebruikt.

**Punt 1 — waarom `geometryAvailable.nwb = false`: VASTGESTELD.**
`SlimNwbSegment` (`combined-graph.ts`) bevat uitsluitend `from`/`to`/`lengthM` — geen tussenliggende punten. Bevestigd in `nwb-collector-tick/route.ts`, functie `toSlim()`, met een expliciete reden in de code zelf: volledige geometrie zou tegen Firestore's 1MB-documentgrootte-limiet aanlopen (dezelfde beperking als de eerdere 413-fout).

**Punt 2 — welke geometrie al beschikbaar is: VASTGESTELD.**
De volledige polylijn-geometrie wordt WEL opgehaald uit PDOK (`nwb-client.ts`, `NwbSegment.coordinates: {x,y}[]`, rechtstreeks uit de WFS `LineString`/`MultiLineString`-respons) — die gaat pas bij de stap naar `SlimNwbSegment` verloren, niet bij de bron.

**Punt 3 — hoe NWB-segmenten terug te vertalen naar geometrie: ONTWERP KLAAR, NIET GEVERIFIEERD.**
Niet opnieuw alles met volledige geometrie opslaan (zelfde opslagprobleem terug). In plaats daarvan: geometrie LIVE bij PDOK opvragen, alleen voor de specifieke segmenten die een al-berekende route daadwerkelijk gebruikt (typisch tientallen, niet 144k), via de WFS 2.0-standaard `resourceId`-parameter (meerdere features per aanroep).

Gebouwd: `lib/nwb-analysis/nwb-geometry-resolver.ts` (hergebruikt de bestaande GeoJSON-parsing uit `nwb-client.ts`, geen dubbele code) + `app/api/admin/test-nwb-geometry-resolver/route.ts` (geïsoleerde test met 4 echte, al-in-productie-gebruikte segment-ID's uit de 337km-trace).

**ECHTE, TECHNISCHE BLOKKADE (punt 4-6, niet omzeild):**
Deze sandbox-omgeving blokkeert uitgaand verkeer naar `service.pdok.nl`: bevestigd met `curl -v`, HTTP 403, header `x-deny-reason: host_not_allowed`. Dit is een beperking van de ontwikkelomgeving, geen aanname over PDOK. **Ik kan daardoor niet zelf verifiëren of `resourceId` daadwerkelijk werkt tegen deze specifieke dienst** — de WFS 2.0-standaard ondersteunt het, maar dit project heeft al eerder een vendor-extensie (`CQL_FILTER`) stilzwijgend zien falen ondanks correcte syntax, dus "hoort te werken volgens de standaard" is nadrukkelijk geen garantie.

**Punt 4-6 (testen met echte routes, regel-voor-regel-controle): NIET UITGEVOERD door mij — vereist netwerktoegang die ik niet heb.**

**Punt 7-8 (endpoint migreren, oude endpoint niet verwijderen): NOG NIET AAN DE ORDE — expliciet afhankelijk van een geslaagde punt 4-6-verificatie.**

**WAT WEL AL ZEKER IS:** geen fallback naar de oude route-engine als permanente oplossing (Te's besluit, hierboven vastgelegd) — als de geometrie-resolver het uiteindelijk niet blijkt te redden, is de vervolgvraag een architectuurvraag (alternatieve geometriebron?), geen reden om alsnog twee engines naast elkaar te laten bestaan.

**VOLGENDE, CONCRETE STAP (voor Te, vereist netwerktoegang die ik niet heb):** push deze code, draai `GET /api/admin/test-nwb-geometry-resolver`, en stuur het resultaat terug. Als `opgelost` overeenkomt met de 4 gevraagde segmenten en de coördinaten er plausibel uitzien, kan de resolver in de route-flow geïntegreerd worden (punt 7). Als het mislukt, is dat de basis voor een concreet, tweede ontwerp (bijvoorbeeld: alsnog compacte, gecomprimeerde geometrie opslaan per gebruikt segment, on-demand vanuit een aparte collectie).

**PRODUCTIE GEWIJZIGD:** NEE — uitsluitend nieuwe, geïsoleerde testcode, nergens aan gekoppeld.

---

### FASE: M (vervolg) — BLOCKED opgeheven: resolver live geverifieerd, bug gevonden en gerepareerd
**DATUM:** 10 september 2026
**STATUS:** PASS (punt 4 grotendeels voltooid; punt 5-6 nog te doen met een volledige route).

**WAT DE LIVE TEST LIET ZIEN:** drie varianten van de `resourceId`-parameter getest via een nieuwe debug-pagina (`app/debug/test-nwb-geometry-resolver`, met een server-side proxy `api/debug/proxy-fetch` om CORS te omzeilen):
- **ID exact zoals opgeslagen** (`wegvakken.c77ea6a6-...`, geen prefix): **HTTP 200, 2/2 features, volledige MultiLineString-geometrie correct terugontvangen.**
- ID met `nwbwegen:`-prefix: HTTP 400, `InvalidParameterValue` — deze dienst accepteert die vorm niet.
- `featureID` i.p.v. `resourceId`: werkt ook (oudere WFS-conventie), maar niet nodig.

**BUG GEVONDEN EN GEREPAREERD:** de oorspronkelijke `resolveNwbGeometry`-implementatie voegde onterecht een `nwbwegen:wegvakken.`-prefix toe aan ID's — precies de vorm die hierboven een 400-fout bleek te geven. Dit verklaart waarom de eerste test (vóór dit debug-onderzoek) 0/4 in 87ms opleverde: een direct mislukkende aanvraag door de verkeerde parametervorm, geen netwerkprobleem.

**FIX:** `resolveNwbGeometry` gebruikt nu de ID exact zoals opgeslagen, zonder enige transformatie. **Regressietest toegevoegd** (`nwb-geometry-resolver.test.ts`, 6 tests, gemockte fetch) die expliciet controleert dat de aanvraag-URL nooit meer een `nwbwegen:`-prefix bevat — deze specifieke fout kan niet meer sluipenderwijs terugkomen.

**VEILIGHEIDSEIGENSCHAPPEN:** 619/619 tests (6 nieuw), tsc exit 0, build geslaagd.

**NOG TE DOEN (punt 5-6 uit de opdracht):** dit was een test met 2 losse, bekende segmenten — nog niet met een volledige, berekende route (Amsterdam-Hilversum/Volendam-Amsterdam/Lochem) waarbij de resulterende lijn regel-voor-regel tegen de berekende route wordt gecontroleerd. Dat is de volgende, concrete stap vóór punt 7 (daadwerkelijke integratie in de route-flow).

**PRODUCTIE GEWIJZIGD:** NEE — nog steeds uitsluitend geïsoleerde test-/resolver-code, nog niet gekoppeld aan `/api/route/combined` of enige UI.

**VOLGENDE STAP:** de resolver koppelen aan een volledige, al-berekende route (bijv. Amsterdam-Hilversum) en de opgehaalde NWB-segment-ID's uit dat pad gebruiken als test — dit toetst punt 5-6 met echte, representatieve schaal (tientallen segmenten, niet 2).

---

### FASE: M (bevestiging) — live geverifieerd op productie, 4/4
**DATUM:** 10 september 2026
**STATUS:** PASS, definitief bevestigd via `GET /api/admin/test-nwb-geometry-resolver` (het echte eindpunt, niet de diagnose-pagina).

**RESULTAAT:** `{"gevraagd":4,"opgelost":4,"mislukt":[]}` — alle vier bekende segmenten correct opgelost, inclusief één met 573 punten (een lang/gedetailleerd wegvak) — bevestigt dat de fix ook bij grotere, complexere segmenten werkt, niet alleen bij de eerdere kleine voorbeelden.

**PRODUCTIE GEWIJZIGD:** NEE.

**VOLGENDE STAP:** punt 5-6 van de oorspronkelijke opdracht — koppelen aan een volledig berekende route, regel-voor-regel controleren dat de resulterende lijn overeenkomt met de berekende route.

---

### FASE: M (technische correctie) — CombinedEdge.nwbInfo.segmentId toegevoegd
**DATUM:** 10 september 2026
**STATUS:** PASS
**DOEL:** de bij het testen ontdekte onbetrouwbaarheid van segment-ID-extractie oplossen — niet cosmetisch, maar noodzakelijk om exact te kunnen bewijzen dat gestikte geometrie overeenkomt met de daadwerkelijk gekozen route.

**HET PROBLEEM, gevonden tijdens punt 5-6 van de audit:** de eerste volledige-route-geometrietest (Hilversum) gaf een verschil van -1.426m (~14%) tussen de opgehaalde NWB-geometrie en de door het kostenmodel berekende NWB-afstand. Onderzoek wees twee oorzaken aan: (1) een segment dat het pad meerdere keren doorkruist, maar in de test maar één keer werd meegeteld; (2) fundamenteler: `CombinedEdge.nwbInfo` bevatte geen `segmentId` — het cluster-knoop-ID (`nwb:<union-find-wortel>`) is bij clusters van meerdere samengevoegde punten NIET betrouwbaar naar het originele segment te herleiden (de wortel is een willekeurig gekozen lid van het cluster).

**BESLUIT (Te):** dit oplossen op de juiste manier — `segmentId` vastleggen bij edge-creatie (wanneer het origineel nog bekend is), niet achteraf reconstrueren. Expliciet begrensd: geen andere wijzigingen aan kostenmodel, connectors, Dijkstra, of UI.

**WIJZIGING, minimaal en precies:**
- `CombinedEdge.nwbInfo` uitgebreid met `segmentId: string`, ingevuld op de exacte plek in `buildBaseGraph()` waar `seg.id` nog bekend is (twee regels).
- `CostAwareStep` (de door productie gebruikte Dijkstra-stap-type) uitgebreid met `nwbSegmentId?: string`, ingevuld in `dijkstraWithCostModel()`.
- **Geen enkele andere regel in `combined-graph.ts` gewijzigd** — kostenmodel, connectorlogica, en de oudere `dijkstraOnCombinedGraph` (die al `nwbInfo` volledig doorgaf) ongemoeid.

**TESTS:** 3 nieuwe, gericht op de kern van het probleem:
1. Een enkele NWB-edge draagt het originele `segment.id`.
2. **Kerngeval**: drie segmenten die in één punt samenkomen (cluster van 3+ leden) — bevestigt dat alle drie de originele ID's correct terugkomen, ook al is de cluster-wortel willekeurig.
3. `dijkstraWithCostModel` geeft het correcte `nwbSegmentId` per stap terug (niet alleen de oudere Dijkstra-variant).

**VEILIGHEIDSEIGENSCHAPPEN:** 622/622 tests (18 in `combined-graph.test.ts`, +3), tsc exit 0, build geslaagd. `git status` bevestigt: uitsluitend `combined-graph.ts`/`.test.ts` + de geometrietest-endpoint gewijzigd — exact de afgebakende scope, niets aan kostenmodel/connectors/Dijkstra/UI.

**BIJKOMENDE WIJZIGING:** `test-full-route-geometry`-endpoint aangepast om het nieuwe, betrouwbare `step.nwbSegmentId` te gebruiken i.p.v. de oude, onbetrouwbare knoop-ID-parsing — en rapporteert nu zowel de unieke-segmenten-som als de per-doorkruising-som, om de dubbeltelling-hypothese direct empirisch te bevestigen of te weerleggen bij de volgende test.

**PRODUCTIE GEWIJZIGD:** JA — kleine, precieze datamodel-uitbreiding.

**VOLGENDE STAP:** dezelfde drie routes (Hilversum/Volendam/Lochem) opnieuw testen via het bijgewerkte endpoint — nu zou `verschilPerDoorkruisingM` vrijwel 0 moeten zijn.

---

### FASE: M (bevestiging) — Hilversum: EXACT, 0m verschil
**DATUM:** 10 september 2026
**STATUS:** PASS voor Hilversum. Volendam/Lochem nog te bevestigen.

**RESULTAAT:** `{"aantalNwbDoorkruisingen":85,"aantalUniekeNwbSegmenten":85,"geometrieOpgelost":85,"verschilPerDoorkruisingM":0}` — perfecte overeenkomst, geen enkele mislukking.

**GECORRIGEERDE OORZAAK-ANALYSE:** `aantalNwbDoorkruisingen` (85) = `aantalUniekeNwbSegmenten` (85) — er werd in deze route geen enkel segment dubbel doorkruist. De eerdere -1.426m-afwijking kwam dus NIET van dubbele doorkruisingen (die hypothese was onjuist), maar uitsluitend van het inmiddels gerepareerde segmentId-probleem: het oude cluster-knoop-ID miste/verwarde 6 van de 85 segmenten. Met het betrouwbare veld zijn alle 85 correct en exact teruggevonden.

**PRODUCTIE GEWIJZIGD:** NEE.

**VOLGENDE STAP:** Volendam en Lochem nog bevestigen (`?route=volendam` en `?route=lochem`) voordat punt 5-6 van de audit volledig wordt afgesloten.
