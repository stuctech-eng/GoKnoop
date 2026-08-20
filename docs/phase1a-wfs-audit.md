# GoKnoop — Phase 1A: WFS/API Discovery — Auditrapport

**Datum:** 20 augustus 2026
**Bron:** Routedatabank (Wandelnet / Fietsplatform / NTFU)
**WFS-endpoint:** `https://kaarten.routedatabank.nl/geoserver/routedatabank/wfs`
**Account:** `goknoop`

---

## STATUS PER OPERATIE

| Operatie | Status | Toelichting |
|---|---|---|
| Authenticatie (Basic Auth) | ✅ Werkt | Credentials bevestigd correct — server retourneert echte structuur i.p.v. 401 |
| GetCapabilities | ✅ Werkt | Volledige laagstructuur opgehaald |
| DescribeFeatureType | ✅ Werkt | Schema van 2 kernlagen opgehaald |
| GetFeature | ⚠️ Geblokkeerd | Consistent `403 Forbidden — Request forbidden by administrative rules`, ongeacht outputFormat, CRS of count. Vermoedelijke oorzaak: blokkade van cloud-hosting IP-reeksen (Vercel) door Routedatabank's server, specifiek op deze operatie. Ligt bij Routedatabank, niet bij GoKnoop-configuratie. Uitstaand bij Jon Rietman. |

---

## 1. GEVONDEN LAGEN (relevant voor MVP)

| Laag | Type | Omschrijving |
|---|---|---|
| `fietsknooppunten` | Punten | Fietsknooppunten van fietsnetwerken in Nederland (NL-dekkend) |
| `fietsknooppunten_vrij` | Punten | Subset: regio's die open data verstrekken |
| `fietsknooppunten_wgs84` | Punten | Zelfde data, al in WGS84 |
| `fietsknooppuntnetwerken` | Lijnen | Verbindingen tussen knooppunten (edges) |
| `fietsnetwerkregio` | — | Regio-metadata |

**Uitgesloten:** `fietsknooppunten_nlfietsland` — expliciet gemarkeerd als "betaald voor Routemaker van Irias", valt buiten onze toegang.

**Aanwezig maar niet voor MVP (bevestigt toekomstige uitbreidbaarheid uit Master Plan):**
`mountainbikeroutes`, `wandelknooppunten`, `wandelnetwerken`, `wandelknooppunten_vrij_wgs84`, `lf_routes`, `law_routes`, `law_routes_vrij`, `ns_wandelingen`, `streekpaden`, `stad_te_voet`, `ov_stappers`, `onderhoudsregios`.

---

## 2. ATTRIBUTEN — `fietsknooppunten`

| Veld | Type | Verplicht | Omschrijving |
|---|---|---|---|
| `objectid` | int | ✅ | Interne database-ID |
| `knooppuntnr` | string | | Zichtbaar knooppuntnummer (bijv. "47") |
| `regio` | string | | |
| `provincie` | string | | |
| `uitlev_akk` | string | | Vermoedelijk "uitlevering akkoord" — leveringsrecht-vlag |
| `soort_knooppunt` | string | | |
| `last_edited_date` | dateTime | | |
| `puntid` | int | | Mogelijk secundaire identifier |
| `wkb_geometry` | gml:Point | | Geometrie |

**CRS:** default EPSG:28992 (RD New), alternatief EPSG:4326 (WGS84)

---

## 3. ATTRIBUTEN — `fietsknooppuntnetwerken`

| Veld | Type | Verplicht | Omschrijving |
|---|---|---|---|
| `ogc_fid` | int | | |
| `objectid` | int | | |
| `regio` | string | | |
| `rijrichting` | string | | Rijrichting van de verbinding |
| `provincie` | string | | |
| `last_edited_date` | dateTime | | |
| `lokaalid` | int | | |
| `lengte_m` | int | | Lengte in meters |
| `shape_length` | double | | |
| `uitlev_akk` | string | | |
| `wkb_geometry` | gml:Curve (LineString) | | Geometrie |

**CRS:** default EPSG:28992, alternatief EPSG:4326

---

## 4. IDENTIFIERS

- `knooppuntnr` — het publieke, zichtbare knooppuntnummer op `fietsknooppunten`
- `objectid` / `puntid` — interne database-ID's
- Geen enkel veld op `fietsknooppuntnetwerken` verwijst naar `knooppuntnr` of `objectid` van `fietsknooppunten`

---

## 5. NODE/EDGE-RELATIE — KERNBEVINDING

**`fietsknooppuntnetwerken` bevat geen `from_node`/`to_node`-velden.**

Er is dus geen directe foreign-key-relatie tussen edges en nodes. De graph kan niet via ID-koppeling worden opgebouwd. De meest waarschijnlijke aanpak is **ruimtelijke matching**: het eindpunt van een edge-lijngeometrie vergelijken met de coördinaten van node-punten (binnen een kleine tolerantie, bijv. enkele meters, i.v.m. afrondingsverschillen).

**Dit is nog niet bevestigd met echte featuredata** — GetFeature is nog niet beschikbaar geweest. Zodra dat werkt, moet als eerste stap worden geverifieerd:
1. Komen edge-eindpunten exact (of binnen tolerantie) overeen met node-coördinaten?
2. Is er een consistente tolerantiewaarde nodig, en zo ja welke?
3. Zijn er edges zonder matchende node aan een of beide uiteinden (datakwaliteitsprobleem)?

---

## 6. MOGELIJKE GRAPH-AANPAK

Voorlopig voorstel (te valideren zodra GetFeature werkt):

1. Importeer alle `fietsknooppunten` als graph-nodes, met `knooppuntnr` als publieke identifier en `objectid`/`puntid` als interne referentie.
2. Importeer alle `fietsknooppuntnetwerken` als graph-edges.
3. Voor elke edge: bepaal start- en eindcoördinaat van de lijngeometrie, zoek de dichtstbijzijnde node binnen een tolerantie (bijv. 5–10 meter in EPSG:28992).
4. Sla de afgeleide `from_node_id` / `to_node_id` op in de eigen GoKnoop-database (niet in de brondata — dit is een lokale verrijking).
5. Log edges die geen matchende node vinden als datakwaliteitsissue, niet als harde fout.

---

## 7. DATAKWALITEITSPROBLEMEN / OPEN PUNTEN

- **GetFeature geblokkeerd** — kernblocker voor Phase 1B. Alle bovenstaande aannames over data (aantallen, daadwerkelijke node/edge-matching, kwaliteit van `uitlev_akk`-vlag) zijn nog niet met echte data geverifieerd.
- `uitlev_akk` (leveringsrecht per record) — moet worden gecontroleerd of deze per-record gefilterd moet worden, los van de regio-brede toegang die is verleend. Mogelijk bevat de dataset ook records waarvoor `uitlev_akk` niet akkoord is.
- Limburg-uitzondering nog niet zichtbaar in attributen — moet blijken of `regio`/`provincie` gebruikt kan worden om deze twee regio's uit te sluiten, of dat de server dit al server-side filtert voor het `goknoop`-account.

---

## 8. VOORSTEL DATAMODEL

**Nog niet definitief.** Voorlopige richting volgt het datamodel uit het Master Plan (sectie 9), met deze aanpassingen op basis van de echte schema's:

- `NODE.number` ↔ `knooppuntnr` (string, niet int — kan voorloopnullen of letters bevatten, te bevestigen)
- `NODE.source_id` ↔ `objectid`
- `EDGE` heeft in de bron geen node-referenties — `from_node`/`to_node` worden een **afgeleid** veld, berekend tijdens import, niet rechtstreeks uit de bron overgenomen
- `EDGE.distance_m` ↔ `lengte_m` (bron levert dit al, hoeft niet herberekend te worden uit geometrie)

Definitieve versie volgt na Phase 1A-afronding (GetFeature werkend) en validatie van punt 5 en 6.

---

## VOLGENDE STAP

Wachten op reactie Jon Rietman over GetFeature-blokkade. Zodra bevestigd/opgelost: GetFeature-sample ophalen, node/edge-matching valideren, en Phase 1A definitief afsluiten met bijgewerkt datamodel (Phase 1B kan dan starten).
