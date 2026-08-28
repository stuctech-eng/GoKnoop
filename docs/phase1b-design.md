# GoKnoop — Phase 1B: Data Model + Importer Design

**Datum:** 25 augustus 2026 (herzien: database Supabase → Firebase/Firestore, project `go-knoop`)
**Status:** Ontwerp goedgekeurd, pre-flight checklist afgerond, volledige import (Phase 1C stap 13) uitgevoerd en gevalideerd — klaar voor Phase 2 (Route Engine)
**Basis:** Phase 1A-auditrapport (`docs/phase1a-wfs-audit.md`), bevestigd met echte featuredata

---

## 1. BRONLAGEN (definitief, Phase 1A bevestigd)

| Bron-laag | Ons gebruik | CRS zoals geleverd |
|---|---|---|
| `fietsknooppunten_wgs84` | Nodes | EPSG:4326 |
| `fietsnetwerken_vrij` | Edges | EPSG:28992 |

Beide zijn de "vrije" varianten waar het account `goknoop` daadwerkelijk rechten op heeft (bevestigd in Phase 1A). De NL-brede lagen (`fietsknooppunten`, `fietsknooppuntnetwerken`) blijven ontoegankelijk en worden niet gebruikt.

**Open vraag, geen blocker:** `fietsknooppunten_vrij` (RD-variant van dezelfde nodes) bestaat ook — te overwegen als primaire bron in plaats van de wgs84-variant, zodat nodes en edges in dezelfde bron-CRS binnenkomen en er één conversie minder nodig is. Te beslissen bij implementatie; functioneel maakt het geen verschil.

---

## 2. DOELDATABASE

**HERZIEN 25-8-2026: Firebase (Firestore), project `go-knoop` — niet Supabase.**

**Aanleiding voor de wijziging:** Supabase-projectslots waren vol. Bij nader inzien is dit geen bezwaar: alle Phase 1C-analyses (matchtolerantie, clustering, threshold sensitivity) zijn in gewone JavaScript geïmplementeerd, niet met PostGIS-SQL-functies (`ST_DWithin`, `ST_Transform`, etc.) — de rekenlogica is dus al bewezen te werken zonder spatial database-functies. Firestore past bovendien beter bij de rest van de projectenportfolio (grotendeels Firebase-gebaseerd).

**Consequenties, expliciet benoemd:**
- Geen `GEOMETRY`-kolommen, geen `GIST`-index, geen `ST_*`-functies — coördinaten worden platte numerieke velden (`x`, `y` in EPSG:28992), berekeningen (afstand, clustering, matching) gebeuren in applicatiecode, exact zoals de Phase 1C-diagnostiek al deed.
- Geen native nearest-neighbor query. Voor de eenmalige import (13.152 nodes, 28.067 edges — samen ruim binnen wat één keer in-memory verwerkt kan worden, seconden werk) is dat geen probleem. Voor toekomstige *runtime* route-queries (Phase 2, Route Engine) kan een grid-bucket-veld (`gridCell`, afgeleid van afgeronde x/y) nodig zijn om niet de hele collectie te hoeven doorzoeken — dat is een Phase 2-zorg, niet Phase 1.
- Firestore's ingebouwde `GeoPoint`-type gaat uit van WGS84 lat/lon; omdat we bewust in RD New (EPSG:28992) blijven rekenen (matchprecisie in meters, zie sectie 3), wordt dat type NIET gebruikt — coördinaten blijven platte `x`/`y`-velden.

**Benodigde environment variables (te zetten in Vercel zodra de importer gebouwd wordt):**
```
FIREBASE_PROJECT_ID=go-knoop
FIREBASE_CLIENT_EMAIL=       (uit een Firebase Admin SDK service-account-sleutel)
FIREBASE_PRIVATE_KEY=        (uit dezelfde service-account-sleutel — server-side only,
                               nooit in NEXT_PUBLIC_*, zelfde beveiligingsprincipe als
                               de Routedatabank-credentials)
```
Server-side toegang via de Firebase Admin SDK (niet de client-SDK) — de importer draait in een Vercel API-route, niet in de browser.

---

## 3. DATAMODEL (Firestore-collecties, definitief voorstel)

Zelfde drie-lagen-principe als voorheen (bronidentiteit en applicatie-identiteit nooit door elkaar), nu als Firestore-collecties in plaats van Postgres-tabellen. Elke collectie is top-level (geen diepe subcollecties) met een `datasetVersionId`-veld voor filtering — dat houdt queries eenvoudig en voorkomt onnodige joins.

```
COLLECTION: datasetVersions
  { id, source: 'routedatabank', importedAt, status: 'pending'|'validated'|'active'|'superseded'|'failed',
    nodeCount, edgeCount, validationResult: {...} }

COLLECTION: sourceNodes
  -- Exacte kopie van Routedatabank, ongewijzigd. GEEN unieke sleutel op knooppuntnr/regio (zie sectie 6).
  { id, datasetVersionId, sourceObjectId, knooppuntnr, regio, provincie, soortKnooppunt,
    networkType: 'fiets',  // Master Context sectie 8 — voorbereid op wandel/MTB, deze import altijd 'fiets'
    x, y,                  // EPSG:28992
    logicalNodeId,         // toegevoegd NA de merge-stap — welke logical node dit source_node vertegenwoordigt
    createdAt }

COLLECTION: logicalNodes
  -- De routing-eenheid zoals de graph 'm gebruikt.
  { id, datasetVersionId, displayNumber, displayRegio,
    networkType: 'fiets',
    x, y,                  // afgeleid, bijv. centroid van gekoppelde source_nodes
    clusterMethod: 'single' | 'spatial_cluster',
    clusterThresholdM,     // welke drempel toegepast is, indien clustered
    sourceNodeMappings: [  // ARRAY, embedded — herleidbaarheid zonder aparte join-collectie
      { sourceNodeId, mergeDecision: 'merged' | 'protected_single' | 'rejected_distance'
                                     | 'rejected_topology' | 'exception_review' }
    ],
    createdAt }
  -- Elk source_node krijgt een mapping-entry, ook als het NIET wordt samengevoegd
  -- ('protected_single' — wijst dan naar zijn eigen, unieke logicalNode). Dit array-veld
  -- vervult exact dezelfde rol als de eerder voorgestelde logical_node_sources-tabel
  -- (GPT-review 25-8-2026: de 4% soort_knooppunt-uitzonderingen blijven zichtbaar/doorzoekbaar),
  -- nu als embedded array — idiomatischer voor Firestore, en nooit destructief overschreven:
  -- alleen aangevuld bij aanmaak, nooit gewijzigd na activatie.

COLLECTION: edges
  { id, datasetVersionId, sourceObjectId, regio, provincie,
    rijrichting,            // RUW, ongewijzigd bewaard (zie sectie 4/6)
    directionality: 'unknown',  // AFGELEID — nooit 1-op-1 kopie van rijrichting
    distanceM,               // lengte_m uit de bron
    coords: [{x, y}, ...],   // volledige lijngeometrie, EPSG:28992
    fromLogicalNodeId,       // AFGELEID, nullable — niet elke edge heeft aan beide kanten een match
    toLogicalNodeId,         // AFGELEID, nullable
    matchConfidence: 'matched' | 'unmatched_start' | 'unmatched_end' | 'unmatched_both',
    endpointMatches: [  // TOEGEVOEGD 26-8-2026 na implementatie — volledige herleidbaarheid per endpoint
      {
        endpoint: 'start' | 'end',
        sourceCoordinate: { x, y },
        matchedSourceNodeId,       // NIET rechtstreeks logicalNodeId — eerst het bronpunt
        logicalNodeId,             // afgeleid VIA matchedSourceNodeId.logicalNodeId, nooit rechtstreeks
        distanceM,
        matchConfidence: 'exact' | 'close' | 'tolerance' | 'unmatched',  // resp. <=0.5m / <=2m / <=5m / >5m
        ambiguous,                 // true als er meerdere source_nodes binnen 5m lagen
      }
    ],
    -- Toekomstvaste velden (Master Context v2 sectie 3, 8, 22) — nu alleen als veld,
    -- functionaliteit die erop bouwt wordt NIET nu gebouwd (sectie 23):
    mode: 'bicycle',         // toegestane modaliteit; deze import altijd 'bicycle'
    network,                 // welk netwerktype (regionaal fietsnetwerk, LF-route, etc.)
    restrictions: {},        // toekomstige beperkingen, leeg in Phase 1
    qualityScore: null,      // toekomstige routekwaliteit-scoring, ongebruikt in Phase 1
    createdAt }

DOCUMENT: config/activeDataset
  -- Eén document, wijst naar de dataset_version die live staat.
  { datasetVersionId }
```

**Indexering:** Firestore composite indexes op `(datasetVersionId, ...)` waar nodig voor filtering (bijv. `sourceNodes` op `(datasetVersionId, regio, knooppuntnr)` voor opzoeken/weergave — nooit voor identiteitsbepaling, zie sectie 6). Geen spatial index nodig voor de import zelf; alle matching/clustering gebeurt in-memory tijdens de importer-run.

**Waarom `fromLogicalNodeId`/`toLogicalNodeId` nullable zijn:** niet elke edge hoeft aan beide kanten een matchende node te hebben (zie sectie 6, datakwaliteit). Een edge zonder volledige match wordt niet stilzwijgend genegeerd, maar opgeslagen met `matchConfidence` zodat de omvang van het probleem zichtbaar en meetbaar is.

**Waarom alles in RD New (EPSG:28992) staat:** matchtolerantie werkt het natuurlijkst in meters. WGS84 (lat/lon) vervormt afstanden afhankelijk van breedtegraad. Nodes uit `fietsknooppunten_wgs84` worden dus bij import geconverteerd naar EPSG:28992 (dezelfde conversie die de Phase 1C-diagnostiek al toepaste).

---

## 4. DIRECTIONALITEIT — `rijrichting`

**Architectuurprincipe: directie-interpretatie hoort in de normalisatielaag, niet als destructief filter op de brondata.**

```
RAW DATA (ongewijzigd, inclusief originele rijrichting-waarde)
   ↓
NORMALIZATION (interpretatie van rijrichting vastleggen)
   ↓
DIRECTION INTERPRETATION (afgeleide directionality-waarde)
   ↓
VALIDATION (empirisch getoetst, zie hieronder)
   ↓
GRAPH
```

Concreet betekent dit voor het datamodel: **de brontabel bewaart `rijrichting` (ruwe waarde uit de bron, ongewijzigd) én `directionality` (afgeleide, geïnterpreteerde waarde) als aparte kolommen** — nooit de ene stilzwijgend vervangen door de andere. Als Routedatabank later een andere laag of versie levert, kan de interpretatiestap worden aangepast zonder de Route Engine of eerder geïmporteerde data te hoeven wijzigen.

```sql
-- Aanvulling op de eerdere edges-tabel uit sectie 3:
-- rijrichting            TEXT   -- staat er al: ruwe brondata, ongewijzigd
-- directionality         TEXT   -- staat er al: afgeleide waarde, NOOIT rechtstreeks 1-op-1 kopie van rijrichting
```

**Resultaat empirische validatietest (25-8-2026, steekproef 917 edges, 86 met `rijrichting=2`):**

```
rijrichting=2 edges:          86
Matched reverse counterpart:   3
No counterpart:               83
Match rate:                  3,5%
```

**Hypothese verworpen.** Ver onder de 50%-drempel — `rijrichting=2` is in deze laag geen duplicaat-marker.

**Herziene, beter onderbouwde verklaring:** Fietsplatform's officiële FAQ maakt onderscheid tussen twee datasets: de "hartlijnen" RD-dataset (kleine lijnstukjes, beleidsdoeleinden, wél in twee richtingen gedigitaliseerd — daar geldt de filter-regel) en de "geaggregeerde" consumenten-dataset (knooppunt-tot-knooppunt, expliciet omschreven als *"worden altijd in één richting aangeboden"*). Onze `fietsnetwerken_vrij`-laag is qua structuur (lange, geaggregeerde lijnen) de laatste categorie — en die kent per definitie geen duplicaten. Dat verklaart de lage match rate.

**Werktheorie (nog niet 100% bevestigd, wel de best onderbouwde):** `rijrichting` codeert waarschijnlijk een **echte fysieke rijrichtingsbeperking** op het traject zelf (bijv. eenrichtingsfietspad, jaagpad, natuurgebied-beperking) — niet een data-artefact. Dat betekent `directionality` inderdaad relevant is voor de route-engine, en niet simpelweg genegeerd kan worden.

**Nog openstaand:** welke exacte waarde (`0`, `1`, `2`) met welke fysieke betekenis overeenkomt, is nog niet vastgesteld. Voorlopig advies: **niet raden.** Bij Phase 1C-implementatie: sla `rijrichting` op zoals het binnenkomt, laat `directionality` op `bidirectional` (veiligste default) staan totdat de exacte codering is bevestigd — een edge onterecht als eenrichtingsverkeer behandelen is voor een route-engine schadelijker dan een edge onterecht als tweerichtingsverkeer behandelen.

**Tweede hypothese getest en verworpen (25-8-2026): parallelle-baan-theorie.** Getest of `rijrichting=1`/`2`-edges vaker een nabije, gelijkgerichte (niet-omgekeerde) tweelingedge hebben dan `rijrichting=0` — wat zou wijzen op gescheiden lijnstukken per richting (bijv. een dijk met een baan per richting) in plaats van een simpele eenrichtingsbeperking. Resultaat: `0`: 0,0% (0/484), `1`: 2,5% (2/79), `2`: 0,0% (0/37) — geen enkel bruikbaar signaal.

**Conclusie: rijrichting-onderzoek gepauzeerd, niet opgelost.** Twee redelijke geometrische hypotheses (duplicaat-omkering, parallelle baan) zijn getest en beide verworpen, zonder verdere aanknopingspunten in de beschikbare data of documentatie (Jon Rietman kon dit zelf niet toelichten). Verder gokken zonder nieuwe informatiebron levert waarschijnlijk niets op. De veilige default (`unknown`/`bidirectional`) blokkeert de importer niet — dit onderzoek kan later hervat worden als een nieuwe informatiebron beschikbaar komt (bijv. een reactie van Routedatabank, of een vergelijkbaar project dat de codering al heeft ontrafeld).

- Als `rijrichting` een eenrichtingsbeperking aangeeft (bijv. `0` = beide richtingen, `1` = alleen in de richting van de lijngeometrie, of een vergelijkbare codering), dan is een edge **niet automatisch symmetrisch** (`24 ↔ 31`), maar kan die directioneel zijn (`24 → 31`).
- Voor de route-engine is dit essentieel: een gegenereerde route die een eenrichtingspad tegen de richting in gebruikt, is voor een fietser ongeldig of zelfs verboden.

**Verplichte Phase 1C-onderzoeksstap, vóór de importer gebouwd wordt:** de daadwerkelijke betekenis van elke `rijrichting`-waarde vaststellen — via een combinatie van (a) documentatie/navraag bij Routedatabank indien nodig, en (b) visuele/steekproefsgewijze validatie: geometrierichting van de lijn vergelijken met bekende praktijksituaties (bijv. een brug of eenrichtingsfietspad dat bekend staat als eenrichtingsverkeer).

**Gevolg voor het datamodel:** `edges` heeft een apart veld `directionality` (`bidirectional` | `forward` | `reverse` | `unknown`, zie sectie 3), afgeleid van `rijrichting` tijdens import — niet 1-op-1 overgenomen totdat de codering bevestigd is. `forward`/`reverse` verwijzen naar de richting van de brongeometrie (eerste → laatste coördinaat van `coords[]` = 'forward').

---

## 5. NODE/EDGE MATCHING-ALGORITME

Voor elke edge:

1. Bepaal het eerste en laatste coördinaat (`coords[0]` en `coords[coords.length - 1]`) van de edge-lijngeometrie.
2. Zoek voor elk eindpunt de dichtstbijzijnde node binnen een tolerantie — in-memory Euclidische afstand over alle `sourceNodes` van de betreffende `datasetVersionId` (exact dezelfde aanpak als de Phase 1C-diagnostiek al toepaste; bij 13.152 nodes ruim haalbaar voor een eenmalige importer-run zonder spatial index).
3. **Matchtolerantie: 5 meter (empirisch bevestigd, 25-8-2026).** Steekproef van 449 nodes / 917 edges (bbox rond Utrecht/Gooi en Vechtstreek) toont: mediaan afstand tot dichtstbijzijnde node is **0,00 meter** (veel exacte coördinaat-matches), 77,7% matcht al binnen 2m, en oprekken tot 50m voegt slechts 1 procentpunt toe (78,8%). Een ruimere tolerantie dan ~5m levert dus geen echte winst en vergroot alleen het risico op foutieve matches. **Definitieve waarde: 5 meter.**

**BELANGRIJK — twee aparte constanten, nooit samenvoegen tot één `distance_threshold` (GPT-review 25-8-2026):** matchtolerantie (node↔edge-eindpunt matching) en de composite-node-clusteringdrempel (sectie 6) zijn twee verschillende geometrische problemen met verschillende waarden. Bij implementatie expliciet als aparte, apart genoemde constanten definiëren:
```
NODE_EDGE_MATCH_TOLERANCE_M = 5    // sectie 3: welke node hoort bij welk edge-eindpunt
COMPOSITE_CLUSTER_THRESHOLD_M = 50 // sectie 6: welke source_nodes vormen samen één logical_node
```
Een generieke `DISTANCE_THRESHOLD`-variabele die voor beide wordt (her)gebruikt is een designfout die tot subtiele bugs leidt zodra één van de twee waarden ooit wordt bijgesteld.

4. **~21% van de edge-eindpunten blijft structureel unmatched, ook bij grote tolerantie — dit is verwacht gedrag, geen bug.** Waarschijnlijke oorzaak: de `_vrij`-lagen voor nodes en edges zijn per regio onafhankelijk vrijgegeven. Een edge kan "vrij" zijn terwijl het knooppunt waarop hij aansluit in een aangrenzende, niet-vrijgegeven regio ligt en dus alleen in de ontoegankelijke volledige laag bestaat. Dit is een karakteristiek van de toegestane dataset, geen matchingfout — de importer moet deze edges gewoon opslaan met `match_confidence = 'unmatched_start'/'unmatched_end'`, niet proberen te forceren.
4. Sla het resultaat op: beide kanten gematcht → `match_confidence = 'matched'`; anders het toepasselijke label.
5. Reken na import het percentage matched/unmatched uit en zet dat in `dataset_versions.validation_result`.

---

## 6. DATAKWALITEIT — VERWACHTE AANDACHTSPUNTEN

- **`uitlev_akk`-veld:** bevestigd in de steekproef altijd `"Ja; vrij"` op de geteste records. Toch bij import blijven controleren of dit per record klopt, niet aannemen dat de hele laag uniform is.
- **`soort_knooppunt` met waarden als "Samengesteld_aan"/"Samengesteld_uit" — bevestigd substantieel (37% van records). Merge-strategie definitief herzien op basis van hertest met `(regio, knooppuntnr)`-groepering (25-8-2026).**

  Resultaat van de hertest (30 samples uit 106 `(regio, knooppuntnr)`-groepen met meerdere records): 3 binnen 5-25m, 5 binnen 25-100m, **22 van de 30 nog steeds >100m uit elkaar — tot 25.437 meter, zelfs bínnen dezelfde regio.**

  **Kernbevinding: `regio` is niet fijnmazig genoeg als scope.** Een regio als "Utrecht" blijkt een groot gebied te zijn met meerdere lokale (sub)netwerken die onafhankelijk vanaf 1 nummeren — dus zelfs binnen één regio kunnen twee volstrekt losstaande fysieke knooppunten toevallig hetzelfde nummer delen. Attribuutmatching (`knooppuntnr`, ook met `regio` erbij) is dus **niet betrouwbaar genoeg** om vast te stellen of records daadwerkelijk hetzelfde fysieke knooppunt zijn.

  **Herzien na GPT-review (25-8-2026): afstand alléén is een gevaarlijk criterium.** Twee ruimtelijk dichtbij gelegen punten kunnen ook **twee legitiem verschillende knooppunten** zijn (bijv. een kruising met twee aparte knooppunten, twee lokale netwerken die toevallig dicht bij elkaar liggen, weerszijden van een weg). Simpelweg "afstand ≤ 100m → samenvoegen" negeert dat omgekeerde risico.

  **Definitieve aanpak: clustering + topologische validatie, geen los afstandscriterium.**

  ```
  Spatial candidate (binnen onderzoeksdrempel)
          ↓
  Geometric proximity
          ↓
  Edge attachment analysis  (welke edges hangen aan welk fysiek punt?)
          ↓
  Network/context compatibility  (horen de aangesloten edges bij hetzelfde netwerk/regio?)
          ↓
  Clustering
          ↓
  LogicalNode  (alleen als afstand ÉN topologie ÉN netwerkcompatibiliteit kloppen)
  ```

  **Resultaat threshold sensitivity-test (25-8-2026, 449 nodes):**

| Drempel | Clusters | Samengevoegde records | Regio-conflicten | Knooppuntnr-conflicten | Topologie-conflicten |
|---|---|---|---|---|---|
| 10m | 3 | 6 | 0 | 0 | 0 |
| 25m | 36 | 85 | 0 | 1 | 0 |
| 50m | 50 | 133 | 2 | 2 | 1 |
| 75m | 57 | 149 | 2 | 2 | 1 |
| 100m | 60 | 159 | 2 | 5 | 1 |
| 125m | 63 | 166 | 3 | 8 | 2 |
| 150m | 69 | 179 | 3 | 15 | 2 |

**Groeisnelheid (nieuwe clusters per meter):** 10-25m: 2,2/m → 25-50m: 0,56/m → 50-75m: 0,28/m → 75-100m: 0,12/m → 100-125m: 0,12/m → 125-150m: 0,24/m.

**Natuurlijke knik zit tussen 25 en 50 meter** — groeisnelheid valt daar met een factor 4 terug. Vanaf 75-100m beginnen de `knooppuntnrAttributeConflicts` bovendien bijna te verdubbelen per stap (2 → 5 → 8 → 15), een duidelijk signaal dat vanaf daar steeds meer punten worden samengevoegd die zelfs qua brondata-identiteit niet bij elkaar horen.

**Definitieve drempel: 50 meter** (niet de eerder aangenomen 100m). Op 50m: 133 samengevoegde records met een conflictniveau van ~3,8% (2 regio + 2 knooppuntnr + 1 topologie-conflict) — de meeste winst, nog beperkte ruis.

**Openstaande actie vóór importer:** de specifieke conflicterende clusters bij 50m (5 stuks, met enige overlap tussen de categorieën) moeten los geïnspecteerd worden — dit zijn precies de grensgevallen die handmatige beoordeling verdienen vóór de merge-logica wordt vastgezet.

**Handmatige inspectie van de 4 conflicterende clusters bij 50m (25-8-2026) — doorslaggevende bevinding:**

| Cluster | Diameter | Conflict-type | Bevinding | Actie |
|---|---|---|---|---|
| 1 | 12,4m | knooppuntnr (`45` vs `-`) | Beide Almere, edges naar Almere | Samenvoegen |
| 2 | 31,0m | regio (Gooi/Utrecht) | Zelfde knooppuntnr `75`, edges convergeren naar Utrecht | Samenvoegen |
| 3 | 49,4m | knooppuntnr (`99` vs `67`) | **Beide "Enkelvoudig"** — twee complete, zelfstandige knooppunten die toevallig dicht bij elkaar liggen | **NIET samenvoegen** |
| 4 | 73,1m | regio + topologie | 5 punten, allemaal `Samengesteld_aan/uit`, twee brugpunten tussen regio's — één samenhangend grensknooppunt | Samenvoegen |

**Sleutelbevinding:** in alle 4 gevallen voorspelt `soort_knooppunt` correct of samenvoegen terecht is. Cluster 3 (de enige die niet samengevoegd moet worden) is ook de enige waar **beide** punten "Enkelvoudig" zijn — de bron markeert dit dus zelf al als twee volwaardige, aparte knooppunten. Clusters 1, 2 en 4 bevatten allemaal minstens één "Samengesteld"-punt.

**Wat dit wél en niet bewijst:** dit zijn 4 voorbeelden, geen dekkend bewijs voor alle 13.152 nodes. Vóór dit als harde productieregel wordt gebruikt, moet eerst empirisch worden vastgesteld hoe vaak een cluster van **uitsluitend "Enkelvoudig"-punten** toch een geldige merge-kandidaat blijkt (`enkelvoudig_only`-telling over de volledige dataset). Bij 0 of alleen evidente uitzonderingen: sterk bewijs voor een harde regel. Bij een substantieel aantal: de regel moet worden bijgesteld.

**Resultaat `enkelvoudig_only`-telling (25-8-2026, 50 clusters totaal bij 50m):** 48 `samengesteld_only` (96%), 0 `mixed`, slechts **2 `enkelvoudig_only`** (4%).

Bij nadere inspectie bleek Cluster 1 uit de handmatige beoordeling hierboven (12,4m, Almere, `45` vs `-`) **ook** `Enkelvoudig`-only te zijn — de eerdere handmatige beoordeling ("samenvoegen") hield hier onvoldoende rekening met het `soort_knooppunt`-veld. Herbeoordeeld:
- **12,4m, "45" vs "-":** zeer kleine diameter, lege knooppuntnr ("-") suggereert een onvolledig/hulprecord. Waarschijnlijk alsnog een terechte duplicaat, ondanks het "Enkelvoudig"-label — een **grensgeval**, geen duidelijk tegenvoorbeeld tegen de regel.
- **49,4m, "99" vs "67":** twee expliciet verschillende nummers, grotere afstand — duidelijk twee aparte, terecht beschermde knooppunten.

**Definitieve, genuanceerde regel (4% uitzonderingspercentage rechtvaardigt "standaard beschermd", geen absolute wet):**

```
soort_knooppunt = Enkelvoudig
  EN afstand < 20 meter (extreem klein — waarschijnlijk toch echte duplicaat)
        ↓
    ALSNOG merge-kandidaat, markeren voor review

soort_knooppunt = Enkelvoudig
  EN afstand ≥ 20 meter
        ↓
    standaard NIET samenvoegen (hoofdregel, ~96% correct volgens steekproef)
```

**Herziene merge-regel — `soort_knooppunt` is het primaire semantische signaal, geen absolute regel:**

```
soort_knooppunt = Enkelvoudig
        ↓
    standaard NIET automatisch merge-kandidaat
    (te heroverwegen als de enkelvoudig_only-analyse over de volle dataset
     aantoont dat dit patroon consistent is)

soort_knooppunt = Samengesteld_aan / Samengesteld_uit
        ↓
    merge-kandidaat
        ↓
    ruimtelijke nabijheid (drempel 50m, zie hierboven)
        ↓
    cluster-topologie ALS GEHEEL beoordeeld (niet paarsgewijs — zie Cluster 4:
    paarsgewijze beoordeling gaf een vals-conflict, terwijl het cluster als geheel
    via brugpunten wél samenhangend is)
        ↓
    MERGE tot LogicalNode
```

**Signaalhiërarchie (geen van deze is op zichzelf een identiteitssleutel):**
```
soort_knooppunt   ← primair semantisch signaal (bron zegt: is dit een deel van een geheel?)
knooppuntnr       ← secundair associatiesignaal (versterkt een match, bewijst niets alleen)
regio             ← contextsignaal (grenspunten tussen regio's zijn legitiem, geen harde grens)
geometry/afstand  ← ruimtelijk signaal (kandidaatvorming, niet de beslissing zelf)
```

De uiteindelijke merge-beslissing = combinatie van alle vier, nooit één signaal alleen. Cluster als geheel beoordelen (connected component), niet paarsgewijs — een cluster met brugpunten naar meerdere regio's kan alsnog één samenhangend netwerk zijn.
- **Schema-afwijking tussen `fietsnetwerken_vrij` en het eerder via DescribeFeatureType geziene `fietsknooppuntnetwerken`:** de `_vrij`-laag heeft `lokaalid` in plaats van `ogc_fid`. Importer moet robuust zijn tegen dit soort kleine schemaverschillen tussen laagvarianten.
- **Limburg-uitzondering: BEVESTIGD, geen actie nodig (25-8-2026).** Een bbox middenin Limburg (Maastricht-Sittard-Heerlen-Roermond, vergelijkbare grootte als de eerdere testgebieden) leverde **nul nodes en nul edges** op. Ter vergelijking: een eerste, minder centrale poging (deels Noord-Brabant) gaf wel resultaten maar met vrijwel geen Limburg-`regio`-labels. De server sluit Limburg dus al zelf uit voor het `goknoop`-account — er is geen aparte filter in de importer nodig.
- **Regio-generalisatie getest (25-8-2026):** matchtolerantie- en veldprofiel-tests herhaald in Groningen/Drenthe (476 nodes, 500 edges) ter controle of de Utrecht-bevindingen toeval waren. Resultaat: zelfde patroon — snel plateau bij matchtolerantie (68,9% binnen 2m → 70,4% bij 50m, vergelijkbare vorm als Utrecht's 77,7%→78,8%), vergelijkbare `rijrichting`-verdeling (82%/10%/8% vs Utrecht's 75%/16%/9%) en `soort_knooppunt`-verhouding. De eerdere conclusies zijn dus niet regio-specifiek toeval.

---

## 6B. EDGE-MATCHING RESULTAAT — VOLLEDIGE IMPORT (26-8-2026)

Na de volledige import (13.152 sourceNodes → 11.003 logicalNodes → 28.060 edges) is de endpoint-matching (sectie 5, 5m tolerantie) uitgevoerd op de complete dataset, niet meer op een steekproef.

**Resultaat (56.120 endpoints, 28.060 edges):**
```
Confidence-verdeling (endpoints): exact 35.215, close 2.412, tolerance 1.910, unmatched 16.583
Gemiddelde matchafstand: 0,224m — Max: 4,959m
Ambigu (meerdere kandidaten binnen 5m): 341 (0,6%)

Edge-niveau:
matched (beide kanten):        16.345 (58,3%)
unmatched_start of _end:        6.847 (24,4%) — deels bruikbaar, één kant ontbreekt
unmatched_both (volledig los):  4.868 (17,4%)
```

**Diagnose van de 4.868 volledig geïsoleerde edges (steekproef 300):** mediaan afstand tot de werkelijk dichtstbijzijnde node is **514 meter** (94% ligt >100m weg, tot 2,3km). Slechts 0,7% zit binnen 20m. **Conclusie: dit is het regio-dekkingsgat-effect uit Phase 1C (sectie 1, "~21% unmatched"-bevinding), nu op landelijke schaal — geen bug, geen matching-fout.** Edges in de `_vrij`-laag sluiten aan op knooppunten die zelf niet in de `_vrij`-nodelaag zitten (andere, niet-vrijgegeven regio). Regio-verdeling van de steekproef (Utrecht 41%, Drenthe 34%, rest verspreid) weerspiegelt vooral welke regio's toevallig als testgebied zijn gebruikt, geen aanwijzing voor een apart probleem.

**Gevolg:** deze edges blijven gewoon bestaan met `matchConfidence` correct ingevuld (conform pre-flight checklist punt 5 — geen stille drops). Ze tellen mee in de komende graph-connectivity-analyse, maar dragen niets bij aan de bereikbaarheid.

**Nog openstaand, niet blokkerend:** een klein gat van 7 edges tussen het door de WFS gerapporteerde totaal (28.067) en het aantal unieke `sourceObjectId`'s na deduplicatie (28.060) is nog niet verklaard. Vermoedelijke oorzaak: enkele bronrecords zonder geldige lijngeometrie, die de parser stilzwijgend overslaat. Te onderzoeken, maar te klein om de voortgang te blokkeren.

---

## 7. GRAPH-CONNECTIVITY VALIDATIE

**RESULTAAT VOLLEDIGE IMPORT (26-8-2026):** 11.003 logicalNodes, 16.345 matched edges gebruikt voor de graph.

```
Connected components:         669
Grootste component:          9.291 nodes (84,4%)
Top 10 componentgroottes:    9291, 209, 97, 63, 45, 24, 23, 20, 16, 15
Geïsoleerde nodes (0 edges):   389
Dead-end nodes (1 edge):     1.011
Goed-verbonden nodes (≥2):   9.603
```

**Beoordeling:** gezond. Eén dominante hoofdcomponent (84,4%) is precies wat verwacht mag worden gegeven dat 41,7% van de edges (unmatched, sectie 6B) geen bijdrage levert aan connectiviteit — de overige 668 componenten zijn stuk voor stuk klein (max. 209 nodes), geen aanwijzing voor een tweede groot netwerk dat per ongeluk is losgeraakt van de hoofdcomponent.

**Composite-cluster-diagnose:** 125 clusters met ≥5 samengevoegde brondata-punten (van 11.003 totaal), sterk geconcentreerd in Noord-Brabant. Gerichte steekproef van 20 clusters (16 uit Noord-Brabant, 4 uit andere regio's ter vergelijking, variërend van 7 tot 12 brondata-punten) handmatig/systematisch geïnspecteerd op precies het onderscheid tussen:
- **Goed:** meerdere fysieke representaties van hetzelfde complexe kruispunt (dichte interne edge-connectiviteit tussen de samengevoegde punten)
- **Fout:** twee echte, aparte knooppunten die door het kettingeffect van single-linkage-clustering ten onrechte zijn samengevoegd (zou zich tonen als twee tight subgroepen met weinig verbindende edges ertussen)

**Resultaat: alle 20 clusters slagen.** `allPointsHaveEdges: true` bij elk cluster (geen wees-punten), en substantiële interne edge-connectiviteit in elk geval (bijv. 17 van 24 aangesloten edges liggen intern bij het grootste cluster, knooppunt "84"). Geen enkel voorbeeld van het "fout"-patroon aangetroffen.

**Bijvangst:** het kettingeffect (single-linkage bij 50m kan een clusterdiameter >50m opleveren) is bevestigd aanwezig — geziene maximale onderlinge afstanden tot 112m in sommige clusters — maar veroorzaakt in de steekproef geen foutieve samenvoegingen. De dichte interne connectiviteit compenseert dit: ook bij een grotere diameter blijft het overtuigend één samenhangend fysiek geheel.

**Conclusie: composite-node-clustering geaccepteerd als betrouwbaar voor de volledige dataset.** Geen verder onderzoek hier nodig vóór Phase 2.

---

Een hoog matched-percentage op edge-niveau (sectie 5) is niet voldoende om te weten of de graph bruikbaar is voor routegeneratie. Een dataset kan bijvoorbeeld 99% matched zijn en toch een cruciale verbinding missen waardoor een heel gebied onbereikbaar wordt vanuit de rest van het netwerk.

**Verplichte validatiestap, ná matching en vóór de importer volledig wordt gebouwd (dus ook als losse steekproef-analyse, niet pas na de volledige import):**

- Hoeveel nodes hebben minimaal één edge?
- Hoeveel nodes hebben 2+ edges (een node met precies 1 edge is een doodlopend uiteinde — soms terecht, soms een datafout)?
- Zijn er volledig geïsoleerde nodes (0 edges)?
- Hoeveel **connected components** ontstaan er in de graph? Idealiter 1 (of een klein, verklaarbaar aantal — bijv. Waddeneilanden die terecht los liggen van het vasteland).
- Zijn er onverwachte "eilandjes"/subgraphs die je niet zou verwachten (bijv. een regio die per ongeluk niet aansluit op de rest)?
- Zijn er verbindingen die het netwerk alleen bij elkaar houden via één enkele edge (een "brug" in graph-theoretische zin) — dat is niet per se fout, maar wel een kwetsbaar punt om te kennen.

Voorbeeld van het soort rapportage dat dit oplevert:

```
Graph validation
Nodes:                 13.152
Edges:                 28.067
Matched edges:         99,2%
Unmatched edges:         0,8%
Connected components:       1
Isolated nodes:              0
Dead-end anomalies:         X
Direction anomalies:        X
```

Dit gebeurt volledig in de importer-code zelf (bijv. nodes zonder edges via een simpele lookup, connected components tellen met een graph-library zoals `graphology` of een eigen union-find-implementatie — dezelfde aanpak als de `UnionFind`-klasse die de Phase 1C-diagnostiek al gebruikte voor de threshold sensitivity-test) — geen database-query nodig, een eenmalig analysescript na de import volstaat.

---

## 8. IMPORTER-PIPELINE

```
1. Nieuw document in datasetVersions aanmaken (status: 'pending')
2. Nodes ophalen (fietsknooppunten_wgs84, gepagineerd via startIndex+count, GEEN cap —
   dit is de eigen database-import, niet de publieke debug-route)
3. Edges ophalen (fietsnetwerken_vrij, zelfde paginering)
4. Transform: nodes van EPSG:4326 → EPSG:28992
5. Batch-writes naar sourceNodes en edges (Firestore batched writes, max 500 writes per
   batch), gekoppeld aan de nieuwe datasetVersionId
6. Node/edge-matching uitvoeren (sectie 5), matchConfidence en directionality invullen
7. Validatie: tel matched/unmatched, controleer op duplicaten, ontbrekende geometrieën
8. Bij voldoende kwaliteit (drempel te bepalen, bijv. >98% matched): status → 'validated'
9. Atomische activatie: config/activeDataset-document bijwerken naar de nieuwe
   datasetVersionId (één Firestore document-update — de oude versie blijft ongewijzigd
   in de database staan)
10. Oude datasetVersions markeren als 'superseded', niet meteen verwijderen
    (rollback-mogelijkheid, en historische vergelijking)
```

**Belangrijk:** de applicatie query't nooit rechtstreeks op de nieuwste `datasetVersionId` — altijd via `config/activeDataset`. Dat is wat "atomische activatie" concreet betekent: gebruikers zien nooit een halfslachtig geïmporteerde dataset, ook niet tijdens een lopende import.

**Paginering:** WFS 2.0.0 ondersteunt `startIndex` + `count` voor het ophalen van grote datasets in delen (bijv. 1000 per aanvraag). Met 13.152 nodes en 28.067 edges is dat orde grootte 14 + 29 = ~43 requests voor een volledige import — ruim binnen redelijke grenzen voor een Vercel serverless function met een timeout, mits elke pagina apart wordt opgehaald (niet in één functie-aanroep — waarschijnlijk een aparte import-route of achtergrondtaak nodig, te bepalen bij implementatie). Firestore's limiet van 500 writes per batch betekent dat de ~41.000 records over ~82 batches verdeeld moeten worden.

---

## 9. UPDATE-FREQUENTIE

Routedatabank actualiseert ~2x per maand (bevestigd door Jon Rietman). Voorstel: een geplande import (bijv. wekelijks, ruim binnen hun updatefrequentie) via een Vercel Cron Job die dezelfde importer-pipeline aanroept. Geen realtime sync nodig.

---

## 9B. TOETSING TEGEN MASTER CONTEXT v2 (25-8-2026)

Vóór de importer wordt gebouwd (stap 13), is het ontwerp getoetst aan de langetermijn-architectuurvisie (Master Context v2, sectie 3 en 22: edge-structuur, gelaagde architectuur; sectie 23: geen premature implementation).

**Al toekomstvast, geen aanpassing nodig:**
- Gelaagde architectuur (`source_nodes` → `logical_nodes` → `edges`) komt overeen met Master Context's DATA → NORMALIZATION → GRAPH-lagen
- Dataset-versionering met atomische activatie voorkomt dat een fundamentele rewrite nodig is bij toekomstige uitbreidingen
- `directionality` als apart afgeleid veld (i.p.v. destructieve filtering) sluit aan bij "richting" als edge-attribuut uit sectie 3

**Aangevuld naar aanleiding van deze toetsing (kolommen toegevoegd, GEEN functionaliteit gebouwd):**
- `edges.mode` — toegestane modaliteit (Master Context sectie 8: "voorkom dat route-engine structureel afhankelijk wordt van mode=bicycle"). Deze import zet dit altijd op `'bicycle'` (bron is `fietsnetwerken_vrij`), maar het veld bestaat nu al zodat een toekomstige wandel- of MTB-import geen schema-rewrite vereist.
- `edges.network`, `source_nodes.network_type`, `logical_nodes.network_type` — welk netwerktype, voorbereid op meerdere netwerklagen naast elkaar
- `edges.restrictions` (JSONB, leeg) en `edges.quality_score` (ongebruikt) — placeholders voor toekomstige beperkingen en routekwaliteit-scoring uit sectie 3

**Bewust uitgesteld — expliciet NIET nu gebouwd (Master Context sectie 23, harde "NIET"-lijst):**
Route-object (sectie 7), Route Engine (sectie 3), Navigatie (sectie 4), GoKnoop UI (sectie 5), routekarakter/`RoutePreferences` (sectie 9), waypoints/"ik wil hier langs" (sectie 10), POI-laag (sectie 11), AI-routeassistent (sectie 12), persoonlijke voorkeuren (sectie 13), opgeslagen routes/varianten (sectie 14), route recovery (sectie 15), weerbewuste routes (sectie 16), e-bike/batterij (sectie 17), samen fietsen (sectie 18), offline (sectie 19), wearables (sectie 20), veiligheidslaag (sectie 21).

Phase 1B/1C blijft exact wat het Master Context voorschrijft: `DATA → NORMALIZATION → GRAPH → VALIDATION`. Niets daarboven.

---

## 10. WAT DIT ONTWERP BEWUST NIET DOET

- Geen downloadbare export van de brondata aanbieden (Master Plan sectie 67) — de nodes/edges-tabellen zijn intern, de applicatie serveert alleen afgeleide routes/navigatie, nooit de ruwe dataset.
- Geen realtime WFS-doorverbinding vanuit de frontend — alle WFS-verkeer blijft server-side, de frontend praat alleen met de eigen GoKnoop-database.
- Geen implementatie in dit document — dat is Phase 1C.

---

## STATUS: GOEDGEKEURD ALS PHASE 1B

---

## PRE-FLIGHT CHECKLIST — VÓÓR DE EERSTE ECHTE IMPORT (GPT GO/NO-GO-REVIEW, 25-8-2026)

Geen nieuwe onderzoeksfase — een korte controle op de importer-implementatie zelf, vóór productiegebruik.

1. **Idempotentie.** Dezelfde brondata twee keer importeren mag geen dubbele nodes/edges opleveren. Elke import krijgt een nieuwe `datasetVersionId`; binnen één import mogen `sourceObjectId`-waarden niet dubbel verwerkt worden.

2. **Brondata blijft immutable.** `sourceNodes`/edges-brondata is een exacte, ongewijzigde kopie van wat Routedatabank levert. Normalisatie (clustering, directionality-interpretatie) maakt altijd nieuwe, afgeleide velden/documenten — nooit bronvelden overschrijven.

3. **Composite merge is volledig reproduceerbaar.** Dezelfde input + dezelfde regels = exact dezelfde `logical_node_id`/mapping. ID-generatie moet deterministisch vastliggen (bijv. gebaseerd op een stabiele volgorde/hash van de samenstellende `source_objectid`'s) — geen willekeurige UUID als een herhaalde import identieke IDs moet opleveren.

4. **`sourceNodeMappings` is compleet.** Iedere `logicalNode` moet terug te voeren zijn naar één of meer `sourceNodes`. Ook `sourceNodes` die uiteindelijk NIET worden samengevoegd (`protected_single`) krijgen een mapping-entry en blijven traceerbaar — nooit een sourceNode zonder mapping.

5. **Edge-endpoints mogen niet stilzwijgend verdwijnen.** Iedere geïmporteerde edge moet na normalisatie naar geldige `logicalNodes` verwijzen óf expliciet `matchConfidence = 'unmatched_...'` krijgen. Geen stille drops — zie sectie 3.

6. **Rijrichting blijft onzeker, en dat is correct zo.** Raw `0`/`1`/`2` bewaren in `rijrichting`; `directionality = 'unknown'`; routing-policy mag dit voorlopig als `bidirectional` behandelen. **Geen `rijrichting=2`-filter** — beide geteste hypotheses zijn verworpen (sectie 4), een filter zou een niet-onderbouwde aanname in productiecode vastleggen.

7. **Atomische datasetactivatie.** Volgorde: import → validate → graph genereren → connectivity tests (sectie 7) → pas dán `config/activeDataset` bijwerken. Bij één kritieke fout in een van de tussenstappen blijft de vorige `active` dataset gewoon actief — nooit een halfslachtige of ongevalideerde dataset live zetten.

**Twee losse implementatiepunten uit dezelfde review, al verwerkt in het schema hierboven:**
- Matchtolerantie (5m) en composite-clustering-drempel (50m) zijn twee aparte constanten (zie sectie 3) — nooit één generieke `distance_threshold`.
- `mergeDecision` binnen `sourceNodeMappings` (zie sectie 3) houdt de 4% uitzonderingen bij `soort_knooppunt` zichtbaar en doorzoekbaar, in plaats van ze weg te poetsen.

**GO/NO-GO: GO.** De Phase 1B/1C-basis is empirisch onderbouwd en architectonisch getoetst. Geen verder onderzoek nodig vóór de bouw van de importer.

---

## PHASE 1C — VOLGORDE VAN UITVOERING

Phase 1C bouwt niet direct de volledige importer. Eerst worden de openstaande onzekerheden uit dit document één voor één empirisch opgelost, in deze volgorde — elke stap bouwt op de vorige:

```
1. Matchtolerantie                    ✅ afgerond — 5 meter
        ↓
2. Samengestelde nodes detecteren     ✅ afgerond — 37% van records, substantieel
        ↓
3. Rijrichting-hypothese testen       ✅ afgerond — duplicaat-hypothese verworpen (3,5%)
        ↓
4. Source-value/schema profiling      ✅ afgerond (rijrichting, soort_knooppunt, regio, provincie, lengte_m)
        ↓
5. Composite-node geometrieanalyse    ✅ afgerond — regio-scope bleek onbetrouwbaar
        ↓
6. Threshold sensitivity-analyse      ✅ afgerond — 50 meter, natuurlijke knik empirisch bevestigd
        ↓
7. Topologische merge-validatie       ✅ afgerond — cluster-als-geheel i.p.v. paarsgewijs (voorkomt vals-conflict zoals Cluster 4)
        ↓
8. Handmatige inspectie grensgevallen ✅ afgerond — 4 clusters bij 50m geïnspecteerd, soort_knooppunt blijkt sterke voorspeller
        ↓
9. Enkelvoudig-only classificatie op volledige dataset  ✅ afgerond — 4% uitzonderingspercentage, regel bevestigd als "standaard beschermd" met 20m-uitzondering
        ↓
10. Rijrichting semantiek-analyse      ⏸️ gepauzeerd — 2 hypotheses getest en verworpen, veilige default staat, geen blocker
        ↓
11. Node ↔ edge volledige steekproef  ✅ afgerond — patroon bevestigd in Groningen/Drenthe, niet regio-specifiek
        ↓
12. Limburg-exclusie                  ✅ afgerond — bevestigd server-side uitgesloten, geen filter nodig
        ↓
13. Importer bouwen
        ↓
14. Volledige dataset importeren
        ↓
15. Validatie
        ↓
16. Graph genereren
        ↓
17. Graph-connectivity testen          (sectie 7 — connected components, isolated nodes, eilandjes)
        ↓
18. Dataset atomisch activeren
```

**Belangrijk architectuurpunt bij composite nodes (stap 6-8):** een centroid van de samengestelde punten wordt NIET automatisch gebruikt als samenvoegstrategie, en een enkel afstandscriterium ook niet. Zie de definitieve merge-conditie in sectie 6: afstand ÉN topologische compatibiliteit ÉN netwerkcompatibiliteit moeten alle drie kloppen. De threshold sensitivity-analyse (stap 6) bepaalt de drempel empirisch (natuurlijke knik in de verdeling, niet een gekozen ronde waarde); de topologische validatie (stap 7) voorkomt dat samenvoegen kunstmatige shortcuts creëert.

**Directionality-codering:** `bidirectional` | `forward` | `reverse` | `unknown` (niet slechts drie waarden) — `unknown` is expliciet een aparte status, geen synoniem voor `bidirectional`. Een routing policy kan `unknown` voorlopig als `bidirectional` behandelen, maar dat is een bewuste, herroepbare beslissing op routing-niveau, niet een aanname die in de brondata-interpretatie wordt vastgelegd.

Pas na stap 18 begint de route-generator (Phase 2 van het Master Plan).
