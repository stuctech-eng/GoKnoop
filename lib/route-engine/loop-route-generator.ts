import { GraphProvider, GraphEdge, Route } from "./types";
import { computeRoute } from "./route-engine";
import { edgeOverlapRatio } from "./route-diversity";
import { resolveRouteEdges } from "./resolve-route-edges";

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
  /**
   * Volledige GraphEdge-objecten voor route.edges[], in dezelfde volgorde --
   * ADDITIEF toegevoegd (GOKNOOP-MASTER.md sectie 7, Phase 4-UI-integratie),
   * bestaande velden (route/nodes/edges/geometry/distanceM) ongewijzigd. De
   * Navigation Engine (buildRouteProgressModel, stap 5) kan dit rechtstreeks
   * consumeren zonder edges opnieuw te reconstrueren uit de platte geometrie
   * -- "Route Engine → GraphEdge[] → Navigation Engine" blijft één bron van
   * waarheid, geen tweede/parallel edge-datamodel.
   */
  resolvedEdges: GraphEdge[];
  /**
   * Weergavenummers (GraphNode.displayNumber) voor route.nodes[], in dezelfde
   * volgorde -- ADDITIEF toegevoegd (bugfix 29-8-2026: de navigatie-UI toonde
   * anders de interne Firestore-document-ID als "knooppuntnummer", bijv.
   * "9CHmIH3BmYvDp7wmARBq" i.p.v. "96"). Valt terug op de logicalNodeId zelf
   * als een node onverhoopt geen displayNumber heeft (geen crash, wel zichtbaar
   * een technisch ID i.p.v. een stil leeg label).
   */
  nodeDisplayNumbers: string[];
};

/** Interne, tussentijdse vorm vóór dedup -- resolvedEdges/nodeDisplayNumbers pas berekend voor de daadwerkelijk geaccepteerde kandidaten (geen verspilde GraphProvider-lookups voor afgewezen/duplicate kandidaten). */
type LoopCandidateDraft = Omit<LoopCandidate, "resolvedEdges" | "nodeDisplayNumbers">;

export type LoopGenerationResult = {
  loops: LoopCandidate[];
  requestedCount: number;
  foundCount: number;
  targetDistanceM: number;
  estimatedRadiusM: number;
  diagnostics: {
    candidatesFound: number;
    outboundFailed: number;
    inboundFailed: number;
    duplicateRejected: number;
    succeeded: number;
  };
};

const DEFAULT_CIRCUITY_FACTOR = 1.6; // herijkt 28-8-2026 op basis van eerste productiemeting (was 1.3, zie hieronder)
const DEFAULT_ANGLE_BUCKETS = 8;
const DEFAULT_RADIUS_TOLERANCE = 0.4; // kandidaten binnen 60%-140% van de geschatte straal
const DEFAULT_OVERLAP_THRESHOLD = 0.6;
const CANDIDATES_PER_BUCKET = 3; // meerdere kandidaten per richting, niet alleen de dichtstbijzijnde radius-match

/**
 * HERIJKING 28-8-2026: eerste test tegen de echte 11.003-node-dataset
 * (target 20km, straal-schatting 7.692m bij circuityFactor=1.3) leverde een
 * beste kandidaat van 25.309m op -- een werkelijke verhouding van
 * 25309 / (2 * 7692) = 1,65, niet 1,3. Circuityfactor herijkt naar 1,6.
 * Dit blijft een aanname op basis van ÉÉN meting, geen robuust statistisch
 * gemiddelde -- verdient verdere kalibratie zodra er meer testresultaten of
 * echte gebruiksdata beschikbaar zijn.
 */

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
  radiusTolerance: number,
  candidatesPerBucket: number
): string[] {
  const start = provider.getNode(startNodeId);
  if (!start) return [];

  const minRadius = targetRadiusM * (1 - radiusTolerance);
  const maxRadius = targetRadiusM * (1 + radiusTolerance);

  // Per hoek-bucket de N beste kandidaten bijhouden (dichtst bij targetRadiusM),
  // niet slechts 1 -- meer opties per richting vergroot de kans op een goede
  // daadwerkelijke padafstand-match (rechte-lijnafstand is maar een schatting).
  const byBucket: Map<number, { nodeId: string; deviation: number }[]> = new Map();

  for (const nodeId of provider.getAllNodeIds()) {
    if (nodeId === startNodeId) continue;
    const n = provider.getNode(nodeId);
    if (!n) continue;
    const d = dist(start, n);
    if (d < minRadius || d > maxRadius) continue;

    const angle = angleOf(start, n);
    const bucket = Math.floor(((angle + Math.PI) / (2 * Math.PI)) * angleBuckets) % angleBuckets;
    const deviation = Math.abs(d - targetRadiusM);

    const list = byBucket.get(bucket) || [];
    list.push({ nodeId, deviation });
    byBucket.set(bucket, list);
  }

  const result: string[] = [];
  for (const list of byBucket.values()) {
    list.sort((a, b) => a.deviation - b.deviation);
    for (const item of list.slice(0, candidatesPerBucket)) {
      result.push(item.nodeId);
    }
  }
  return result;
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
    candidatesPerBucket?: number;
  } = {}
): LoopGenerationResult {
  const count = options.count ?? 4;
  const circuityFactor = options.circuityFactor ?? DEFAULT_CIRCUITY_FACTOR;
  const angleBuckets = options.angleBuckets ?? DEFAULT_ANGLE_BUCKETS;
  const radiusTolerance = options.radiusTolerance ?? DEFAULT_RADIUS_TOLERANCE;
  const overlapThreshold = options.overlapThreshold ?? DEFAULT_OVERLAP_THRESHOLD;
  const candidatesPerBucket = options.candidatesPerBucket ?? CANDIDATES_PER_BUCKET;

  const estimatedRadiusM = targetDistanceM / 2 / circuityFactor;
  const waypointCandidates = findCandidateWaypoints(
    provider,
    startNodeId,
    estimatedRadiusM,
    angleBuckets,
    radiusTolerance,
    candidatesPerBucket
  );

  const candidates: LoopCandidateDraft[] = [];
  let outboundFailed = 0;
  let inboundFailed = 0;

  for (const waypointId of waypointCandidates) {
    const outboundResult = computeRoute(provider, datasetVersionId, startNodeId, waypointId);
    if ("reason" in outboundResult) {
      outboundFailed++;
      continue;
    }

    // Terugweg MOET de heenweg-edges vermijden -- anders is het geen rondje,
    // maar een rechte lijn heen-en-terug (verdubbelt gewoon dezelfde route).
    const inboundResult = computeRoute(provider, datasetVersionId, waypointId, startNodeId, {
      avoidEdgeIds: outboundResult.edges,
    });
    if ("reason" in inboundResult) {
      inboundFailed++;
      continue;
    }

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
  let duplicateRejected = 0;
  for (const candidate of candidates) {
    if (accepted.length >= count) break;
    const isDuplicate = accepted.some(
      (a) => edgeOverlapRatio(a.route.edges, candidate.route.edges) > overlapThreshold
    );
    if (isDuplicate) {
      duplicateRejected++;
      continue;
    }
    accepted.push({
      ...candidate,
      resolvedEdges: resolveRouteEdges(provider, candidate.route),
      nodeDisplayNumbers: candidate.route.nodes.map((nodeId) => provider.getNode(nodeId)?.displayNumber ?? nodeId),
    });
  }

  return {
    loops: accepted,
    requestedCount: count,
    foundCount: accepted.length,
    targetDistanceM,
    estimatedRadiusM,
    diagnostics: {
      candidatesFound: waypointCandidates.length,
      outboundFailed,
      inboundFailed,
      duplicateRejected,
      succeeded: candidates.length,
    },
  };
}

/**
 * Startknooppunt-kandidaat, in afstandsvolgorde -- zelfde vorm als
 * `LocationCandidate` uit `location-resolver.ts` (geen dubbel type, alleen
 * de velden die deze functie nodig heeft).
 */
export type LoopStartCandidate = {
  logicalNodeId: string;
  distanceM?: number;
};

export type LoopGenerationWithFallbackResult = LoopGenerationResult & {
  /** Het knooppunt waar de teruggegeven routes daadwerkelijk vandaan komen -- niet per se candidates[0]. */
  selectedStartNodeId: string;
  selectedStartNodeDisplayNumber: string;
  /** null als de aanroeper geen afstand voor dit kandidaat heeft meegegeven. */
  selectedStartNodeDistanceM: number | null;
  /** 1-based: 1 = eerste (dichtstbijzijnde) kandidaat werkte al, 2 = tweede kandidaat nodig, enz. */
  selectedCandidateRank: number;
  candidatesAttempted: number;
};

export type LoopGenerationFallbackFailure = {
  ok: false;
  reason: "no_usable_candidate";
  message: string;
  candidatesAttempted: number;
  attempts: { logicalNodeId: string; foundCount: number }[];
};

/**
 * Rondje-generatie MET fallback over meerdere startknooppunt-kandidaten
 * (Volendam-onderzoek 29-8-2026 -- ontwerpbeslissing, GOKNOOP-MASTER.md).
 *
 * KERN VAN DE BESLISSING: de gebruiker vraagt niet om "een route vanaf mijn
 * dichtstbijzijnste knooppunt", maar om "een bruikbare route vanaf mijn
 * locatie". Welke van de kandidaten daarvoor het beste startknooppunt is,
 * is een Route Engine-verantwoordelijkheid, geen UI-beslissing (`app/page.tsx`
 * bevat hierdoor geen fallback-logica).
 *
 * Probeert kandidaten STRIKT in de meegegeven volgorde (afstandsvolgorde,
 * bepaald door de aanroeper -- deze functie herordent niet op eigen
 * initiatief). Stopt bij de EERSTE kandidaat die minstens 1 bruikbare route
 * oplevert -- geen kwaliteitsvergelijking tussen kandidaten (bewust nog niet:
 * "eerst de 1->5 fallback bouwen en testen, daarna pas eventueel een
 * start-node-score met afstand+beschikbaarheid+kwaliteit").
 *
 * Onderscheid, bewust zo geformuleerd: dit is niet "kandidaat 1 heeft geen
 * routes -> neem kandidaat 2", maar "kandidaat 1 kan geen bruikbare route
 * leveren -> probeer de volgende kandidaat" -- foundCount === 0 is het enige
 * criterium hier, geen aanname over WAAROM een kandidaat faalt.
 */
export function generateLoopRoutesWithFallback(
  provider: GraphProvider,
  datasetVersionId: string,
  candidates: readonly LoopStartCandidate[],
  targetDistanceM: number,
  options: Parameters<typeof generateLoopRoutes>[4] = {}
): LoopGenerationWithFallbackResult | LoopGenerationFallbackFailure {
  const attempts: { logicalNodeId: string; foundCount: number }[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!provider.getNode(candidate.logicalNodeId)) {
      attempts.push({ logicalNodeId: candidate.logicalNodeId, foundCount: 0 });
      continue; // onbekend knooppunt -- geen crash, gewoon de volgende kandidaat proberen
    }

    const result = generateLoopRoutes(provider, datasetVersionId, candidate.logicalNodeId, targetDistanceM, options);
    attempts.push({ logicalNodeId: candidate.logicalNodeId, foundCount: result.foundCount });

    if (result.foundCount > 0) {
      return {
        ...result,
        selectedStartNodeId: candidate.logicalNodeId,
        selectedStartNodeDisplayNumber: provider.getNode(candidate.logicalNodeId)?.displayNumber ?? candidate.logicalNodeId,
        selectedStartNodeDistanceM: candidate.distanceM ?? null,
        selectedCandidateRank: i + 1,
        candidatesAttempted: i + 1,
      };
    }
  }

  return {
    ok: false,
    reason: "no_usable_candidate",
    message: `Geen van de ${candidates.length} kandidaat-knooppunten leverde een bruikbare route op voor ${targetDistanceM}m.`,
    candidatesAttempted: candidates.length,
    attempts,
  };
}
