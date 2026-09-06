import { GraphEdge, Point } from "../../route-engine/types";
import { MatchedPosition } from "../types";
import { segmentLengths, cumulativeDistances } from "../matching/geometry";

/**
 * Progress calculation (ontwerp sectie 8) -- implementatiestap 5.
 *
 * Legt vast hoe een matched geometrie-segment (implementatiestap 4,
 * `MatchedPosition.segmentIndex`, een index binnen de samengevoegde
 * route-geometrie) wordt teruggeleid naar `Route.edges[]` (Phase 2-contract)
 * en van daaruit naar cumulatieve routeafstand.
 *
 * KERNPRINCIPE: `Route.edges[]` -- en specifiek elke edge z'n `distanceM`
 * (de lengte van de brongeometrie, NOOIT de Euclidische afstand, Phase
 * 2-ontwerp sectie 3) -- blijft leidend voor de uitgekomen afstand. De rauwe
 * geometrie (punt-voor-punt Euclidische afstand, zoals implementatiestap 4
 * die gebruikt om te matchen) bepaalt alleen de PROPORTIE waar iemand zich
 * binnen een edge bevindt -- niet de uiteindelijke afstand in meters. Bij
 * een bochtige edge zou de rauwe geometrieafstand een systematische
 * onderschatting geven; door te schalen naar `edge.distanceM` wordt dat
 * vermeden, exact dezelfde reden als in Phase 2 sectie 3/6.
 *
 * Bewust GEEN afwijkingsdetectie, GEEN rerouting hier -- alleen het bepalen
 * van "waar ben ik nu, hoe ver, hoeveel resterend" (latere stappen, sectie 23).
 */

export type RouteProgressModel = {
  edges: readonly GraphEdge[];
  /** Samengevoegde route-geometrie (voor gebruik door de matcher, stap 4). */
  geometry: readonly Point[];
  /** Voor elke edge: het halfopen bereik [start, eind) van globale segment-indices die bij die edge horen. */
  edgeSegmentRanges: readonly { startSegmentIndex: number; endSegmentIndexExclusive: number }[];
  /** Cumulatieve ECHTE afstand (edge.distanceM) tot en met elke edge. */
  edgeCumulativeEndM: readonly number[];
  /** Totale routeafstand = som van edge.distanceM (moet overeenkomen met Route.distanceM, Phase 2-invariant). */
  totalDistanceM: number;
  /** Rauwe (Euclidische) cumulatieve geometrieafstand aan het begin/eind van elke edge -- intern gebruikt voor proportionele interpolatie. */
  edgeRawCumulativeStartM: readonly number[];
  edgeRawCumulativeEndM: readonly number[];
};

/**
 * Bouwt het progress-model uit een geordende lijst edges (Phase 2
 * `GraphEdge[]`, zoals `Route.edges[]` na het opzoeken van de bijbehorende
 * edge-objecten). Vereist minstens 1 edge -- een route zonder edges is geen
 * geldige route (Phase 2-contract), geen stilzwijgend leeg model.
 *
 * Aanname, gegrond in Phase 2-ontwerp sectie 6 ("aaneengesloten
 * lijngeometrie, coords[] per edge, juiste richting samengevoegd"):
 * opeenvolgende edges delen hun grenspunt (edges[i].geometry laatste punt ==
 * edges[i+1].geometry eerste punt). Dat gedeelde punt wordt hier niet
 * gedupliceerd in de samengevoegde geometrie.
 */
export function buildRouteProgressModel(edges: readonly GraphEdge[]): RouteProgressModel {
  if (edges.length === 0) {
    throw new Error("buildRouteProgressModel: een route zonder edges is ongeldig (Phase 2-contract).");
  }

  const geometry: Point[] = [];
  const edgeSegmentRanges: { startSegmentIndex: number; endSegmentIndexExclusive: number }[] = [];

  for (let i = 0; i < edges.length; i++) {
    const edgeGeometry = edges[i].geometry;
    const pointsToAdd = i === 0 ? edgeGeometry : edgeGeometry.slice(1); // grenspunt niet dupliceren
    const segmentsInThisEdge = Math.max(0, edgeGeometry.length - 1);

    const startSegmentIndex = geometry.length === 0 ? 0 : geometry.length - 1;
    geometry.push(...pointsToAdd);
    edgeSegmentRanges.push({ startSegmentIndex, endSegmentIndexExclusive: startSegmentIndex + segmentsInThisEdge });
  }

  const lengths = segmentLengths(geometry);
  const rawCumulativeAtSegmentEnd = cumulativeDistances(lengths);

  const edgeCumulativeEndM: number[] = [];
  const edgeRawCumulativeStartM: number[] = [];
  const edgeRawCumulativeEndM: number[] = [];
  let runningRealDistanceM = 0;

  for (let i = 0; i < edges.length; i++) {
    runningRealDistanceM += edges[i].distanceM;
    edgeCumulativeEndM.push(runningRealDistanceM);

    const range = edgeSegmentRanges[i];
    const rawStart = range.startSegmentIndex === 0 ? 0 : rawCumulativeAtSegmentEnd[range.startSegmentIndex - 1];
    const rawEnd =
      range.endSegmentIndexExclusive === 0 ? 0 : rawCumulativeAtSegmentEnd[range.endSegmentIndexExclusive - 1];
    edgeRawCumulativeStartM.push(rawStart);
    edgeRawCumulativeEndM.push(rawEnd);
  }

  return {
    edges,
    geometry,
    edgeSegmentRanges,
    edgeCumulativeEndM,
    totalDistanceM: runningRealDistanceM,
    edgeRawCumulativeStartM,
    edgeRawCumulativeEndM,
  };
}

export type ProgressSnapshot = {
  /** Cumulatieve, ECHTE afstand afgelegd langs de route (edge.distanceM-gebaseerd), in meter. */
  distanceAlongRouteM: number;
  /** route.distanceM (totalDistanceM) - distanceAlongRouteM. */
  remainingDistanceM: number;
  /** distanceAlongRouteM / totalDistanceM, in [0,1]. */
  progressRatio: number;
  /** Index in model.edges -- de edge waarop de matched positie zich bevindt. */
  currentEdgeIndex: number;
  /** Het edge-ID van diezelfde edge, voor gebruik door latere stappen (bijv. reroute-context, sectie 10). */
  currentEdgeId: string;
};

function findEdgeIndexForSegment(model: RouteProgressModel, segmentIndex: number): number {
  for (let i = 0; i < model.edgeSegmentRanges.length; i++) {
    const range = model.edgeSegmentRanges[i];
    if (segmentIndex >= range.startSegmentIndex && segmentIndex < range.endSegmentIndexExclusive) {
      return i;
    }
  }
  // Randgeval: segmentIndex wijst naar het allerlaatste punt van de geometrie (geen segment
  // erna) -- reken dit toe aan de laatste edge (aankomst-randgeval, ontwerp sectie 6).
  const lastRange = model.edgeSegmentRanges[model.edgeSegmentRanges.length - 1];
  if (segmentIndex === lastRange.endSegmentIndexExclusive) {
    return model.edgeSegmentRanges.length - 1;
  }
  throw new Error(
    `calculateProgress: segmentIndex ${segmentIndex} valt buiten het bereik van dit route-progress-model.`
  );
}

/**
 * Berekent de routevoortgang voor een matched positie (implementatiestap 4).
 * Pure functie -- geen state, geen ruistolerantie (zie ProgressTracker voor
 * die laag, progress-tracker.ts).
 */
export function calculateProgress(model: RouteProgressModel, matchedPosition: MatchedPosition): ProgressSnapshot {
  const edgeIndex = findEdgeIndexForSegment(model, matchedPosition.segmentIndex);

  const rawStart = model.edgeRawCumulativeStartM[edgeIndex];
  const rawEnd = model.edgeRawCumulativeEndM[edgeIndex];
  const rawEdgeLength = rawEnd - rawStart;

  // Proportie binnen de edge, gebaseerd op de RAUWE (Euclidische) geometrieafstand --
  // alleen gebruikt om te bepalen HOEVER binnen de edge, nooit als einduitkomst in meters.
  const rawIntoEdge = matchedPosition.cumulativeDistanceM - rawStart;
  const proportion = rawEdgeLength === 0 ? 0 : Math.min(1, Math.max(0, rawIntoEdge / rawEdgeLength));

  const edge = model.edges[edgeIndex];
  const realDistanceIntoEdge = proportion * edge.distanceM; // ECHTE afstand, geschaald naar edge.distanceM

  const edgeStartRealM = edgeIndex === 0 ? 0 : model.edgeCumulativeEndM[edgeIndex - 1];
  const distanceAlongRouteM = edgeStartRealM + realDistanceIntoEdge;

  const remainingDistanceM = model.totalDistanceM - distanceAlongRouteM;
  const progressRatio = model.totalDistanceM === 0 ? 0 : distanceAlongRouteM / model.totalDistanceM;

  return {
    distanceAlongRouteM,
    remainingDistanceM,
    progressRatio,
    currentEdgeIndex: edgeIndex,
    currentEdgeId: edge.id,
  };
}
