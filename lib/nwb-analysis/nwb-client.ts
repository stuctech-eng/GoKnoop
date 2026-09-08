/**
 * NWB-client -- TIJDELIJK, uitsluitend voor de ruimtelijke validatietest
 * (8-9-2026, "GoKnoop -- NWB ruimtelijke validatietest"). Geen onderdeel van
 * de productie-importpijplijn, geen wijziging aan de bestaande Routedatabank-
 * import. Haalt NWB-wegvakken op via de publieke, ongeauthenticeerde
 * PDOK-WFS-dienst (CC0, rechtstreeks bevestigd via de dienst zelf, 8-9-2026).
 *
 * HERZIEN 8-9-2026: eerdere versie gebruikte CQL_FILTER (BST_CODE + BBOX in
 * één server-side filter) -- dat bleek stilzwijgend genegeerd te worden
 * (identieke resultaten voor 3 totaal verschillende regio's, ondanks een
 * correcte veldnaam-fix). CQL_FILTER is een GeoServer-VENDOR-extensie, geen
 * officiële WFS-standaard -- deze dienst ondersteunt 'm vermoedelijk niet,
 * en negeert een onherkende parameter blijkbaar stil i.p.v. een fout te
 * geven. Nu uitsluitend de standaard, universeel ondersteunde `bbox`-
 * queryparameter (WFS 2.0-spec) voor ruimtelijke filtering; BST_CODE-
 * classificatie gebeurt hierna client-side (classify.ts) op de ruwe,
 * ongefilterde resultaten -- geen afhankelijkheid meer van een onzekere
 * server-side filtersyntax.
 */

const NWB_WFS_BASE = "https://service.pdok.nl/rws/nwbwegen/wfs/v1_0";
const NWB_TYPE_NAME = "nwbwegen:wegvakken";
const PAGE_SIZE = 1000; // bevestigd server-side maximum (CountDefault in Capabilities)

export type NwbSegment = {
  id: string;
  bstCode: string | null;
  wegnummer: string | null;
  straatnaam: string | null;
  wegbeheerder: string | null;
  /** RD-coördinaten (EPSG:28992), zelfde stelsel als de rest van GoKnoop. */
  coordinates: { x: number; y: number }[];
};

async function fetchPage(
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  startIndex: number
): Promise<{ segments: NwbSegment[]; returned: number; rawFirstFeatureKeys: string[] }> {
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: NWB_TYPE_NAME,
    outputFormat: "application/json",
    srsName: "EPSG:28992",
    bbox: `${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}`,
    count: String(PAGE_SIZE),
    startIndex: String(startIndex),
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  let res: Response;
  try {
    res = await fetch(`${NWB_WFS_BASE}?${params.toString()}`, {
      headers: { "User-Agent": "GoKnoop-NWB-validatietest/1.0 (tijdelijk, onderzoek, geen productiegebruik)" },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    throw new Error(isTimeout ? "NWB-WFS-aanvraag duurde langer dan 8s." : `NWB-WFS-aanvraag mislukt: ${err instanceof Error ? err.message : String(err)}`);
  }
  clearTimeout(timeoutId);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NWB-WFS gaf status ${res.status}: ${body.slice(0, 300)}`);
  }

  const rawText = await res.text();
  let geojson: {
    features: {
      id: string;
      properties: Record<string, unknown>;
      geometry: { type: string; coordinates: number[][] | number[][][] };
    }[];
  };
  try {
    geojson = JSON.parse(rawText);
  } catch {
    throw new Error(`NWB-WFS gaf geen geldige JSON terug. Eerste 500 tekens: ${rawText.slice(0, 500)}`);
  }
  if (!Array.isArray(geojson.features)) {
    throw new Error(`NWB-WFS-respons had geen 'features'-array. Eerste 500 tekens: ${rawText.slice(0, 500)}`);
  }

  const segments: NwbSegment[] = [];
  for (const f of geojson.features) {
    let coords: number[][];
    if (f.geometry.type === "LineString") {
      coords = f.geometry.coordinates as number[][];
    } else if (f.geometry.type === "MultiLineString") {
      coords = (f.geometry.coordinates as number[][][]).flat();
    } else {
      continue;
    }
    segments.push({
      id: f.id,
      bstCode: (f.properties.bstCode as string) ?? null,
      wegnummer: (f.properties.wegnummer as string) ?? null,
      straatnaam: (f.properties.sttNaam as string) ?? null,
      wegbeheerder: (f.properties.wegbehnaam as string) ?? null,
      coordinates: coords.map(([x, y]) => ({ x, y })),
    });
  }

  return { segments, returned: geojson.features.length, rawFirstFeatureKeys: geojson.features[0] ? Object.keys(geojson.features[0].properties) : [] };
}

/**
 * Haalt ALLE NWB-wegvakken op binnen een RD-bounding box (ongefilterd op
 * BST_CODE -- die classificatie gebeurt door de aanroeper, zie classify.ts),
 * gepagineerd tot `maxPages` pagina's van 1000. Rapporteert expliciet of er
 * meer beschikbaar was dan opgehaald (afgekapt door maxPages, niet stil
 * genegeerd).
 */
export async function fetchAllNwbSegmentsInBbox(
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  maxPages = 3
): Promise<{ segments: NwbSegment[]; pagesRetrieved: number; truncated: boolean; debugFirstFeatureKeys: string[] }> {
  const allSegments: NwbSegment[] = [];
  let debugFirstFeatureKeys: string[] = [];
  let page = 0;
  for (; page < maxPages; page++) {
    const { segments, returned, rawFirstFeatureKeys } = await fetchPage(bbox, page * PAGE_SIZE);
    if (page === 0) debugFirstFeatureKeys = rawFirstFeatureKeys;
    allSegments.push(...segments);
    if (returned < PAGE_SIZE) {
      page++;
      break;
    }
  }
  return {
    segments: allSegments,
    pagesRetrieved: page,
    truncated: page === maxPages,
    debugFirstFeatureKeys,
  };
}
