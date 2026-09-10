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

*Dit document wordt gedurende het hele traject aangevuld, nooit met terugwerkende kracht overschreven. Volgende toevoeging: FASE B — Architectuur.*
