import { GraphEdge, Point } from "../../route-engine/types";
import { MatchedPosition } from "../types";
import { segmentLengths, cumulativeDistances, bearingDegrees } from "../matching/geometry";

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
 * edge-objecten) EN de bijbehorende knooppuntvolgorde (`Route.nodes[]`,
 * lengte = edges.length + 1). Vereist minstens 1 edge -- een route zonder
 * edges is geen geldige route (Phase 2-contract), geen stilzwijgend leeg
 * model.
 *
 * BUGFIX (Naarden-onderzoek 29-8-2026): een edge is BIDIRECTIONEEL
 * doorloopbaar (`isTraversable()`, Phase 2), maar de brongeometrie ligt
 * vast in ÉÉN richting (`edge.fromLogicalNodeId` -> `edge.toLogicalNodeId`).
 * Als de route een edge in de OMGEKEERDE richting doorloopt, moet de
 * geometrie omgekeerd worden -- anders "springt" de samengevoegde lijn naar
 * het verkeerde uiteinde van die edge, zichtbaar als een kaarsrechte lijn
 * die geen enkel pad volgt. Dit was eerder gemist (naïeve concatenatie
 * zonder richtingscontrole); nu gefixt met EXACT dezelfde, al bewezen
 * logica als `route-builder.ts`'s `concatenateGeometry()` (Phase 2) -- geen
 * nieuwe, afwijkende implementatie, hergebruik van het bestaande, correcte
 * patroon.
 */
export function buildRouteProgressModel(edges: readonly GraphEdge[], nodeSequence: readonly string[]): RouteProgressModel {
  if (edges.length === 0) {
    throw new Error("buildRouteProgressModel: een route zonder edges is ongeldig (Phase 2-contract).");
  }
  if (nodeSequence.length !== edges.length + 1) {
    throw new Error(
      `buildRouteProgressModel: nodeSequence.length (${nodeSequence.length}) moet gelijk zijn aan edges.length + 1 (${edges.length + 1}).`
    );
  }

  const geometry: Point[] = [];
  const edgeSegmentRanges: { startSegmentIndex: number; endSegmentIndexExclusive: number }[] = [];

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const fromNodeAtThisStep = nodeSequence[i];
    // Zelfde richtingscorrectie als route-builder.ts: de brongeometrie staat vast in de
    // richting from -> to; bij omgekeerd doorlopen (bidirectioneel, isTraversable) moet de
    // coördinatenreeks omgekeerd worden zodat 'ie de daadwerkelijke reisrichting volgt.
    const forward = edge.fromLogicalNodeId === fromNodeAtThisStep;
    const edgeGeometry = forward ? edge.geometry : [...edge.geometry].reverse();

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

/**
 * Segment-index in `model.geometry` waar knooppunt `nodeIndex` (0-based,
 * 0..edges.length, dus dezelfde indexering als `Route.nodes[]`) zich
 * bevindt. Gedeelde helper -- hergebruikt door zowel deze module
 * (`calculateNextNodeInfo`, stap 12.5) als `lib/map/route-geometry-
 * adapter.ts` (stap 12.3B), zodat er niet twee plekken zijn die apart
 * "welk punt hoort bij welk knooppunt" berekenen (TypeScript-regel: geen
 * dubbele utilities).
 */
export function getNodeSegmentIndex(model: RouteProgressModel, nodeIndex: number): number {
  if (nodeIndex === 0) return 0;
  if (nodeIndex === model.edges.length) return model.geometry.length - 1;
  return model.edgeSegmentRanges[nodeIndex].startSegmentIndex;
}

export type NextNodeInfo = {
  currentNodeId: string;
  nextNodeId: string;
  /** ECHTE afstand (edge.distanceM-gebaseerd) tot het volgende knooppunt, nooit negatief. */
  distanceToNextNodeM: number;
  /** 0-360°, 0 = noord -- absolute richting van de huidige positie naar het volgende
   *  knooppunt. GEEN correctie voor bewegingsrichting/heading (dat is stap 12.7,
   *  Start Guidance -> normale navigatie-overgang) -- hier bewust nog niet vooruitgelopen. */
  bearingToNextNodeDeg: number;
};

/**
 * Huidig/volgend knooppunt + afstand + richting (ontwerp sectie 6/7,
 * geïmplementeerd bij implementatiestap 12.5 -- dit gat stond sinds stap 5
 * open, hier ingevuld als kleine, geïsoleerde uitbreiding van de bestaande
 * progress-laag, geen nieuwe navigatielogica).
 *
 * Gebruikt uitsluitend al-bestaande brongegevens: `progress.currentEdgeIndex`
 * (stap 5), `model.edgeCumulativeEndM` (ECHTE afstanden, stap 5),
 * `matchedPosition.point` + `bearingDegrees` (stap 4). Geen nieuwe afstands-
 * of positieberekening.
 */
export function calculateNextNodeInfo(
  model: RouteProgressModel,
  progress: ProgressSnapshot,
  matchedPosition: MatchedPosition,
  nodeIds: readonly string[]
): NextNodeInfo {
  if (nodeIds.length !== model.edges.length + 1) {
    throw new Error(
      `calculateNextNodeInfo: nodeIds.length (${nodeIds.length}) moet gelijk zijn aan edges.length + 1 (${model.edges.length + 1}).`
    );
  }

  const currentNodeId = nodeIds[progress.currentEdgeIndex];
  const nextNodeId = nodeIds[progress.currentEdgeIndex + 1];

  const edgeEndRealM = model.edgeCumulativeEndM[progress.currentEdgeIndex];
  const distanceToNextNodeM = Math.max(0, edgeEndRealM - progress.distanceAlongRouteM);

  const nextNodeSegmentIndex = getNodeSegmentIndex(model, progress.currentEdgeIndex + 1);
  const nextNodePoint = model.geometry[nextNodeSegmentIndex];
  const bearingToNextNodeDeg = bearingDegrees(matchedPosition.point, nextNodePoint);

  return { currentNodeId, nextNodeId, distanceToNextNodeM, bearingToNextNodeDeg };
}
