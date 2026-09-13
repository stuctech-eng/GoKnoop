import { DijkstraResult, GraphEdge, Point, Route, RouteConstraints } from "./types";

/**
 * Bouwt het volledige Route-object (ontwerp sectie 6) uit een geslaagd
 * Dijkstra-resultaat. Bevat de distance-invariant-validatie (ontwerp sectie 6,
 * toegevoegd na review): een interne consistentietest die faalt als de
 * reconstructie een fout bevat, los van of Dijkstra zelf correct rekende.
 */

const DISTANCE_INVARIANT_TOLERANCE_M = 0.01; // afrondingstolerantie

export class RouteInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteInvariantError";
  }
}

export function concatenateGeometry(nodeSequence: string[], edgeSequence: GraphEdge[]): Point[] {
  const geometry: Point[] = [];

  for (let i = 0; i < edgeSequence.length; i++) {
    const edge = edgeSequence[i];
    const fromNodeAtThisStep = nodeSequence[i];

    // De brongeometrie staat vast in de richting from -> to. Als we deze edge
    // in de andere richting doorlopen (want bidirectioneel, zie isTraversable),
    // moet de geometrie worden omgekeerd zodat de coördinatenreeks de
    // daadwerkelijke reisrichting volgt.
    const forward = edge.fromLogicalNodeId === fromNodeAtThisStep;
    const coords = forward ? edge.geometry : [...edge.geometry].reverse();

    // Voorkom dubbele coördinaten op de naad tussen twee opeenvolgende edges.
    if (geometry.length > 0 && coords.length > 0) {
      const last = geometry[geometry.length - 1];
      const first = coords[0];
      if (last.x === first.x && last.y === first.y) {
        geometry.push(...coords.slice(1));
        continue;
      }
    }
    geometry.push(...coords);
  }

  return geometry;
}

export function buildRoute(params: {
  datasetVersionId: string;
  dijkstraResult: DijkstraResult;
  constraints: RouteConstraints;
  computeTimeMs: number;
  edgesConsidered: number;
}): Route {
  const { datasetVersionId, dijkstraResult, constraints, computeTimeMs, edgesConsidered } = params;
  const { nodeSequence, edgeSequence, totalDistanceM } = dijkstraResult;

  const geometry = concatenateGeometry(nodeSequence, edgeSequence);

  // --- Distance-invariant (ontwerp sectie 6) ---
  const sumOfEdgeDistances = edgeSequence.reduce((sum, e) => sum + e.distanceM, 0);
  if (Math.abs(sumOfEdgeDistances - totalDistanceM) > DISTANCE_INVARIANT_TOLERANCE_M) {
    throw new RouteInvariantError(
      `Distance-invariant geschonden: route.distanceM (${totalDistanceM}) !== Σ edges[i].distanceM (${sumOfEdgeDistances}).`
    );
  }
  // Geometrie-invariant: elk edge-segment moet daadwerkelijk in de geometrie voorkomen.
  // (Lichte check: totale puntenaantal moet minstens zo groot zijn als het aantal edges + 1,
  // want elke edge draagt minimaal een start- en eindpunt bij, met deduplicatie op de naden.)
  //
  // AANGEPAST 12-9-2026 (hotfix): geometry.length === 0 is sinds de M6/M7-opslagformaat-fix
  // (10-9-2026) een GELDIGE tussentoestand -- de bulk-graaf laadt bewust alleen topologie,
  // geometrie wordt pas na routekeuze apart opgehaald (fetch-goknoop-edge-geometry.ts,
  // zie combined-route-geometry.ts voor het bestaande patroon). Deze functie hier
  // (buildRoute, via computeRoute) wordt ook door de rondje-generator aangeroepen, die dat
  // patroon nog niet had -- vandaar de crash "10 edges, 0 geometriepunten". 0 punten is nu
  // toegestaan (nog niet gehydrateerd); een PARTIEEL aantal punten (>0 maar <2) blijft wel
  // een harde bug-indicator (een reconstructie kan niet legitiem op precies 1 punt landen).
  if (edgeSequence.length > 0 && geometry.length > 0 && geometry.length < 2) {
    throw new RouteInvariantError(
      `Geometrie-invariant geschonden: route heeft ${edgeSequence.length} edges maar slechts ${geometry.length} geometriepunten.`
    );
  }

  const route: Route = {
    id: `route_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    datasetVersionId,
    source: "route-engine-v1",
    network: "fiets",
    mode: "bicycle",
    nodes: nodeSequence,
    edges: edgeSequence.map((e) => e.id),
    geometry,
    distanceM: totalDistanceM,
    elevation: null,
    durationEstimate: null,
    preferences: {},
    constraints,
    waypoints: [],
    alternatives: [],
    navigation: null,
    metadata: {
      algorithm: "dijkstra",
      computedAt: new Date().toISOString(),
      computeTimeMs,
      edgesConsidered,
    },
  };

  return route;
}
