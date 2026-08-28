import { GraphProvider, Route, RouteConstraints, RouteError } from "./types";
import { findShortestPath } from "./dijkstra";
import { buildRoute } from "./route-builder";

/**
 * Hoofdentrypoint van de Route Engine (ontwerp sectie 2, dataflow).
 * GraphProvider is al geladen door de aanroeper (zie ontwerp sectie 4 --
 * laadstrategie is een keuze van de aanroeper, niet van deze functie).
 */
export function computeRoute(
  provider: GraphProvider,
  datasetVersionId: string,
  fromNodeId: string,
  toNodeId: string,
  constraints: RouteConstraints = {}
): Route | RouteError {
  const t0 = Date.now();
  const result = findShortestPath(provider, fromNodeId, toNodeId, constraints);
  const computeTimeMs = Date.now() - t0;

  if (!result.ok) {
    return result;
  }

  const uniqueEdgeIds = new Set<string>();
  for (const nodeId of provider.getAllNodeIds()) {
    for (const edge of provider.getEdgesFrom(nodeId)) {
      uniqueEdgeIds.add(edge.id);
    }
  }
  const edgesConsidered = uniqueEdgeIds.size;

  return buildRoute({
    datasetVersionId,
    dijkstraResult: result,
    constraints,
    computeTimeMs,
    edgesConsidered,
  });
}
