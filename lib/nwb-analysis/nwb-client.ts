/**
 * NWB-client -- TIJDELIJK, uitsluitend voor de ruimtelijke validatietest
 * (8-9-2026, "GoKnoop -- NWB ruimtelijke validatietest"). Geen onderdeel van
 * de productie-importpijplijn, geen wijziging aan de bestaande Routedatabank-
 * import. Haalt NWB-wegvakken op via de publieke, ongeauthenticeerde
 * PDOK-WFS-dienst (CC0, rechtstreeks bevestigd via de dienst zelf, 8-9-2026).
 *
 * Server-side attribuutfilter (CQL_FILTER op BST_CODE) i.p.v. alles ophalen
 * en achteraf filteren -- scheelt aanzienlijk in datavolume, en is preciezer
 * dan een naïeve "alles wat een weg is"-aanname (zie classify.ts voor de
 * volledige onderbouwing van welke BST_CODE-waarden zijn meegenomen).
 */

const NWB_WFS_BASE = "https://service.pdok.nl/rws/nwbwegen/wfs/v1_0";
const NWB_TYPE_NAME = "nwbwegen:wegvakken";

export type NwbSegment = {
  id: string;
  bstCode: string | null;
  wegnummer: string | null;
  straatnaam: string | null;
  wegbeheerder: string | null;
  /** RD-coördinaten (EPSG:28992), zelfde stelsel als de rest van GoKnoop. */
  coordinates: { x: number; y: number }[];
};

/**
 * Haalt NWB-wegvakken op binnen een RD-bounding box, met een BST_CODE-filter
 * (bv. "FP" of "FP,HR,RB"). GeoJSON-output (PDOK ondersteunt dit rechtstreeks)
 * -- veel eenvoudiger te verwerken dan GML.
 */
export async function fetchNwbSegments(
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  bstCodes: string[],
  maxFeatures = 5000
): Promise<{ segments: NwbSegment[]; numberMatched: number; truncated: boolean; debugCqlFilter: string; debugFirstFeatureKeys: string[] }> {
  const bstFilter = bstCodes.map((c) => `'${c}'`).join(",");
  // TOEGEVOEGD 8-9-2026: veldnamen gecorrigeerd naar camelCase, bevestigd via
  // een daadwerkelijk ontvangen feature (debugFirstFeatureKeys) -- de eerdere
  // hoofdletter-aanname (BST_CODE) bestond niet als veld, waardoor GeoServer
  // vermoedelijk stilzwijgend terugviel op een ongefilterde standaardset (dat
  // verklaarde de identieke resultaten over alle regio's heen). BBOX zonder
  // expliciete geometrie-veldnaam -- GeoServer's standaardvorm (herkent de
  // primaire geometriekolom automatisch), voorkomt nog een gok over die naam.
  const cqlFilter = `bstCode IN (${bstFilter}) AND BBOX(${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY})`;

  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: NWB_TYPE_NAME,
    outputFormat: "application/json",
    srsName: "EPSG:28992",
    count: String(maxFeatures),
    CQL_FILTER: cqlFilter,
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
  // TOEGEVOEGD 8-9-2026, diagnostisch: als GeoServer een foutmelding teruggeeft
  // (bv. onbekend veld in CQL_FILTER), is dat vaak GEEN geldige JSON met
  // `features` -- expliciet checken i.p.v. dit stilzwijgend als "0 features"
  // te laten doorglippen.
  let geojson: {
    features: {
      id: string;
      properties: Record<string, unknown>;
      geometry: { type: string; coordinates: number[][] | number[][][] };
    }[];
    numberMatched?: number;
    numberReturned?: number;
  };
  try {
    geojson = JSON.parse(rawText);
  } catch {
    throw new Error(`NWB-WFS gaf geen geldige JSON terug -- vermoedelijk een GeoServer-foutmelding op de CQL_FILTER. Eerste 500 tekens: ${rawText.slice(0, 500)}`);
  }
  if (!Array.isArray(geojson.features)) {
    throw new Error(`NWB-WFS-respons had geen 'features'-array -- vermoedelijk een foutmelding. Eerste 500 tekens: ${rawText.slice(0, 500)}`);
  }

  const segments: NwbSegment[] = [];
  for (const f of geojson.features) {
    // MultiLineString of LineString -- beide voorkomen in NWB, hier plat naar één puntenlijst
    // per segment (voor deze analyse is de exacte multi-part-structuur niet relevant).
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

  return {
    segments,
    numberMatched: geojson.numberMatched ?? segments.length,
    truncated: (geojson.numberMatched ?? segments.length) > segments.length,
    debugCqlFilter: cqlFilter,
    debugFirstFeatureKeys: geojson.features[0] ? Object.keys(geojson.features[0].properties) : [],
  };
}
