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
