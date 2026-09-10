/**
 * NWB-geometrie-resolver -- Fase M (Geometry Integration Audit), 9-9-2026.
 *
 * WAAROM DIT BESTAAT: SlimNwbSegment (combined-graph.ts) bevat bewust geen
 * volledige polylijn-geometrie -- alleen from/to/lengthM, om Firestore's
 * documentgrootte-limiet te vermijden (zie nwb-collector-tick/route.ts,
 * functie toSlim(), commentaar bij regel 14-18). Dat is voldoende om een
 * route te BEREKENEN (afstand, topologie), niet om 'm op een kaart te
 * TEKENEN.
 *
 * AANPAK: geometrie LIVE bij PDOK opvragen -- alleen voor de paar tientallen
 * segmenten die een specifieke, AL BEREKENDE route daadwerkelijk gebruikt.
 * WFS 2.0's `resourceId`-parameter (meerdere features in één aanroep).
 *
 * *** STATUS: LIVE GEVERIFIEERD, 10-9-2026 ***
 * Bevestigd via de debug-pagina (app/debug/test-nwb-geometry-resolver):
 * `resourceId` werkt correct, met de ID EXACT zoals opgeslagen (bv.
 * "wegvakken.c77ea6a6-...", GEEN "nwbwegen:"-prefix -- die prefix geeft juist
 * een InvalidParameterValue-fout). HTTP 200, volledige MultiLineString-
 * geometrie met alle tussenpunten correct terugontvangen voor 2/2
 * testsegmenten. Zie Decision Log voor de volledige, geverifieerde
 * bevindingen.
 */

const NWB_WFS_BASE = "https://service.pdok.nl/rws/nwbwegen/wfs/v1_0";
const NWB_TYPE_NAME = "nwbwegen:wegvakken";
const MAX_IDS_PER_REQUEST = 100; // voorzichtige aanname, niet bevestigd tegen de dienst

export type NwbGeometryResult = {
  resolved: Map<string, { x: number; y: number }[]>;
  failed: string[];
};

function parseFeatureCollection(rawText: string): { id: string; geometry: { type: string; coordinates: number[][] | number[][][] } }[] {
  let geojson: { features: { id: string; geometry: { type: string; coordinates: number[][] | number[][][] } }[] };
  try {
    geojson = JSON.parse(rawText);
  } catch {
    throw new Error(`PDOK gaf geen geldige JSON terug. Eerste 300 tekens: ${rawText.slice(0, 300)}`);
  }
  if (!Array.isArray(geojson.features)) {
    throw new Error(`PDOK-respons had geen 'features'-array. Eerste 300 tekens: ${rawText.slice(0, 300)}`);
  }
  return geojson.features;
}

function extractCoordinates(geometry: { type: string; coordinates: number[][] | number[][][] }): { x: number; y: number }[] | null {
  let coords: number[][];
  if (geometry.type === "LineString") {
    coords = geometry.coordinates as number[][];
  } else if (geometry.type === "MultiLineString") {
    coords = (geometry.coordinates as number[][][]).flat();
  } else {
    return null;
  }
  return coords.map(([x, y]) => ({ x, y }));
}

/**
 * *** GECORRIGEERD 10-9-2026, na live verificatie via de debug-pagina ***
 * Eerdere versie voegde onterecht een `nwbwegen:wegvakken.`-prefix toe aan
 * ID's die al het formaat `wegvakken.xxx` hadden -- dat gaf een
 * `InvalidParameterValue`-fout (`msWFSGetFeature()... Invalid typename
 * given with FeatureId`). Live bevestigd: de dienst verwacht de ID EXACT
 * zoals opgeslagen, zonder enige prefix. Geen transformatie meer nodig.
 */
export async function resolveNwbGeometry(segmentIds: string[]): Promise<NwbGeometryResult> {
  const resolved = new Map<string, { x: number; y: number }[]>();
  const failed: string[] = [];

  for (let i = 0; i < segmentIds.length; i += MAX_IDS_PER_REQUEST) {
    const batch = segmentIds.slice(i, i + MAX_IDS_PER_REQUEST);
    const resourceIds = batch.join(",");

    const params = new URLSearchParams({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeNames: NWB_TYPE_NAME,
      outputFormat: "application/json",
      srsName: "EPSG:28992",
      resourceId: resourceIds,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch(`${NWB_WFS_BASE}?${params.toString()}`, {
        headers: { "User-Agent": "GoKnoop-geometry-resolver/1.0" },
        cache: "no-store",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        failed.push(...batch);
        continue;
      }

      const rawText = await res.text();
      const features = parseFeatureCollection(rawText);
      const foundIds = new Set<string>();

      for (const f of features) {
        const coords = extractCoordinates(f.geometry);
        if (!coords) continue;
        resolved.set(f.id, coords);
        foundIds.add(f.id);
      }

      for (const id of batch) {
        if (!foundIds.has(id)) failed.push(id);
      }
    } catch {
      clearTimeout(timeoutId);
      failed.push(...batch);
    }
  }

  return { resolved, failed };
}
