import type { GraphEdge, Point, Route } from "./types";

/**
 * Plakt twee opeenvolgende route-benen (bijv. origin→tussenpunt en
 * tussenpunt→bestemming, sectie 9.49 "plus lusje") aan elkaar tot één
 * doorlopende route. Puur, geen netwerkaanroep -- de twee benen zijn al
 * apart berekend (elk via de bestaande knooppunten-Dijkstra).
 *
 * Neemt aan dat `legA` eindigt waar `legB` begint (hetzelfde tussenpunt) --
 * dat gedeelde punt wordt niet gedupliceerd in de samengevoegde route.
 */
export type CombinableLeg = {
  route: Route;
  resolvedEdges: GraphEdge[];
  nodeDisplayNumbers: string[];
};

export function combineRouteLegs(legA: CombinableLeg, legB: CombinableLeg): { route: Route; resolvedEdges: GraphEdge[]; nodeDisplayNumbers: string[] } {
  const nodes = [...legA.route.nodes, ...legB.route.nodes.slice(1)];
  const edges = [...legA.route.edges, ...legB.route.edges];
  const geometry: Point[] = [...legA.route.geometry, ...legB.route.geometry.slice(1)];
  const distanceM = legA.route.distanceM + legB.route.distanceM;
  const resolvedEdges = [...legA.resolvedEdges, ...legB.resolvedEdges];
  const nodeDisplayNumbers = [...legA.nodeDisplayNumbers, ...legB.nodeDisplayNumbers.slice(1)];

  return {
    // legA.route als basis (overige metadata-velden -- algoritme, timestamps etc. -- doen er
    // voor een samengevoegde route niet toe, alleen nodes/edges/geometry/distanceM worden
    // daadwerkelijk overschreven).
    route: { ...legA.route, nodes, edges, geometry, distanceM },
    resolvedEdges,
    nodeDisplayNumbers,
  };
}
