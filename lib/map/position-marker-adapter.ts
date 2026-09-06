import { rdToWgs84 } from "../route-engine/coordinate-transform";
import type { MatchedPosition } from "../navigation/types";
import type { GeoJsonPosition } from "./route-geometry-adapter";

/**
 * Live-positie-adapter (GOKNOOP-MASTER.md sectie 7, stap 12.4).
 *
 * KERNREGEL, letterlijk uit de opdracht: de keten is
 *
 *   GPS → matching → navigation state → kaartmarker
 *
 * NOOIT
 *
 *   GPS → kaartmarker
 *
 * Deze adapter accepteert daarom uitsluitend een `MatchedPosition` (het
 * resultaat van de candidate matcher, stap 4 -- zelf al het resultaat van
 * een GEACCEPTEERDE `reportOnRoute()`/`reportDeviation()`-aanroep op de
 * `NavigationStateMachine`, stap 2/6/9). Er is hier geen enkel pad dat een
 * ruwe `GpsSample`/lat-lon rechtstreeks omzet naar een kaartpositie -- de
 * aanroeper (de UI-laag) mag deze functie alleen voeden met wat
 * `NavigationSessionController`/`DeviationDetector` daadwerkelijk als
 * geldige positie heeft geaccepteerd, nooit met een ruwe sample.
 *
 * Zelfde eenrichtings-architectuurregel als `route-geometry-adapter.ts`:
 * `lib/navigation/` blijft onwetend van GeoJSON/MapLibre.
 */

export type PositionMarkerFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: GeoJsonPosition };
  properties: {
    perpendicularDistanceM: number;
    segmentIndex: number;
  };
};

/**
 * Bouwt de kaartmarker-data voor de huidige, door de navigatie-engine
 * geaccepteerde positie. Puur, geen state, geen bijwerkingen.
 */
export function buildPositionMarkerGeoJson(matchedPosition: MatchedPosition): PositionMarkerFeature {
  const wgs84 = rdToWgs84(matchedPosition.point.x, matchedPosition.point.y);
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [wgs84.lon, wgs84.lat] },
    properties: {
      perpendicularDistanceM: matchedPosition.perpendicularDistanceM,
      segmentIndex: matchedPosition.segmentIndex,
    },
  };
}
