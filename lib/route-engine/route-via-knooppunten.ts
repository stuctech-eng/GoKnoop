import type { GraphProvider } from "./types";
import { computeRoute } from "./route-engine";
import { rdToWgs84 } from "./coordinate-transform";
import { LocalBikeRouter } from "@/lib/local-bike-router/local-bike-router";
import { OpenRouteServiceAdapter } from "@/lib/local-bike-router/open-route-service-adapter";
import { getCachedKnotSegment, setCachedKnotSegment } from "./knot-segment-cache";
import type { LatLon, LocalBikeRouteStep } from "@/lib/local-bike-router/types";

/**
 * "Functie 2" (19-9-2026, GO van Te, overlegd): de kortste weg via knooppunten
 * vinden, maar het daadwerkelijke rijpad tussen elk paar opeenvolgende knooppunten
 * met de bewezen-werkende echte-fietspad-motor (functie 1, ORS) berekenen --
 * i.p.v. het oude NWB/connector-systeem. Gebruikt UITSLUITEND `computeRoute()`
 * (de pure, nooit-door-de-NWB-bugs-geraakte knooppunten-Dijkstra, zie
 * lib/route-engine/route-engine.ts/dijkstra.ts) voor de knooppuntvolgorde zelf --
 * geen NWB, geen connectors, geen bridges.
 *
 * ONTWERPBESLISSINGEN, zoals overlegd (niet aangenomen, expliciet besproken):
 * - sequentiële ORS-aanroepen met een vaste pauze ertussen (zelfde 1,6s die eerder
 *   al empirisch veilig bleek tegen ORS' per-minuut-limiet, zie generate-bridges/route.ts) --
 *   bewust GEEN parallellisatie, dat zou de per-minuut-limiet juist sneller raken;
 * - een harde bovengrens op het aantal knooppunten, boven welke een duidelijke fout
 *   teruggegeven wordt i.p.v. een trage of afgekapte berekening;
 * - een PERMANENTE cache (Firestore, `knot-segment-cache.ts`) per knooppuntpaar --
 *   een pauze is alleen nodig vóór een ECHTE ORS-aanroep, nooit bij een cache-hit.
 */

/** Boven dit aantal knooppunten in de kortste route: expliciete afwijzing, geen poging. */
export const MAX_KNOOPPUNTEN_PER_ROUTE = 20;
/** Zelfde, empirisch bevestigd veilige pauze als het eerdere bridge-generatie-werk. */
const ORS_CALL_DELAY_MS = 1600;

export type KnotSegmentSource = "cache" | "ors";

export type ViaKnooppuntenResult = {
  nodeIds: string[];
  displayNumbers: string[];
  geometry: LatLon[];
  distanceM: number;
  durationS: number;
  steps: LocalBikeRouteStep[];
  /** Per tussenstap: kwam dit uit de permanente cache, of is het net bij ORS opgehaald? Puur ter observatie/diagnose. */
  segmentSources: KnotSegmentSource[];
};

export type ViaKnooppuntenError =
  | { reason: "dijkstra_failed"; message: string }
  | { reason: "too_many_knooppunten"; knooppuntenCount: number; limit: number }
  | { reason: "segment_failed"; fromNodeId: string; toNodeId: string; message: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function routeViaKnooppunten(
  provider: GraphProvider,
  datasetVersionId: string,
  fromNodeId: string,
  toNodeId: string
): Promise<ViaKnooppuntenResult | ViaKnooppuntenError> {
  // Stap 1: kortste knooppuntvolgorde -- de pure, NWB-vrije Dijkstra (al bestaand, ongewijzigd).
  const dijkstraResult = computeRoute(provider, datasetVersionId, fromNodeId, toNodeId);
  if ("reason" in dijkstraResult) {
    return { reason: "dijkstra_failed", message: dijkstraResult.message };
  }
  const nodeIds = dijkstraResult.nodes;

  if (nodeIds.length > MAX_KNOOPPUNTEN_PER_ROUTE) {
    return { reason: "too_many_knooppunten", knooppuntenCount: nodeIds.length, limit: MAX_KNOOPPUNTEN_PER_ROUTE };
  }

  const displayNumbers = nodeIds.map((id) => provider.getNode(id)?.displayNumber ?? "?");

  // Stap 2: per opeenvolgend paar het echte fietspad ophalen -- cache eerst, anders ORS (functie 1).
  const router = new LocalBikeRouter(new OpenRouteServiceAdapter());

  let combinedGeometry: LatLon[] = [];
  let combinedDistanceM = 0;
  let combinedDurationS = 0;
  const combinedSteps: LocalBikeRouteStep[] = [];
  const segmentSources: KnotSegmentSource[] = [];

  for (let i = 0; i < nodeIds.length - 1; i++) {
    const fromId = nodeIds[i];
    const toId = nodeIds[i + 1];

    const cached = await getCachedKnotSegment(fromId, toId);
    let segment;
    if (cached) {
      segment = cached;
      segmentSources.push("cache");
    } else {
      const fromNode = provider.getNode(fromId);
      const toNode = provider.getNode(toId);
      if (!fromNode || !toNode) {
        return { reason: "segment_failed", fromNodeId: fromId, toNodeId: toId, message: "Knooppunt niet gevonden in de graaf." };
      }
      const fromWgs84 = rdToWgs84(fromNode.x, fromNode.y);
      const toWgs84 = rdToWgs84(toNode.x, toNode.y);

      const result = await router.route(
        { lat: fromWgs84.lat, lon: fromWgs84.lon },
        { lat: toWgs84.lat, lon: toWgs84.lon },
        "cycling",
        { includeSteps: true }
      );
      if ("reason" in result) {
        return { reason: "segment_failed", fromNodeId: fromId, toNodeId: toId, message: result.message };
      }
      segment = result;
      segmentSources.push("ors");
      await setCachedKnotSegment(fromId, toId, result);

      // Pauze UITSLUITEND ná een echte ORS-aanroep, en niet ná de allerlaatste --
      // een cache-hit heeft geen enkele reden om te wachten.
      if (i < nodeIds.length - 2) {
        await sleep(ORS_CALL_DELAY_MS);
      }
    }

    // Stap 3: samenvoegen -- gedeelde naad (eindpunt van stuk A = beginpunt van stuk B) niet dupliceren.
    combinedGeometry = combinedGeometry.length === 0 ? segment.geometry : [...combinedGeometry, ...segment.geometry.slice(1)];
    combinedDistanceM += segment.distanceM;
    combinedDurationS += segment.durationS;
    if (segment.steps) combinedSteps.push(...segment.steps);
  }

  return {
    nodeIds,
    displayNumbers,
    geometry: combinedGeometry,
    distanceM: combinedDistanceM,
    durationS: combinedDurationS,
    steps: combinedSteps,
    segmentSources,
  };
}
