import { DijkstraResult, GraphEdge, GraphProvider, RouteConstraints, RouteError } from "./types";
import { isTraversable } from "./is-traversable";
import { MinHeap } from "./min-heap";

/**
 * Dijkstra's kortste-pad-algoritme (ontwerp sectie 5). Gewicht = edge.distanceM
 * (brongeometrie-lengte, NOOIT Euclidische afstand -- zie ontwerp sectie 3).
 *
 * Parallelle edges (ontwerp sectie 3): bij het opbouwen van de "beste stap
 * naar deze buur" wordt niet één edge per nodepaar aangenomen -- alle edges
 * vanaf een node worden los overwogen, dus als er meerdere edges naar dezelfde
 * buur bestaan, kiest het algoritme vanzelf de goedkoopste (de duurdere wordt
 * simpelweg nooit de kortste-pad-voorganger).
 */

export function findShortestPath(
  provider: GraphProvider,
  fromNodeId: string,
  toNodeId: string,
  constraints: RouteConstraints = {}
): DijkstraResult | RouteError {
  const avoidNodeIds = new Set(constraints.avoidNodeIds || []);
  const avoidEdgeIds = new Set(constraints.avoidEdgeIds || []);

  if (avoidNodeIds.has(fromNodeId) || avoidNodeIds.has(toNodeId)) {
    return {
      ok: false,
      reason: "all_paths_blocked_by_constraints",
      message: "Start- of eindnode staat zelf in avoidNodeIds.",
    };
  }

  const fromNode = provider.getNode(fromNodeId);
  const toNode = provider.getNode(toNodeId);
  if (!fromNode || !toNode) {
    return {
      ok: false,
      reason: "disconnected",
      message: "fromNodeId of toNodeId bestaat niet in de graph.",
    };
  }

  if (fromNodeId === toNodeId) {
    return { ok: true, nodeSequence: [fromNodeId], edgeSequence: [], totalDistanceM: 0 };
  }

  const startEdges = provider.getEdgesFrom(fromNodeId).filter((e) => !avoidEdgeIds.has(e.id));
  if (startEdges.length === 0) {
    return {
      ok: false,
      reason: "no_traversable_edges",
      message: `Node ${fromNodeId} heeft geen (toegestane) edges -- geïsoleerde node.`,
    };
  }

  const dist: Map<string, number> = new Map();
  const prevEdge: Map<string, GraphEdge> = new Map();
  const prevNode: Map<string, string> = new Map();
  const visited: Set<string> = new Set();

  dist.set(fromNodeId, 0);
  const heap = new MinHeap<string>();
  heap.push(0, fromNodeId);

  let reachedAnyOtherNode = false;

  while (heap.size > 0) {
    const currentId = heap.pop()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    if (currentId === toNodeId) break;

    const currentDist = dist.get(currentId)!;

    for (const edge of provider.getEdgesFrom(currentId)) {
      if (avoidEdgeIds.has(edge.id)) continue;
      if (!isTraversable(edge, currentId)) continue;

      const neighborId = edge.fromLogicalNodeId === currentId ? edge.toLogicalNodeId : edge.fromLogicalNodeId;
      if (avoidNodeIds.has(neighborId)) continue;
      if (visited.has(neighborId)) continue;

      const candidateDist = currentDist + edge.distanceM;
      const known = dist.get(neighborId);
      if (known === undefined || candidateDist < known) {
        dist.set(neighborId, candidateDist);
        prevEdge.set(neighborId, edge);
        prevNode.set(neighborId, currentId);
        heap.push(candidateDist, neighborId);
        reachedAnyOtherNode = true;
      }
    }
  }

  if (!visited.has(toNodeId)) {
    if (!reachedAnyOtherNode) {
      return {
        ok: false,
        reason: "no_traversable_edges",
        message: `Vanaf ${fromNodeId} is geen enkele andere node bereikbaar.`,
      };
    }
    return {
      ok: false,
      reason: "disconnected",
      message: `${fromNodeId} en ${toNodeId} zitten in verschillende connected components.`,
    };
  }

  // Pad terugreconstrueren.
  const nodeSequence: string[] = [toNodeId];
  const edgeSequence: GraphEdge[] = [];
  let cursor = toNodeId;
  while (cursor !== fromNodeId) {
    const edge = prevEdge.get(cursor)!;
    const prev = prevNode.get(cursor)!;
    edgeSequence.push(edge);
    nodeSequence.push(prev);
    cursor = prev;
  }
  nodeSequence.reverse();
  edgeSequence.reverse();

  return {
    ok: true,
    nodeSequence,
    edgeSequence,
    totalDistanceM: dist.get(toNodeId)!,
  };
}
