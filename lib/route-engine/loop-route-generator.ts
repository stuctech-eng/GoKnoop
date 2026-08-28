import { GraphProvider, Route } from "./types";
import { computeRoute } from "./route-engine";
import { edgeOverlapRatio } from "./route-diversity";

/**
 * Rondje-generator (Master Plan sectie 74/90: "Hoe ver? -> 20/30/40/50km ->
 * meerdere routevoorstellen"). Fundamenteel andere vraag dan A->B: hier is er
 * GEEN bekend eindpunt, alleen een startpunt en een gewenste totale afstand.
 *
 * Bouwt bovenop de bestaande, ongewijzigde computeRoute()-primitive -- zelfde
 * gelaagde aanpak als RoutePlanner (route-planner.ts). Geen nieuw algoritme
 * in Dijkstra zelf, alleen een nieuwe manier om 'm te gebruiken.
 *
 * MVP-heuristiek (expliciet geen bewezen optimale oplossing):
 * 1. Schat een "straal": targetDistanceM / 2 / circuityFactor. circuityFactor
 *    (default 1.3) compenseert dat een werkelijk fietspad zelden een rechte
 *    lijn is -- een empirische aanname, geen gemeten constante voor dit
 *    specifieke netwerk. Te verfijnen zodra er echte gebruiksdata is.
 * 2. Zoek kandidaat-waypoints rond die straal, verspreid over meerdere
 *    richtingen (hoek-buckets) -- zodat de voorgestelde rondjes niet allemaal
 *    dezelfde kant op gaan.
 * 3. Voor elke kandidaat: bereken een heenweg (start -> waypoint) en een
 *    terugweg (waypoint -> start) die de edges van de heenweg vermijdt --
 *    dat dwingt een ECHT rondje af, geen "dezelfde weg heen en terug".
 * 4. Sorteer op afwijking van de gewenste afstand, filter duplicaten
 *    (zelfde diversiteitscontract als RoutePlanner).
 */

export type LoopCandidate = {
  route: Route;
  targetDistanceM: number;
  actualDistanceM: number;
  deviationM: number;
  deviationPercent: number;
};

export type LoopGenerationResult = {
  loops: LoopCandidate[];
  requestedCount: number;
  foundCount: number;
  targetDistanceM: number;
  estimatedRadiusM: number;
};

const DEFAULT_CIRCUITY_FACTOR = 1.3;
const DEFAULT_ANGLE_BUCKETS = 8;
const DEFAULT_RADIUS_TOLERANCE = 0.4; // kandidaten binnen 60%-140% van de geschatte straal
const DEFAULT_OVERLAP_THRESHOLD = 0.6;

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function angleOf(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

function findCandidateWaypoints(
  provider: GraphProvider,
  startNodeId: string,
  targetRadiusM: number,
  angleBuckets: number,
  radiusTolerance: number
): string[] {
  const start = provider.getNode(startNodeId);
  if (!start) return [];

  const minRadius = targetRadiusM * (1 - radiusTolerance);
  const maxRadius = targetRadiusM * (1 + radiusTolerance);

  const bestPerBucket: Map<number, { nodeId: string; deviation: number }> = new Map();

  for (const nodeId of provider.getAllNodeIds()) {
    if (nodeId === startNodeId) continue;
    const n = provider.getNode(nodeId);
    if (!n) continue;
    const d = dist(start, n);
    if (d < minRadius || d > maxRadius) continue;

    const angle = angleOf(start, n);
    const bucket = Math.floor(((angle + Math.PI) / (2 * Math.PI)) * angleBuckets) % angleBuckets;
    const deviation = Math.abs(d - targetRadiusM);
    const existing = bestPerBucket.get(bucket);
    if (!existing || deviation < existing.deviation) {
      bestPerBucket.set(bucket, { nodeId, deviation });
    }
  }

  return Array.from(bestPerBucket.values()).map((v) => v.nodeId);
}

/** Voegt een heenweg en terugweg samen tot één doorlopende lus-Route. */
function combineIntoLoop(datasetVersionId: string, outbound: Route, inbound: Route): Route {
  const nodes = [...outbound.nodes, ...inbound.nodes.slice(1)];
  const edges = [...outbound.edges, ...inbound.edges];

  let geometry = [...outbound.geometry];
  const inboundGeom = inbound.geometry;
  if (geometry.length > 0 && inboundGeom.length > 0) {
    const last = geometry[geometry.length - 1];
    const first = inboundGeom[0];
    geometry = last.x === first.x && last.y === first.y ? geometry.concat(inboundGeom.slice(1)) : geometry.concat(inboundGeom);
  } else {
    geometry = geometry.concat(inboundGeom);
  }

  return {
    id: `loop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    datasetVersionId,
    source: "route-engine-v1",
    network: "fiets",
    mode: "bicycle",
    nodes,
    edges,
    geometry,
    distanceM: outbound.distanceM + inbound.distanceM,
    elevation: null,
    durationEstimate: null,
    preferences: {},
    constraints: {},
    waypoints: [],
    alternatives: [],
    navigation: null,
    metadata: {
      algorithm: "dijkstra",
      computedAt: new Date().toISOString(),
      computeTimeMs: outbound.metadata.computeTimeMs + inbound.metadata.computeTimeMs,
      edgesConsidered: Math.max(outbound.metadata.edgesConsidered, inbound.metadata.edgesConsidered),
    },
  };
}

export function generateLoopRoutes(
  provider: GraphProvider,
  datasetVersionId: string,
  startNodeId: string,
  targetDistanceM: number,
  options: {
    count?: number;
    circuityFactor?: number;
    angleBuckets?: number;
    radiusTolerance?: number;
    overlapThreshold?: number;
  } = {}
): LoopGenerationResult {
  const count = options.count ?? 4;
  const circuityFactor = options.circuityFactor ?? DEFAULT_CIRCUITY_FACTOR;
  const angleBuckets = options.angleBuckets ?? DEFAULT_ANGLE_BUCKETS;
  const radiusTolerance = options.radiusTolerance ?? DEFAULT_RADIUS_TOLERANCE;
  const overlapThreshold = options.overlapThreshold ?? DEFAULT_OVERLAP_THRESHOLD;

  const estimatedRadiusM = targetDistanceM / 2 / circuityFactor;
  const waypointCandidates = findCandidateWaypoints(
    provider,
    startNodeId,
    estimatedRadiusM,
    angleBuckets,
    radiusTolerance
  );

  const candidates: LoopCandidate[] = [];

  for (const waypointId of waypointCandidates) {
    const outboundResult = computeRoute(provider, datasetVersionId, startNodeId, waypointId);
    if ("reason" in outboundResult) continue;

    // Terugweg MOET de heenweg-edges vermijden -- anders is het geen rondje,
    // maar een rechte lijn heen-en-terug (verdubbelt gewoon dezelfde route).
    const inboundResult = computeRoute(provider, datasetVersionId, waypointId, startNodeId, {
      avoidEdgeIds: outboundResult.edges,
    });
    if ("reason" in inboundResult) continue;

    const loop = combineIntoLoop(datasetVersionId, outboundResult, inboundResult);
    const deviationM = Math.abs(loop.distanceM - targetDistanceM);

    candidates.push({
      route: loop,
      targetDistanceM,
      actualDistanceM: loop.distanceM,
      deviationM,
      deviationPercent: (deviationM / targetDistanceM) * 100,
    });
  }

  candidates.sort((a, b) => a.deviationM - b.deviationM);

  const accepted: LoopCandidate[] = [];
  for (const candidate of candidates) {
    if (accepted.length >= count) break;
    const isDuplicate = accepted.some(
      (a) => edgeOverlapRatio(a.route.edges, candidate.route.edges) > overlapThreshold
    );
    if (!isDuplicate) accepted.push(candidate);
  }

  return {
    loops: accepted,
    requestedCount: count,
    foundCount: accepted.length,
    targetDistanceM,
    estimatedRadiusM,
  };
}
