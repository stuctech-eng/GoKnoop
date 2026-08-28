/**
 * Route Engine — kerntypes.
 * Zie docs/phase2-route-engine-design.md voor het volledige contract.
 */

export type Point = { x: number; y: number };

export type Directionality = "unknown" | "forward" | "reverse" | "bidirectional";

/** Eén edge zoals de Route Engine 'm ziet — al vertaald vanuit Firestore/fixture. */
export type GraphEdge = {
  id: string;
  fromLogicalNodeId: string;
  toLogicalNodeId: string;
  distanceM: number; // lengte van de brongeometrie, NOOIT Euclidische afstand (zie ontwerp sectie 3)
  directionality: Directionality; // RAW-waarde, wordt nooit herschreven (zie ontwerp sectie 5)
  geometry: Point[]; // coördinaten in de richting from -> to
};

export type GraphNode = {
  id: string;
  displayNumber?: string;
  displayRegio?: string;
  x: number;
  y: number;
};

/**
 * GraphProvider-abstractie (ontwerp sectie 4). Dijkstra praat alleen met deze
 * interface, nooit rechtstreeks met Firestore of een fixture-bestand — de
 * laadstrategie kan later wisselen zonder de pathfinding-code te raken.
 */
export interface GraphProvider {
  load(): Promise<void>;
  getNode(nodeId: string): GraphNode | undefined;
  getAllNodeIds(): string[];
  /** Alle edges die vanaf deze node vertrekken (in beide richtingen relevant, zie isTraversable). */
  getEdgesFrom(nodeId: string): GraphEdge[];
}

export type RouteConstraints = {
  avoidNodeIds?: string[];
  avoidEdgeIds?: string[];
};

export type RouteErrorReason = "disconnected" | "no_traversable_edges" | "all_paths_blocked_by_constraints";

export type RouteError = {
  ok: false;
  reason: RouteErrorReason;
  message: string;
};

export type DijkstraResult = {
  ok: true;
  nodeSequence: string[]; // logicalNodeId's, van start tot doel
  edgeSequence: GraphEdge[]; // exact één minder dan nodeSequence.length
  totalDistanceM: number;
};

export type Route = {
  id: string;
  datasetVersionId: string;
  source: "route-engine-v1";
  network: "fiets";
  mode: "bicycle";
  nodes: string[];
  edges: string[]; // edge id's, in volgorde — VERPLICHT, nooit afgeleid uit nodes[] (ontwerp sectie 6)
  geometry: Point[];
  distanceM: number;
  elevation: null;
  durationEstimate: null;
  preferences: Record<string, never>;
  constraints: RouteConstraints;
  waypoints: never[];
  alternatives: Route[]; // MVP: bevat alleen zichzelf niet — leeg, structuur wel aanwezig
  navigation: null;
  metadata: {
    algorithm: "dijkstra";
    computedAt: string;
    computeTimeMs: number;
    edgesConsidered: number;
  };
};
