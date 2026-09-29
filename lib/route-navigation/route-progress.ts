import { wgs84ToRd, rdToWgs84 } from "@/lib/route-engine/coordinate-transform";
import { distanceBetween, projectOntoSegment } from "@/lib/navigation/matching/geometry";
import type { Point } from "@/lib/route-engine/types";
import type { LatLon, RouteProgress } from "./types";

/**
 * Eenvoudige, robuuste geometrische projectie op de routepolyline (19-9-2026, "Fase B",
 * sectie 3 van het opdrachtdocument: "niet opnieuw een tweede complex matching-systeem
 * bouwen als dat niet nodig is"). Werkt in RD (meter-eenheden, via de al bestaande
 * `wgs84ToRd`/`rdToWgs84`) zodat de al bestaande, geteste `projectOntoSegment`/
 * `distanceBetween` (matching/geometry.ts, oorspronkelijk voor de knooppunten-matcher)
 * ONGEWIJZIGD hergebruikt kunnen worden -- deze functies zijn zelf al volledig generiek
 * (puur `Point`-in/`Point`-out), ze kennen het knooppuntenmodel niet.
 *
 * Bewust GEEN venster rond een vorige match (zoals de knooppunten-candidate-matcher wel
 * heeft) -- een externe fietsroute heeft in de praktijk hooguit een paar honderd
 * geometriepunten, een volledige doorzoeking per sample is verwaarloosbaar en simpeler.
 */
export function computeRouteProgress(geometryWgs84: readonly LatLon[], gpsPoint: LatLon): RouteProgress | null {
  if (geometryWgs84.length < 2) return null;

  const geometryRd: Point[] = geometryWgs84.map((p) => wgs84ToRd(p.lat, p.lon));
  const gpsRd = wgs84ToRd(gpsPoint.lat, gpsPoint.lon);

  let bestSegmentIndex = 0;
  let bestT = 0;
  let bestPoint: Point = geometryRd[0];
  let bestDistance = Infinity;
  let cumulativeBeforeBest = 0;
  let cumulativeSoFar = 0;

  for (let i = 0; i < geometryRd.length - 1; i++) {
    const a = geometryRd[i];
    const b = geometryRd[i + 1];
    const { point, t } = projectOntoSegment(gpsRd, a, b);
    const d = distanceBetween(gpsRd, point);
    if (d < bestDistance) {
      bestDistance = d;
      bestSegmentIndex = i;
      bestT = t;
      bestPoint = point;
      cumulativeBeforeBest = cumulativeSoFar;
    }
    cumulativeSoFar += distanceBetween(a, b);
  }

  const segmentLength = distanceBetween(geometryRd[bestSegmentIndex], geometryRd[bestSegmentIndex + 1]);
  const distanceAlongRouteM = cumulativeBeforeBest + segmentLength * bestT;
  const totalDistanceM = cumulativeSoFar;
  const remainingDistanceM = Math.max(0, totalDistanceM - distanceAlongRouteM);
  const matchedWgs84 = rdToWgs84(bestPoint.x, bestPoint.y);

  return {
    matchedPoint: { lat: matchedWgs84.lat, lon: matchedWgs84.lon },
    segmentIndex: bestSegmentIndex,
    segmentT: bestT,
    perpendicularDistanceM: bestDistance,
    distanceAlongRouteM,
    remainingDistanceM,
    progressRatio: totalDistanceM > 0 ? Math.min(1, distanceAlongRouteM / totalDistanceM) : 0,
  };
}
