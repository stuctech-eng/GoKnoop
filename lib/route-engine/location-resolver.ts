import { GraphProvider } from "./types";
import { wgs84ToRd } from "./coordinate-transform";
import { geocodePlaceName } from "./geocode";

/**
 * Herbruikbare capability (GPT-review 26-8-2026): "vind dichtstbijzijnde
 * knooppunten bij een locatie" is bewust GEEN GoKnoop-UI-beslissing, maar een
 * losstaande Route Engine-dienst. Phase 3 kan dit later gewoon aanroepen
 * ("gebruik mijn locatie") zonder zelf geodata-logica te bevatten.
 *
 * Ondersteunt vandaag: coördinaten (RD of WGS84) en plaatsnaam.
 * Architectonisch voorbereid op: kaartselectie (levert ook gewoon een
 * coördinaat, dezelfde resolveNearestNodes-functie hergebruiken).
 */

export type LocationCandidate = {
  logicalNodeId: string;
  displayNumber?: string;
  displayRegio?: string;
  distanceM: number;
  edgeCount: number;
  x: number;
  y: number;
};

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/**
 * Kern: dichtstbijzijnde logicalNodes bij een RD-coördinaat.
 *
 * BUGFIX 28-8-2026: sloot voorheen niet uit dat een volledig geïsoleerde node
 * (0 matched edges -- zie Phase 1B sectie 7, 389 van zulke nodes landelijk)
 * als kandidaat werd teruggegeven. Zo'n node is nooit een bruikbaar start- of
 * eindpunt (elke route ernaartoe/vanaf mislukt gegarandeerd) -- concreet
 * waargenomen bij een Amsterdam-test: alle 24 loop-kandidaten faalden op de
 * heenweg, omdat het gekozen startpunt zelf 0 edges had. Geïsoleerde nodes
 * worden nu uitgesloten; de eerstvolgende, wél routeerbare node wordt gebruikt.
 */
export function resolveNearestNodes(
  provider: GraphProvider,
  point: { x: number; y: number },
  limit = 5
): LocationCandidate[] {
  const candidates: LocationCandidate[] = [];
  for (const id of provider.getAllNodeIds()) {
    const n = provider.getNode(id);
    if (!n) continue;
    const edgeCount = provider.getEdgesFrom(id).length;
    if (edgeCount === 0) continue; // geïsoleerde node -- nooit een bruikbaar startpunt
    candidates.push({
      logicalNodeId: id,
      displayNumber: n.displayNumber,
      displayRegio: n.displayRegio,
      distanceM: dist(point, n),
      edgeCount,
      x: n.x,
      y: n.y,
    });
  }
  candidates.sort((a, b) => a.distanceM - b.distanceM);
  return candidates.slice(0, limit);
}

/** GPS-coördinaten (WGS84, lat/lon) -> dichtstbijzijnde nodes. */
export function resolveFromWgs84(
  provider: GraphProvider,
  lat: number,
  lon: number,
  limit = 5
): LocationCandidate[] {
  const rd = wgs84ToRd(lat, lon);
  return resolveNearestNodes(provider, rd, limit);
}

/** Plaatsnaam -> geocoding -> dichtstbijzijnde nodes. */
export async function resolveFromPlaceName(
  provider: GraphProvider,
  placeName: string,
  limit = 5
): Promise<{ candidates: LocationCandidate[]; geocodedAs: string | null }> {
  const geo = await geocodePlaceName(placeName);
  if (!geo) return { candidates: [], geocodedAs: null };
  const rd = wgs84ToRd(geo.lat, geo.lon);
  return { candidates: resolveNearestNodes(provider, rd, limit), geocodedAs: geo.displayName };
}
