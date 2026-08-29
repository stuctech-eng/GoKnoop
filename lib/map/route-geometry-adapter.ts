import { rdToWgs84 } from "../route-engine/coordinate-transform";
import type { RouteProgressModel } from "../navigation/progress/route-progress-model";
import { getNodeSegmentIndex } from "../navigation/progress/route-progress-model";

/**
 * Route → kaartgeometrie-adapter (GOKNOOP-MASTER.md sectie 7, stap 12.3B).
 *
 * Dunne, EENRICHTINGS-adapter: `lib/route-engine/` en `lib/navigation/`
 * blijven volledig onwetend van GeoJSON of MapLibre (de architectuurregel
 * uit sectie 5.0 -- de navigatie-engine mag nooit van MapLibre weten). Dit
 * bestand mag WEL van route-engine/navigation-types weten (eenrichtings-
 * afhankelijkheid naar beneden), en produceert platte, MapLibre-neutrale
 * GeoJSON-achtige objecten.
 *
 * Hergebruikt bewust `RouteProgressModel` (stap 5, `buildRouteProgressModel`)
 * voor de samengevoegde geometrie en edge-grenzen -- GEEN nieuw, parallel
 * route-datamodel (ontwerpregel, sectie 4). Dat model concateneert edges al
 * exact in `Route.edges[]`-volgorde, zonder enige node-gebaseerde
 * deduplicatie -- parallelle edges tussen dezelfde nodes worden dus
 * automatisch correct, apart weergegeven (geen extra logica hier nodig).
 *
 * Lokaal getypeerd (geen `@types/geojson`-afhankelijkheid) -- platte
 * objecten die MapLibre's `GeoJSONSourceSpecification` rechtstreeks accepteert.
 */

export type GeoJsonPosition = [number, number]; // [lon, lat], WGS84

export type RouteLineFeature = {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: GeoJsonPosition[] };
  properties: Record<string, never>;
};

export type RouteNodeFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: GeoJsonPosition };
  properties: { nodeId: string; sequenceIndex: number };
};

export type RouteNodeFeatureCollection = {
  type: "FeatureCollection";
  features: RouteNodeFeature[];
};

/** [[minLon,minLat],[maxLon,maxLat]] -- direct bruikbaar voor MapLibre's fitBounds(). */
export type RouteBounds = [GeoJsonPosition, GeoJsonPosition];

export type RouteGeoJsonResult = {
  line: RouteLineFeature;
  nodes: RouteNodeFeatureCollection;
  bounds: RouteBounds;
};

/**
 * Bouwt de kaartweergave-data voor een route. `nodeIds` moet `Route.nodes[]`
 * zijn (lengte = edges.length + 1, ECHTE knooppuntnummers, geen verzonnen
 * waarden) -- volgorde blijft die van de route-engine, niet geografisch
 * hersorteerd (ontwerpregel sectie 6).
 *
 * Gooit expliciet bij ongeldige/lege geometrie -- geen stille lege kaart.
 */
export function buildRouteGeoJson(model: RouteProgressModel, nodeIds: readonly string[]): RouteGeoJsonResult {
  if (model.geometry.length < 2) {
    throw new Error("buildRouteGeoJson: route-geometrie heeft minder dan 2 punten, kan niet gevisualiseerd worden.");
  }
  if (nodeIds.length !== model.edges.length + 1) {
    throw new Error(
      `buildRouteGeoJson: nodeIds.length (${nodeIds.length}) moet gelijk zijn aan edges.length + 1 (${model.edges.length + 1}).`
    );
  }

  const lineCoords: GeoJsonPosition[] = model.geometry.map((p) => {
    const wgs84 = rdToWgs84(p.x, p.y);
    return [wgs84.lon, wgs84.lat];
  });

  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of lineCoords) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  const nodeFeatures: RouteNodeFeature[] = nodeIds.map((nodeId, i) => {
    const segmentIndex = getNodeSegmentIndex(model, i);
    const point = model.geometry[segmentIndex];
    const wgs84 = rdToWgs84(point.x, point.y);
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [wgs84.lon, wgs84.lat] },
      properties: { nodeId, sequenceIndex: i },
    };
  });

  return {
    line: { type: "Feature", geometry: { type: "LineString", coordinates: lineCoords }, properties: {} },
    nodes: { type: "FeatureCollection", features: nodeFeatures },
    bounds: [
      [minLon, minLat],
      [maxLon, maxLat],
    ],
  };
}
