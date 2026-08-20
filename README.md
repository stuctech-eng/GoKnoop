# GoKnoop

Knooppunt-first fietsrouteplatform. Zie Master Plan v1.0 (CodeSnap) voor volledige productvisie en architectuur.

## STATUS

Phase 1A — WFS/API Discovery: scaffold gereed, wachtend op environment variables in Vercel.

Nog geen frontend-features gebouwd (bewust, volgens Master Plan sectie 84: "NIET BEGINNEN MET FRONTEND").

## SETUP

1. In Vercel → GoKnoop → Settings → Environment Variables, zet:
   - `ROUTEDATABANK_URL` = `https://kaarten.routedatabank.nl/geoserver/routedatabank/wfs`
   - `ROUTEDATABANK_USER` = `goknoop`
   - `ROUTEDATABANK_PASS` = (wachtwoord uit de e-mail van Jon Rietman — nooit in git zetten)
   - `DEBUG_SECRET` = (zelf gekozen willekeurige string, optioneel maar aanbevolen)

2. Deploy (automatisch via GitHub → Vercel).

## DEBUG / DISCOVERY ROUTE

`GET /api/debug/wfs`

Server-side proxy naar de Routedatabank WFS. Credentials verlaten de server nooit.

Query parameters:
- `request` — `GetCapabilities` (default), `DescribeFeatureType`, of `GetFeature`
- `key` — vereist als `DEBUG_SECRET` is ingesteld
- overige WFS-parameters (bijv. `typeName`) worden doorgestuurd

`GetFeature`-requests worden altijd gelimiteerd tot maximaal 10 resultaten — deze route is een audit-tool, geen dataset-exportendpoint (zie Master Plan sectie 67).

Voorbeelden:
```
/api/debug/wfs?key=JOUW_SECRET
/api/debug/wfs?key=JOUW_SECRET&request=DescribeFeatureType&typeName=<laagnaam>
/api/debug/wfs?key=JOUW_SECRET&request=GetFeature&typeName=<laagnaam>
```

## VOLGENDE STAP

Zodra de env vars staan: GetCapabilities ophalen en analyseren welke lagen, velden, geometrieën en identifiers beschikbaar zijn. Resultaat wordt vastgelegd in een data-auditrapport (Master Plan sectie 8), waarna pas het definitieve datamodel en de importer worden ontworpen.

## PRIVACY & DATA

Routedatabank-data mag niet worden doorgeleverd aan derden. Deze debugroute is uitsluitend voor onderzoek tijdens ontwikkeling en dient na Phase 1A afgeschermd of verwijderd te worden.
