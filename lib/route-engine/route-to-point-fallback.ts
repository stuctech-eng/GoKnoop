import { GraphProvider, RouteConstraints, Route } from "./types";
import { computeCombinedRoute, computeCombinedRouteAsRoute } from "./combined-route-engine";
import type { CombinedGraph } from "../nwb-analysis/combined-graph";
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
 *
 * HERZIEN, Fase M5, 10-9-2026: gebruikt nu de gecombineerde engine
 * (GoKnoop + NWB + connectors + kostenmodel + validatie) i.p.v. de kale,
 * plain-GoKnoop `computeRoute()`. Dit is het ENIGE, bewust gekozen
 * integratiepunt (Fase M3) -- de kandidaat-fallback-structuur eromheen
 * blijft ONGEWIJZIGD, die lost een ander probleem op (zie Fase M2).
 *
 * HERZIEN, Fase M5 (performance-fix), 10-9-2026: EERSTE versie bouwde
 * volledige geometrie (met een LIVE PDOK-aanroep) voor ELKE kandidaat in de
 * loop, ook de uiteindelijk weggegooide -- live gemeten: 10.656ms, tegen de
 * Vercel Hobby-10s-limiet aan (bevestigde timeout, "The string did not
 * match the expected pattern" -- Vercel's platform sneed de functie af en
 * gaf een niet-JSON foutpagina terug). NU TWEE FASEN: eerst een GOEDKOPE
 * vergelijking (`computeCombinedRoute`, geen geometrie, geen PDOK-aanroep)
 * voor ALLE kandidaten, dan de dure geometrie-opbouw PRECIES ÉÉN KEER, voor
 * de uiteindelijke winnaar. Bespaart een volledige PDOK-aanroep per
 * weggegooide kandidaat.
 *
 * `graph` is een EXPLICIETE parameter (niet zelf geladen): de aanroeper
 * (API-route) laadt 'm één keer via `loadCachedCombinedGraph` en geeft 'm
 * door.
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

export async function computeRouteWithFallback(
  provider: GraphProvider,
  datasetVersionId: string,
  graph: CombinedGraph,
  fromCandidates: readonly LoopStartCandidate[],
  toLogicalNodeId: string,
  constraints: RouteConstraints = {}
): Promise<RouteToPointWithFallbackResult | RouteToPointFallbackFailure> {
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

  // FASE 1 (goedkoop): elke kandidaat vergelijken op afstand, GEEN geometrie, GEEN PDOK-aanroep.
  let bestIndex = -1;
  let bestDistanceM = Infinity;

  for (let i = 0; i < fromCandidates.length; i++) {
    const candidate = fromCandidates[i];
    if (!provider.getNode(candidate.logicalNodeId)) continue; // onbekend knooppunt -- volgende proberen

    const cheapResult = computeCombinedRoute(graph, candidate.logicalNodeId, toLogicalNodeId);
    if (!cheapResult.ok) continue; // deze kandidaat leverde geen (of geen gevalideerde) route op -- volgende proberen

    if (cheapResult.distanceM < bestDistanceM) {
      bestDistanceM = cheapResult.distanceM;
      bestIndex = i;
    }
  }

  if (bestIndex === -1) {
    return {
      ok: false,
      reason: "no_usable_candidate",
      message: `Geen van de ${fromCandidates.length} kandidaat-knooppunten leverde een route naar het startpunt op.`,
      candidatesAttempted: fromCandidates.length,
    };
  }

  // FASE 2 (duur, PRECIES ÉÉN KEER): volledige geometrie opbouwen voor de winnaar.
  const winner = fromCandidates[bestIndex];
  const fullResult = await computeCombinedRouteAsRoute(graph, provider, datasetVersionId, winner.logicalNodeId, toLogicalNodeId, constraints);

  if (!fullResult.ok) {
    // Zou niet moeten gebeuren (fase 1 zei al ok) -- maar geen aanname, expliciet als faal behandelen.
    return {
      ok: false,
      reason: "no_usable_candidate",
      message: `Winnende kandidaat leverde bij geometrie-opbouw alsnog geen route op: ${fullResult.message}`,
      candidatesAttempted: fromCandidates.length,
    };
  }

  return {
    route: fullResult.route,
    resolvedEdges: fullResult.resolvedEdges,
    nodeDisplayNumbers: fullResult.nodeDisplayNumbers,
    selectedStartNodeId: winner.logicalNodeId,
    selectedStartNodeDisplayNumber: provider.getNode(winner.logicalNodeId)?.displayNumber ?? winner.logicalNodeId,
    selectedCandidateRank: bestIndex + 1,
  };
}
