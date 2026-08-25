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

-- Nodes: knooppunten
CREATE TABLE nodes (
    id              BIGSERIAL PRIMARY KEY,
    dataset_version_id BIGINT NOT NULL REFERENCES dataset_versions(id),
    source_objectid BIGINT NOT NULL,       -- objectid uit fietsknooppunten_wgs84
    number          TEXT NOT NULL,          -- knooppuntnr (string, niet int)
    regio           TEXT,
    provincie       TEXT,
    soort_knooppunt TEXT,
    geom            GEOMETRY(Point, 28992) NOT NULL,  -- opgeslagen in RD New voor matchprecisie
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_nodes_geom ON nodes USING GIST (geom);
CREATE INDEX idx_nodes_dataset ON nodes (dataset_version_id);
CREATE INDEX idx_nodes_number ON nodes (dataset_version_id, number);

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
    from_node_id        BIGINT REFERENCES nodes(id),  -- AFGELEID, niet uit bron
    to_node_id          BIGINT REFERENCES nodes(id),  -- AFGELEID, niet uit bron
    match_confidence     TEXT,               -- 'matched' | 'unmatched_start' | 'unmatched_end' | 'unmatched_both'
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_edges_geom ON edges USING GIST (geom);
CREATE INDEX idx_edges_dataset ON edges (dataset_version_id);
CREATE INDEX idx_edges_from ON edges (from_node_id);
CREATE INDEX idx_edges_to ON edges (to_node_id);

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

De steekproef toont een `rijrichting`-veld met geziene waarden `0` en `1` (numeriek/enum, geen vrije tekst). Dit is nog niet geïnterpreteerd en heeft directe gevolgen voor het graphmodel:

**Update 25-8-2026:** empirische steekproef (917 edges) bevestigt drie waarden, niet twee: `0` (688×, 75%), `1` (143×, 16%), `2` (86×, 9%). De aanname van een simpele bidirectioneel/eenrichting-codering met twee waarden klopt dus niet — er is een derde categorie die nog niet verklaard is (mogelijk: onbekend/niet-geregistreerd, of een tweede type beperking zoals "verplichte rijrichting voor bromfietsers" of vergelijkbaar). Dit moet worden opgehelderd voordat `directionality` betrouwbaar kan worden afgeleid.

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
- **`soort_knooppunt` met waarden als "Samengesteld_aan"/"Samengesteld_uit" — BEVESTIGD SUBSTANTIEEL, geen randgeval.** Empirische steekproef (449 nodes): 165 van de 449 records (37%) zijn "Samengesteld" (aan of uit), en 98 unieke knooppuntnummers hebben meerdere records — tot 8 records onder één nummer (bijv. nr. "10"). De hypothese dat één logisch knooppunt uit meerdere fysieke puntrecords kan bestaan is dus bevestigd én het komt vaak genoeg voor dat de importer dit expliciet moet afhandelen (samenvoegen tot één logische node), niet als uitzondering behandelen.
- **Schema-afwijking tussen `fietsnetwerken_vrij` en het eerder via DescribeFeatureType geziene `fietsknooppuntnetwerken`:** de `_vrij`-laag heeft `lokaalid` in plaats van `ogc_fid`. Importer moet robuust zijn tegen dit soort kleine schemaverschillen tussen laagvarianten.
- **Limburg-uitzondering:** nog niet expliciet zichtbaar in `regio`/`provincie`-waarden uit de steekproef (die toonde alleen Utrecht/Gooi en Vechtstreek). Bij volledige import controleren of Limburgse regio's al server-side ontbreken, of dat er alsnog een filter nodig is.

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
1. Matchtolerantie-steekproef       (sectie 5, punt 3)
        ↓
2. Onderzoek samengestelde knooppunten   (sectie 6 — Samengesteld_aan/uit)
        ↓
3. Onderzoek rijrichting              (sectie 4 — directionaliteit)
        ↓
4. Controleer node ↔ edge relaties    (matching op grotere steekproef, met 1+2+3 verwerkt)
        ↓
5. Controleer Limburg-exclusie        (sectie 6)
        ↓
6. Importer bouwen                    (sectie 8, pipeline)
        ↓
7. Volledige dataset importeren
        ↓
8. Validatie                          (matched/unmatched-percentage, duplicaten)
        ↓
9. Graph genereren
        ↓
10. Graph-connectivity testen          (sectie 7 — connected components, isolated nodes, eilandjes)
        ↓
11. Dataset atomisch activeren
```

Pas na stap 11 begint de route-generator (Phase 2 van het Master Plan).
