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
 * AANPAK: in plaats van alsnog alle ~144k segmenten met volledige geometrie
 * op te slaan (zelfde opslagprobleem terug), wordt geometrie LIVE bij PDOK
 * opgehaald -- alleen voor de paar tientallen segmenten die een specifieke,
 * AL BEREKENDE route daadwerkelijk gebruikt. WFS 2.0 ondersteunt hiervoor
 * de standaard `resourceId`-parameter (meerdere features in één aanroep).
 *
 * *** BELANGRIJKE, EERLIJKE STATUS ***
 * Deze module is NIET geverifieerd tegen een levende PDOK-aanroep. De
 * sandbox-omgeving waarin dit is gebouwd blokkeert uitgaand verkeer naar
 * service.pdok.nl (bevestigd: HTTP 403, x-deny-reason: host_not_allowed --
 * een beperking van de ontwikkelomgeving, geen aanname over PDOK zelf).
 * De `resourceId`-parameter is onderdeel van de officiële WFS 2.0-standaard
 * (in tegenstelling tot CQL_FILTER, dat eerder in dit project een
 * vendor-extensie bleek te zijn die deze dienst stilzwijgend negeerde) --
 * maar dat is een redelijke verwachting, GEEN bevestigd feit voor deze
 * specifieke dienst. Test dit expliciet vóór integratie in de route-flow.
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
 * Haalt volledige geometrie op voor specifieke NWB-segment-ID's, via de WFS
 * 2.0 `resourceId`-parameter. Batcht in groepen van MAX_IDS_PER_REQUEST.
 *
 * ONGETEST tegen een levende dienst -- zie module-commentaar hierboven.
 */
export async function resolveNwbGeometry(segmentIds: string[]): Promise<NwbGeometryResult> {
  const resolved = new Map<string, { x: number; y: number }[]>();
  const failed: string[] = [];

  for (let i = 0; i < segmentIds.length; i += MAX_IDS_PER_REQUEST) {
    const batch = segmentIds.slice(i, i + MAX_IDS_PER_REQUEST);
    const resourceIds = batch.map((id) => (id.includes(":") ? id : `${NWB_TYPE_NAME}.${id}`)).join(",");

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
        headers: { "User-Agent": "GoKnoop-geometry-resolver/1.0 (Fase M, ongetest tegen levende dienst)" },
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
        const normalizedId = id.includes(":") ? id : `${NWB_TYPE_NAME}.${id}`;
        if (!foundIds.has(normalizedId) && !foundIds.has(id)) failed.push(id);
      }
    } catch {
      clearTimeout(timeoutId);
      failed.push(...batch);
    }
  }

  return { resolved, failed };
}
