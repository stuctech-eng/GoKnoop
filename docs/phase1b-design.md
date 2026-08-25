# GoKnoop — Phase 1B: Data Model + Importer Design

**Datum:** 25 augustus 2026
**Status:** Ontwerp — nog niet geïmplementeerd (dat is Phase 1C)
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

**Voorstel: Supabase (PostgreSQL + PostGIS).**

Redenen:
- Master Plan sectie 10 schrijft PostgreSQL + PostGIS voor als voorkeursdatabase (spatial indexes, nearest-neighbor queries, geometrieberekeningen)
- Supabase is al onderdeel van de bestaande toolset (gebruikt in Polder) — geen nieuwe leverancier, wel een nieuwe database naast Firebase
- Vercel + Supabase is een beproefde combinatie in de rest van de projectenportfolio

**Let op — dit wijkt af van de meeste andere GoKnoop-achtige projecten die op Firebase draaien.** Firestore heeft geen bruikbare geo-spatial queries (geen PostGIS-equivalent), dus voor GoKnoop specifiek is Supabase de juiste keuze, niet Firebase. Dit is een bewuste afwijking, geen inconsistentie.

---

## 3. DATAMODEL (PostGIS-schema, definitief voorstel)

```sql
-- Dataset-versies: elke import krijgt een eigen versie, activatie gebeurt atomisch
CREATE TABLE dataset_versions (
    id            BIGSERIAL PRIMARY KEY,
    source        TEXT NOT NULL DEFAULT 'routedatabank',
    imported_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    status        TEXT NOT NULL DEFAULT 'pending', -- pending | validated | active | superseded | failed
    node_count    INTEGER,
    edge_count    INTEGER,
    validation_result JSONB
);

-- Nodes-datamodel in drie lagen (herzien 25-8-2026, na GPT-review):
-- bronidentiteit en applicatie-identiteit worden nooit door elkaar gehaald.
--
-- SOURCE_NODES: exacte kopie van wat Routedatabank levert, ongewijzigd.
-- LOGICAL_NODES: het knooppunt zoals de GoKnoop-graph het gebruikt (routing-eenheid).
-- De koppeling ertussen (welke source_nodes vormen samen welke logical_node) is zelf
-- een aparte, herleidbare mapping-tabel — nooit een destructieve samenvoeging.

CREATE TABLE source_nodes (
    id                  BIGSERIAL PRIMARY KEY,
    dataset_version_id  BIGINT NOT NULL REFERENCES dataset_versions(id),
    source_objectid     BIGINT NOT NULL,   -- objectid uit fietsknooppunten_vrij/wgs84
    knooppuntnr         TEXT NOT NULL,      -- ruwe brondata — GEEN unieke sleutel (zie sectie 6)
    regio               TEXT NOT NULL,      -- ruwe brondata — ook GEEN garantie op unieke identiteit
    provincie           TEXT,
    soort_knooppunt     TEXT,
    network_type        TEXT NOT NULL DEFAULT 'fiets',  -- Master Context sectie 8: niet hardcoded aan
                                                          -- fiets — deze import is altijd 'fiets'
                                                          -- (bron = fietsknooppunten_vrij), voorbereid op
                                                          -- toekomstige wandel-/MTB-knooppuntlagen
    geom                GEOMETRY(Point, 28992) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_source_nodes_geom ON source_nodes USING GIST (geom);
CREATE INDEX idx_source_nodes_dataset ON source_nodes (dataset_version_id);
CREATE INDEX idx_source_nodes_regio_nr ON source_nodes (dataset_version_id, regio, knooppuntnr);

CREATE TABLE logical_nodes (
    id              BIGSERIAL PRIMARY KEY,
    dataset_version_id BIGINT NOT NULL REFERENCES dataset_versions(id),
    display_number  TEXT NOT NULL,   -- afgeleid: knooppuntnr van (doorgaans) het representatieve source_node
    display_regio   TEXT NOT NULL,
    network_type    TEXT NOT NULL DEFAULT 'fiets',  -- zie source_nodes.network_type
    geom            GEOMETRY(Point, 28992) NOT NULL,  -- afgeleid: bijv. centroid van gekoppelde source_nodes
    cluster_method  TEXT NOT NULL,    -- 'single' (1-op-1) | 'spatial_cluster' (samengevoegd)
    cluster_threshold_m INTEGER,      -- welke afstandsdrempel toegepast is, indien clustered
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_logical_nodes_geom ON logical_nodes USING GIST (geom);
CREATE INDEX idx_logical_nodes_dataset ON logical_nodes (dataset_version_id);

-- Herleidbare koppeling: welke source_nodes vormen samen welke logical_node.
-- Blijft ALTIJD bewaard, ook na activatie — nooit overschreven of samengevoegd weggegooid.
CREATE TABLE logical_node_sources (
    logical_node_id BIGINT NOT NULL REFERENCES logical_nodes(id),
    source_node_id  BIGINT NOT NULL REFERENCES source_nodes(id),
    PRIMARY KEY (logical_node_id, source_node_id)
);

-- Edges: verbindingen tussen knooppunten
CREATE TABLE edges (
    id                  BIGSERIAL PRIMARY KEY,
    dataset_version_id  BIGINT NOT NULL REFERENCES dataset_versions(id),
    source_objectid     BIGINT NOT NULL,   -- objectid uit fietsnetwerken_vrij
    regio               TEXT,
    provincie           TEXT,
    rijrichting         TEXT,
    distance_m          INTEGER,            -- lengte_m uit de bron
    geom                GEOMETRY(LineString, 28992) NOT NULL,
    from_node_id        BIGINT REFERENCES logical_nodes(id),  -- AFGELEID, niet uit bron
    to_node_id          BIGINT REFERENCES logical_nodes(id),  -- AFGELEID, niet uit bron
    match_confidence     TEXT,               -- 'matched' | 'unmatched_start' | 'unmatched_end' | 'unmatched_both'
    -- Toekomstvaste velden (Master Context v2 sectie 3, 8, 22) — nu alleen als kolom,
    -- functionaliteit die erop bouwt wordt NIET nu gebouwd (sectie 23: geen premature implementation):
    mode                TEXT NOT NULL DEFAULT 'bicycle',  -- toegestane modaliteit; deze import is altijd 'bicycle'
                                                            -- (bron = fietsnetwerken_vrij), voorkomt latere rewrite
                                                            -- zodra wandel/MTB-lagen worden toegevoegd
    network             TEXT,               -- welk netwerktype (regionaal fietsnetwerk, LF-route, etc.)
    restrictions         JSONB,              -- toekomstige beperkingen (leeg in Phase 1, structuur al aanwezig)
    quality_score        NUMERIC,            -- toekomstige routekwaliteit-scoring (ongebruikt in Phase 1)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_edges_geom ON edges USING GIST (geom);
CREATE INDEX idx_edges_dataset ON edges (dataset_version_id);
CREATE INDEX idx_edges_from ON edges (from_node_id);
CREATE INDEX idx_edges_to ON edges (to_node_id);
CREATE INDEX idx_edges_mode ON edges (mode);  -- voorbereid op toekomstige multi-modaliteit queries

-- Actieve versie: precies één rij, wijst naar de dataset_version die live staat
CREATE TABLE active_dataset (
    singleton   BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    dataset_version_id BIGINT NOT NULL REFERENCES dataset_versions(id)
);
```

**Waarom `from_node_id`/`to_node_id` nullable zijn:** niet elke edge hoeft aan beide kanten een matchende node te hebben (zie sectie 6, datakwaliteit). Een edge zonder volledige match wordt niet stilzwijgend genegeerd, maar opgeslagen met `match_confidence` zodat de omvang van het probleem zichtbaar en meetbaar is.

**Waarom alles in RD New (EPSG:28992) staat:** matchtolerantie werkt het natuurlijkst in meters. WGS84 (lat/lon) vervormt afstanden afhankelijk van breedtegraad. Nodes uit `fietsknooppunten_wgs84` worden dus bij import geconverteerd naar EPSG:28992 (`ST_Transform`).

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

**Gevolg voor het datamodel:** `edges` krijgt een extra kolom `directionality` (`bidirectional` | `forward_only` | `backward_only`), afgeleid van `rijrichting` tijdens import — niet 1-op-1 overgenomen totdat de codering bevestigd is.

```sql
ALTER TABLE edges ADD COLUMN directionality TEXT NOT NULL DEFAULT 'bidirectional';
-- Waarden: 'bidirectional' | 'forward_only' | 'backward_only'
-- 'forward_only'/'backward_only' verwijzen naar de richting van de brongeometrie
-- (ST_StartPoint → ST_EndPoint = 'forward')
```

---

## 5. NODE/EDGE MATCHING-ALGORITME

Voor elke edge:

1. Bepaal het eerste punt (`ST_StartPoint`) en laatste punt (`ST_EndPoint`) van de lijngeometrie.
2. Zoek voor elk eindpunt de dichtstbijzijnde node binnen een tolerantie, met PostGIS `ST_DWithin` + `ORDER BY geom <-> point LIMIT 1` (index-versneld via de GIST-index).
3. **Matchtolerantie: 5 meter (empirisch bevestigd, 25-8-2026).** Steekproef van 449 nodes / 917 edges (bbox rond Utrecht/Gooi en Vechtstreek) toont: mediaan afstand tot dichtstbijzijnde node is **0,00 meter** (veel exacte coördinaat-matches), 77,7% matcht al binnen 2m, en oprekken tot 50m voegt slechts 1 procentpunt toe (78,8%). Een ruimere tolerantie dan ~5m levert dus geen echte winst en vergroot alleen het risico op foutieve matches. **Definitieve waarde: 5 meter.**

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

## 7. GRAPH-CONNECTIVITY VALIDATIE

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

PostGIS/SQL kan dit deels zelf (bijv. nodes zonder edges via een LEFT JOIN), maar het tellen van connected components vraagt om een graph-library (bijv. in Python met `networkx`, na export van de node/edge-lijst) — dat hoeft niet in de database zelf te gebeuren, een eenmalige analysescript volstaat.

---

## 8. IMPORTER-PIPELINE

```
1. Nieuwe dataset_versions-rij aanmaken (status: 'pending')
2. Nodes ophalen (fietsknooppunten_wgs84, gepagineerd via startIndex+count, GEEN cap —
   dit is de eigen database-import, niet de publieke debug-route)
3. Edges ophalen (fietsnetwerken_vrij, zelfde paginering)
4. Transform: nodes van EPSG:4326 → EPSG:28992
5. Bulk-insert nodes en edges, gekoppeld aan de nieuwe dataset_version_id
6. Node/edge-matching uitvoeren (sectie 5), match_confidence en directionality invullen
7. Validatie: tel matched/unmatched, controleer op duplicaten, ontbrekende geometrieën
8. Bij voldoende kwaliteit (drempel te bepalen, bijv. >98% matched): status → 'validated'
9. Atomische activatie: active_dataset.dataset_version_id bijwerken naar de nieuwe versie
   (één UPDATE-statement — de oude versie blijft ongewijzigd in de database staan)
10. Oude dataset_version(s) markeren als 'superseded', niet meteen verwijderen
    (rollback-mogelijkheid, en historische vergelijking)
```

**Belangrijk:** de applicatie query't nooit rechtstreeks op de nieuwste `dataset_version_id` — altijd via `active_dataset`. Dat is wat "atomische activatie" concreet betekent: gebruikers zien nooit een halfslachtig geïmporteerde dataset, ook niet tijdens een lopende import.

**Paginering:** WFS 2.0.0 ondersteunt `startIndex` + `count` voor het ophalen van grote datasets in delen (bijv. 1000 per aanvraag). Met 13.152 nodes en 28.067 edges is dat orde grootte 14 + 29 = ~43 requests voor een volledige import — ruim binnen redelijke grenzen voor een Vercel serverless function met een timeout, mits elke pagina apart wordt opgehaald (niet in één functie-aanroep — waarschijnlijk een aparte import-route of achtergrondtaak nodig, te bepalen bij implementatie).

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
