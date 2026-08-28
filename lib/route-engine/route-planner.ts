import { GraphProvider, Route, RouteConstraints } from "./types";
import { computeRoute } from "./route-engine";
import { edgeOverlapRatio } from "./route-diversity";

/**
 * RoutePlanner (GPT-review 26-8-2026): een aparte laag boven de bestaande
 * MVP-primitive. `computeRoute()` (route-engine.ts) blijft ONGEWIJZIGD --
 * de planner roept 'm gewoon herhaaldelijk aan met andere constraints.
 *
 * RouteEngine.computeRoute()  <- blijft de fundamentele primitive
 * RoutePlanner.calculateAlternatives()  <- nieuwe laag hierboven
 *
 * Algoritme (MVP-heuristiek, EXPLICIET geen bewezen k-shortest-path-
 * implementatie -- dat is een bewuste, latere uitbreiding, zie
 * docs/phase2-route-engine-design.md sectie 9):
 *
 * 1. Route 1 = kortste pad, geen extra constraints.
 * 2. Route 2..N = kortste pad, met alle edges van eerder GEACCEPTEERDE
 *    routes als avoidEdgeIds. Dat dwingt een aantoonbaar ander tracé af.
 * 3. Een kandidaat wordt alleen geaccepteerd als de edge-overlap (sectie
 *    route-diversity.ts) met ELKE eerder geaccepteerde route onder de
 *    drempel blijft (default 70%) -- anders is het geen echte keuze voor
 *    de gebruiker.
 * 4. Als volledige vermijding geen pad meer oplevert, wordt de laatst
 *    toegevoegde route weer vrijgegeven (gedeeltelijke terugval) voor een
 *    nieuwe poging, in plaats van meteen op te geven.
 * 5. Stopt bij `count` geaccepteerde alternatieven, of na een begrensd
 *    aantal pogingen. Minder alternatieven dan gevraagd is een eerlijk
 *    resultaat (geen opvulling met duplicaten).
 */

export type AlternativesResult = {
  routes: Route[];
  requestedCount: number;
  foundCount: number;
};

const DEFAULT_OVERLAP_THRESHOLD = 0.7;
const MAX_ATTEMPTS_MULTIPLIER = 4;

export function calculateAlternatives(
  provider: GraphProvider,
  datasetVersionId: string,
  fromNodeId: string,
  toNodeId: string,
  options: {
    count?: number;
    overlapThreshold?: number;
    baseConstraints?: RouteConstraints;
  } = {}
): AlternativesResult {
  const count = options.count ?? 4;
  const overlapThreshold = options.overlapThreshold ?? DEFAULT_OVERLAP_THRESHOLD;
  const baseAvoidNodeIds = options.baseConstraints?.avoidNodeIds;
  const baseAvoidEdgeIds = options.baseConstraints?.avoidEdgeIds || [];

  const accepted: Route[] = [];
  const avoidedSoFar = new Set<string>(baseAvoidEdgeIds);
  let attempts = 0;
  const maxAttempts = Math.max(count * MAX_ATTEMPTS_MULTIPLIER, 4);

  while (accepted.length < count && attempts < maxAttempts) {
    attempts++;

    const result = computeRoute(provider, datasetVersionId, fromNodeId, toNodeId, {
      avoidNodeIds: baseAvoidNodeIds,
      avoidEdgeIds: Array.from(avoidedSoFar),
    });

    if ("reason" in result) {
      // Geen pad meer mogelijk met de huidige vermeden edges. Val terug:
      // geef de edges van de laatst geaccepteerde route weer vrij, en
      // probeer nogmaals -- misschien is er via een gedeeltelijk ander
      // tracé nog een route te vinden.
      const lastAccepted = accepted[accepted.length - 1];
      if (lastAccepted && lastAccepted.edges.length > 0) {
        for (const edgeId of lastAccepted.edges) avoidedSoFar.delete(edgeId);
        continue;
      }
      break; // écht geen alternatief meer te vinden
    }

    const isDuplicate = accepted.some((r) => edgeOverlapRatio(r.edges, result.edges) > overlapThreshold);
    if (!isDuplicate) {
      accepted.push(result);
    }

    for (const edgeId of result.edges) avoidedSoFar.add(edgeId);
  }

  return { routes: accepted, requestedCount: count, foundCount: accepted.length };
}
