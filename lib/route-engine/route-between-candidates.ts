import { GraphProvider, RouteConstraints } from "./types";
import { computeRouteWithFallback, RouteToPointWithFallbackResult } from "./route-to-point-fallback";
import type { LoopStartCandidate } from "./loop-route-generator";

/**
 * Punt-naar-punt-routing MET kandidaat-fallback aan BEIDE kanten (sectie 9.21,
 * "route naar een adres", 30-8-2026) -- uitbreiding van `computeRouteWithFallback`
 * (die alleen de HERKOMST-kant al zo probeerde, bijv. Back to Start's eerste been).
 *
 * Nu ook de BESTEMMING kan een onbruikbare dichtstbijzijnde kandidaat hebben (zelfde
 * Volendam-patroon, sectie 6B, maar dan aan de andere kant van de route) -- dit
 * probeert bestemmingskandidaten op volgorde, en gebruikt voor ELKE bestemmings-
 * kandidaat de volledige, al bestaande herkomst-fallback.
 *
 * Bewust hergebruik: dit bestand herimplementeert `computeRouteWithFallback` niet,
 * roept 'm gewoon opnieuw aan per bestemmingskandidaat.
 */

export type RouteBetweenCandidatesResult = RouteToPointWithFallbackResult & {
  selectedDestinationNodeId: string;
  selectedDestinationNodeDisplayNumber: string;
  selectedDestinationCandidateRank: number;
};

export type RouteBetweenCandidatesFailure = {
  ok: false;
  reason: "no_usable_candidate";
  message: string;
  destinationCandidatesAttempted: number;
};

export function computeRouteBetweenCandidatesWithFallback(
  provider: GraphProvider,
  datasetVersionId: string,
  fromCandidates: readonly LoopStartCandidate[],
  toCandidates: readonly LoopStartCandidate[],
  constraints: RouteConstraints = {}
): RouteBetweenCandidatesResult | RouteBetweenCandidatesFailure {
  for (let i = 0; i < toCandidates.length; i++) {
    const toCandidate = toCandidates[i];
    if (!provider.getNode(toCandidate.logicalNodeId)) continue; // onbekend knooppunt -- volgende bestemmingskandidaat

    const result = computeRouteWithFallback(provider, datasetVersionId, fromCandidates, toCandidate.logicalNodeId, constraints);
    if ("ok" in result) continue; // deze bestemmingskandidaat leverde niets op -- volgende proberen

    const success = result as RouteToPointWithFallbackResult;
    return {
      ...success,
      selectedDestinationNodeId: toCandidate.logicalNodeId,
      selectedDestinationNodeDisplayNumber: provider.getNode(toCandidate.logicalNodeId)?.displayNumber ?? toCandidate.logicalNodeId,
      selectedDestinationCandidateRank: i + 1,
    };
  }

  return {
    ok: false,
    reason: "no_usable_candidate",
    message: `Geen van de ${toCandidates.length} bestemmingskandidaten leverde een bruikbare route op.`,
    destinationCandidatesAttempted: toCandidates.length,
  };
}
