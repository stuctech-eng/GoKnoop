import { GraphProvider, RouteConstraints, Route } from "./types";
import { computeRoute } from "./route-engine";
import { resolveRouteEdges } from "./resolve-route-edges";
import type { LoopStartCandidate } from "./loop-route-generator";
import type { GraphEdge } from "./types";

/**
 * Punt-naar-punt-routing MET dezelfde kandidaat-fallback als
 * `generateLoopRoutesWithFallback` (Volendam-onderzoek, sectie 6B) --
 * gebouwd voor "navigeer naar het startpunt" (sectie 6M/6N): de live
 * GPS-positie wordt eerst naar kandidaat-knooppunten geresolved
 * (`/api/location/resolve`, bestaand), en dit probeert ze in volgorde totdat
 * er een bruikbare route naar het doelknooppunt gevonden is -- hetzelfde
 * probleem (dichtstbijzijnde knooppunt kan een slechte/geen route hebben)
 * kan hier net zo goed optreden als bij de rondje-generator.
 *
 * Bewust hergebruik van hetzelfde patroon, geen nieuwe/afwijkende aanpak.
 */
export type RouteToPointWithFallbackResult = {
  route: Route;
  resolvedEdges: GraphEdge[];
  nodeDisplayNumbers: string[];
  selectedStartNodeId: string;
  selectedStartNodeDisplayNumber: string;
  selectedCandidateRank: number;
};

export type RouteToPointFallbackFailure = {
  ok: false;
  reason: "no_usable_candidate";
  message: string;
  candidatesAttempted: number;
};

export function computeRouteWithFallback(
  provider: GraphProvider,
  datasetVersionId: string,
  fromCandidates: readonly LoopStartCandidate[],
  toLogicalNodeId: string,
  constraints: RouteConstraints = {}
): RouteToPointWithFallbackResult | RouteToPointFallbackFailure {
  // BUGFIX (30-8-2026, vervolg op sectie 9.50 -- de bestemmingskant-fix loste het gemelde
  // probleem NIET volledig op): als de EERST geprobeerde herkomstkandidaat (dichtstbijzijnde
  // knooppunt) toevallig slecht verbonden is (bijv. aan de verkeerde kant van een gracht/dijk
  // zonder directe oversteek), forceert dat een omweg ONGEACHT welke bestemmingskandidaat
  // gekozen wordt -- sectie 9.50's fix (vergelijken tussen bestemmingen) helpt dan niet, want
  // ALLE bestemmingen zouden via diezelfde slechte herkomst-keuze moeten. Nu ook hier: alle
  // kandidaten proberen, de kortste kiezen i.p.v. de eerst-werkende.
  //
  // Bewust risicoarm voor de bestaande gebruikers van deze functie (Fase 4 "navigeer naar
  // startpunt", Back to Start): "kortste van alle geprobeerde kandidaten" kan nooit slechter
  // zijn dan "eerste die toevallig werkt" -- in het slechtste geval identiek, typisch beter.
  let best: RouteToPointWithFallbackResult | null = null;

  for (let i = 0; i < fromCandidates.length; i++) {
    const candidate = fromCandidates[i];
    if (!provider.getNode(candidate.logicalNodeId)) continue; // onbekend knooppunt -- volgende proberen

    const result = computeRoute(provider, datasetVersionId, candidate.logicalNodeId, toLogicalNodeId, constraints);
    if ("reason" in result) continue; // deze kandidaat leverde geen route op -- volgende proberen

    const candidateResult: RouteToPointWithFallbackResult = {
      route: result,
      resolvedEdges: resolveRouteEdges(provider, result),
      nodeDisplayNumbers: result.nodes.map((nodeId) => provider.getNode(nodeId)?.displayNumber ?? nodeId),
      selectedStartNodeId: candidate.logicalNodeId,
      selectedStartNodeDisplayNumber: provider.getNode(candidate.logicalNodeId)?.displayNumber ?? candidate.logicalNodeId,
      selectedCandidateRank: i + 1,
    };

    if (!best || candidateResult.route.distanceM < best.route.distanceM) {
      best = candidateResult;
    }
  }

  if (best) return best;

  return {
    ok: false,
    reason: "no_usable_candidate",
    message: `Geen van de ${fromCandidates.length} kandidaat-knooppunten leverde een route naar het startpunt op.`,
    candidatesAttempted: fromCandidates.length,
  };
}
