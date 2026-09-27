import type { GraphProvider } from "./types";
import { computeRoute } from "./route-engine";
import { rdToWgs84 } from "./coordinate-transform";
import { LocalBikeRouter } from "@/lib/local-bike-router/local-bike-router";
import { OpenRouteServiceAdapter } from "@/lib/local-bike-router/open-route-service-adapter";
import { getCachedKnotSegment, setCachedKnotSegment } from "./knot-segment-cache";
import type { LatLon, LocalBikeRouteResult, LocalBikeRouteStep } from "@/lib/local-bike-router/types";

/**
 * "Functie 2" (19-9-2026, GO van Te, overlegd): de kortste weg via knooppunten
 * vinden, maar het daadwerkelijke rijpad tussen elk paar opeenvolgende knooppunten
 * met de bewezen-werkende echte-fietspad-motor (functie 1, ORS) berekenen --
 * i.p.v. het oude NWB/connector-systeem. Gebruikt UITSLUITEND `computeRoute()`
 * (de pure, nooit-door-de-NWB-bugs-geraakte knooppunten-Dijkstra, zie
 * lib/route-engine/route-engine.ts/dijkstra.ts) voor de knooppuntvolgorde zelf --
 * geen NWB, geen connectors, geen bridges.
 *
 * ONTWERPBESLISSINGEN, zoals overlegd (niet aangenomen, expliciet besproken):
 * - sequentiële ORS-aanroepen met een vaste pauze ertussen (zelfde 1,6s die eerder
 *   al empirisch veilig bleek tegen ORS' per-minuut-limiet, zie generate-bridges/route.ts) --
 *   bewust GEEN parallellisatie, dat zou de per-minuut-limiet juist sneller raken;
 * - een harde bovengrens op het aantal knooppunten, boven welke een duidelijke fout
 *   teruggegeven wordt i.p.v. een trage of afgekapte berekening;
 * - een PERMANENTE cache (Firestore, `knot-segment-cache.ts`) per knooppuntpaar --
 *   een pauze is alleen nodig vóór een ECHTE ORS-aanroep, nooit bij een cache-hit.
 *
 * OMWEG-DETECTIE + GERICHTE OVERBRUGGING (19-9-2026, vervolg op het Volendam-Hoorn-
 * onderzoek en de landelijke connected-components/detour-detector-analyse): de pure
 * knooppuntengraaf bleek landelijk 1.111 losse componenten te hebben. In plaats van elk
 * gat handmatig te vinden en te patchen (niet haalbaar op deze schaal), EN in plaats van
 * bij een omweg de HELE reis naar functie 1 te laten terugvallen (eerdere, eenvoudigere
 * versie -- verloor het knooppunten-karakter ook voor de delen die prima gingen), plant
 * deze functie nu (`planSegments`) het pad als een reeks stukken: het merendeel blijft
 * gewoon een normale, per-knooppunt-overbrugde "knot-chain", en UITSLUITEND het kleinst
 * mogelijke, coherente omweg-stuk wordt in één keer rechtstreeks overbrugd (functie 1
 * tussen de twee randknooppunten van dat stuk, de tussenliggende knooppunten overgeslagen).
 * Verdeel-en-heers (binary search over de knooppuntvolgorde): zolang splitsen een schoon
 * subdeel isoleert, wordt dat subdeel apart gehouden; zodra splitsen niet meer helpt (beide
 * helften nog steeds een omweg), wordt het HUIDIGE stuk als geheel overbrugd, niet verder
 * opgesplitst tot zinloze losse enkele-hop-overbruggingen.
 */

/** Boven dit aantal knooppunten in de kortste route: expliciete afwijzing, geen poging. */
export const MAX_KNOOPPUNTEN_PER_ROUTE = 20;
/** Zelfde, empirisch bevestigd veilige pauze als het eerdere bridge-generatie-werk. */
const ORS_CALL_DELAY_MS = 1600;
/**
 * Boven deze verhouding (padafstand / hemelsbrede afstand) wordt een stuk van de route als
 * onredelijke omweg beschouwd. Een normale fietsroute (bochten, geen rechte lijn) zit
 * doorgaans ruim onder 1,4x; de Volendam-Hoorn-omweg zat rond de 2,9x. 1,8 is een bewust
 * ruime marge (nooit een normale, licht kronkelende route onterecht afwijzen), niet een
 * precies gekalibreerde grens -- instelbaar mocht praktijk anders uitwijzen.
 */
const DETOUR_RATIO_THRESHOLD = 1.8;

export type KnotSegmentSource = "cache" | "ors";

/**
 * Pure omweg-beslissing (19-9-2026) -- apart en zonder Firestore/ORS testbaar. Geeft ook
 * `ratio` terug (niet alleen een boolean) zodat de aanroeper 'm kan tonen/loggen.
 * `straightLineM === 0` wordt bewust NOOIT als omweg aangemerkt -- delen door nul zou een
 * oneindige/zinloze verhouding geven.
 */
export function evaluateDetour(
  pathDistanceM: number,
  straightLineM: number,
  threshold: number = DETOUR_RATIO_THRESHOLD
): { isDetour: boolean; ratio: number } {
  if (straightLineM <= 0) return { isDetour: false, ratio: 1 };
  const ratio = pathDistanceM / straightLineM;
  return { isDetour: ratio > threshold, ratio };
}

export type PlannedSegment =
  | { type: "knot-chain"; nodeIds: string[] }
  | { type: "direct-bridge"; fromNodeId: string; toNodeId: string; skippedNodeIds: string[]; ratio: number };

/**
 * Verdeel-en-heers-planner (19-9-2026) -- pure functie, geen Firestore/ORS, apart getest.
 * `straightLineM(aId, bId)` als losse functie meegegeven (niet een GraphProvider) zodat dit
 * in tests met simpele, ingebakken coördinaten te verifiëren is zonder een provider te
 * hoeven bouwen.
 */
export function planSegments(
  nodeIds: string[],
  hopDistancesM: number[],
  straightLineM: (fromId: string, toId: string) => number,
  threshold: number = DETOUR_RATIO_THRESHOLD
): PlannedSegment[] {
  if (nodeIds.length < 2) return [];

  function pathDistance(startIdx: number, endIdx: number): number {
    let sum = 0;
    for (let i = startIdx; i < endIdx; i++) sum += hopDistancesM[i];
    return sum;
  }

  function plan(startIdx: number, endIdx: number): PlannedSegment[] {
    const { isDetour } = evaluateDetour(pathDistance(startIdx, endIdx), straightLineM(nodeIds[startIdx], nodeIds[endIdx]), threshold);
    if (!isDetour) {
      return [{ type: "knot-chain", nodeIds: nodeIds.slice(startIdx, endIdx + 1) }];
    }
    if (endIdx - startIdx <= 1) {
      // Eén enkele, echte edge, toch als omweg gemarkeerd (zeldzaam -- een bochtig
      // fysiek pad) -- niets meer te splitsen, overbrug 'm rechtstreeks.
      const { ratio } = evaluateDetour(pathDistance(startIdx, endIdx), straightLineM(nodeIds[startIdx], nodeIds[endIdx]), threshold);
      return [{ type: "direct-bridge", fromNodeId: nodeIds[startIdx], toNodeId: nodeIds[endIdx], skippedNodeIds: [], ratio }];
    }

    const mid = Math.floor((startIdx + endIdx) / 2);
    const left = evaluateDetour(pathDistance(startIdx, mid), straightLineM(nodeIds[startIdx], nodeIds[mid]), threshold);
    const right = evaluateDetour(pathDistance(mid, endIdx), straightLineM(nodeIds[mid], nodeIds[endIdx]), threshold);

    if (!left.isDetour && !right.isDetour) {
      return [...plan(startIdx, mid), ...plan(mid, endIdx)];
    }
    if (left.isDetour && !right.isDetour) {
      return [...plan(startIdx, mid), { type: "knot-chain", nodeIds: nodeIds.slice(mid, endIdx + 1) }];
    }
    if (!left.isDetour && right.isDetour) {
      return [{ type: "knot-chain", nodeIds: nodeIds.slice(startIdx, mid + 1) }, ...plan(mid, endIdx)];
    }
    // Beide helften nog steeds een omweg -- verder splitsen isoleert het probleem niet
    // beter, dus dit hele stuk in één keer overbruggen i.p.v. zinloos door te blijven
    // splitsen tot losse, nutteloze enkele-hop-overbruggingen.
    const { ratio } = evaluateDetour(pathDistance(startIdx, endIdx), straightLineM(nodeIds[startIdx], nodeIds[endIdx]), threshold);
    return [
      {
        type: "direct-bridge",
        fromNodeId: nodeIds[startIdx],
        toNodeId: nodeIds[endIdx],
        skippedNodeIds: nodeIds.slice(startIdx + 1, endIdx),
        ratio,
      },
    ];
  }

  return plan(0, nodeIds.length - 1);
}

export type ViaKnooppuntenResult = {
  /** De uiteindelijke, getoonde knooppuntvolgorde -- knooppunten die door een overbrugging zijn overgeslagen, staan hier NIET in (wel in `bridgedSpans[].skippedNodeIds`). */
  nodeIds: string[];
  displayNumbers: string[];
  geometry: LatLon[];
  distanceM: number;
  durationS: number;
  steps: LocalBikeRouteStep[];
  /** Eén entry per daadwerkelijk uitgevoerde stap (zowel losse knot-chain-hops als directe overbruggingen). */
  segmentSources: KnotSegmentSource[];
  /** true zodra minstens één stuk van de route rechtstreeks overbrugd moest worden. */
  usedDirectFallback: boolean;
  /** De omweg-verhouding van de HELE oorspronkelijke Dijkstra-route (vóór planning) -- puur ter transparantie/diagnose. */
  overallDetourRatio: number;
  /** Welke specifieke stukken overbrugd zijn, en hoeveel/welke knooppunten daarbij zijn overgeslagen. */
  bridgedSpans: { fromNodeId: string; toNodeId: string; fromDisplayNumber: string; toDisplayNumber: string; skippedNodeIds: string[]; ratio: number }[];
};

export type ViaKnooppuntenError =
  | { reason: "dijkstra_failed"; message: string }
  | {
      reason: "too_many_knooppunten";
      knooppuntenCount: number;
      limit: number;
      nodeIds: string[];
      displayNumbers: string[];
      positions: LatLon[];
    }
  | { reason: "segment_failed"; fromNodeId: string; toNodeId: string; message: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Eén stuk (cache-eerst, anders ORS) tussen twee -- niet per se aangrenzende -- knooppunten ophalen. */
async function resolveBridgeSegment(
  router: LocalBikeRouter,
  fromId: string,
  toId: string,
  fromWgs84: LatLon,
  toWgs84: LatLon
): Promise<{ segment: LocalBikeRouteResult; source: KnotSegmentSource } | { error: string }> {
  const cached = await getCachedKnotSegment(fromId, toId);
  if (cached) return { segment: cached, source: "cache" };

  const result = await router.route(fromWgs84, toWgs84, "cycling", { includeSteps: true });
  if ("reason" in result) return { error: result.message };
  await setCachedKnotSegment(fromId, toId, result);
  return { segment: result, source: "ors" };
}

export async function routeViaKnooppunten(
  provider: GraphProvider,
  datasetVersionId: string,
  fromNodeId: string,
  toNodeId: string
): Promise<ViaKnooppuntenResult | ViaKnooppuntenError> {
  // Stap 1: kortste knooppuntvolgorde -- de pure, NWB-vrije Dijkstra (al bestaand, ongewijzigd).
  const dijkstraResult = computeRoute(provider, datasetVersionId, fromNodeId, toNodeId);
  if ("reason" in dijkstraResult) {
    return { reason: "dijkstra_failed", message: dijkstraResult.message };
  }
  const nodeIds = dijkstraResult.nodes;
  const displayNumbers = nodeIds.map((id) => provider.getNode(id)?.displayNumber ?? "?");

  if (nodeIds.length > MAX_KNOOPPUNTEN_PER_ROUTE) {
    const positions = nodeIds.map((id) => {
      const node = provider.getNode(id);
      return node ? rdToWgs84(node.x, node.y) : { lat: 0, lon: 0 };
    });
    return { reason: "too_many_knooppunten", knooppuntenCount: nodeIds.length, limit: MAX_KNOOPPUNTEN_PER_ROUTE, nodeIds, displayNumbers, positions };
  }

  const straightLineFn = (aId: string, bId: string): number => {
    const a = provider.getNode(aId);
    const b = provider.getNode(bId);
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  // Hop-afstanden tussen elk opeenvolgend paar -- rechtstreeks uit de graaf (elke edge in de
  // Dijkstra-uitkomst is per definitie een echte, matched edge), NIET opnieuw uit de Dijkstra
  // zelf afgeleid -- geen wijziging aan route-engine.ts/dijkstra.ts nodig.
  const hopDistancesM: number[] = [];
  for (let i = 0; i < nodeIds.length - 1; i++) {
    const edge = provider.getEdgesFrom(nodeIds[i]).find((e) => e.toLogicalNodeId === nodeIds[i + 1] || e.fromLogicalNodeId === nodeIds[i + 1]);
    hopDistancesM.push(edge?.distanceM ?? straightLineFn(nodeIds[i], nodeIds[i + 1]));
  }

  const overallDetourRatio = evaluateDetour(dijkstraResult.distanceM, straightLineFn(fromNodeId, toNodeId)).ratio;
  const plan = planSegments(nodeIds, hopDistancesM, straightLineFn);

  const router = new LocalBikeRouter(new OpenRouteServiceAdapter());
  let combinedGeometry: LatLon[] = [];
  let combinedDistanceM = 0;
  let combinedDurationS = 0;
  const combinedSteps: LocalBikeRouteStep[] = [];
  const segmentSources: KnotSegmentSource[] = [];
  const bridgedSpans: ViaKnooppuntenResult["bridgedSpans"] = [];
  const outputNodeIds: string[] = [];

  function appendSegment(segment: LocalBikeRouteResult) {
    combinedGeometry = combinedGeometry.length === 0 ? segment.geometry : [...combinedGeometry, ...segment.geometry.slice(1)];
    combinedDistanceM += segment.distanceM;
    combinedDurationS += segment.durationS;
    if (segment.steps) combinedSteps.push(...segment.steps);
  }

  for (const part of plan) {
    if (part.type === "knot-chain") {
      for (let i = 0; i < part.nodeIds.length; i++) {
        if (outputNodeIds[outputNodeIds.length - 1] !== part.nodeIds[i]) outputNodeIds.push(part.nodeIds[i]);
      }
      for (let i = 0; i < part.nodeIds.length - 1; i++) {
        const fromId = part.nodeIds[i];
        const toId = part.nodeIds[i + 1];
        const fromNode = provider.getNode(fromId);
        const toNode = provider.getNode(toId);
        if (!fromNode || !toNode) {
          return { reason: "segment_failed", fromNodeId: fromId, toNodeId: toId, message: "Knooppunt niet gevonden in de graaf." };
        }
        const resolved = await resolveBridgeSegment(router, fromId, toId, rdToWgs84(fromNode.x, fromNode.y), rdToWgs84(toNode.x, toNode.y));
        if ("error" in resolved) {
          return { reason: "segment_failed", fromNodeId: fromId, toNodeId: toId, message: resolved.error };
        }
        segmentSources.push(resolved.source);
        appendSegment(resolved.segment);
        if (resolved.source === "ors") {
          await sleep(ORS_CALL_DELAY_MS);
        }
      }
    } else {
      if (outputNodeIds[outputNodeIds.length - 1] !== part.fromNodeId) outputNodeIds.push(part.fromNodeId);
      outputNodeIds.push(part.toNodeId);

      const fromNode = provider.getNode(part.fromNodeId);
      const toNode = provider.getNode(part.toNodeId);
      if (!fromNode || !toNode) {
        return { reason: "segment_failed", fromNodeId: part.fromNodeId, toNodeId: part.toNodeId, message: "Knooppunt niet gevonden in de graaf." };
      }
      const resolved = await resolveBridgeSegment(router, part.fromNodeId, part.toNodeId, rdToWgs84(fromNode.x, fromNode.y), rdToWgs84(toNode.x, toNode.y));
      if ("error" in resolved) {
        return { reason: "segment_failed", fromNodeId: part.fromNodeId, toNodeId: part.toNodeId, message: `Omweg gedetecteerd (${part.ratio.toFixed(1)}x), overbrugging mislukte ook: ${resolved.error}` };
      }
      segmentSources.push(resolved.source);
      appendSegment(resolved.segment);
      bridgedSpans.push({
        fromNodeId: part.fromNodeId,
        toNodeId: part.toNodeId,
        fromDisplayNumber: provider.getNode(part.fromNodeId)?.displayNumber ?? "?",
        toDisplayNumber: provider.getNode(part.toNodeId)?.displayNumber ?? "?",
        skippedNodeIds: part.skippedNodeIds,
        ratio: Number(part.ratio.toFixed(2)),
      });
      if (resolved.source === "ors") {
        await sleep(ORS_CALL_DELAY_MS);
      }
    }
  }

  return {
    nodeIds: outputNodeIds,
    displayNumbers: outputNodeIds.map((id) => provider.getNode(id)?.displayNumber ?? "?"),
    geometry: combinedGeometry,
    distanceM: combinedDistanceM,
    durationS: combinedDurationS,
    steps: combinedSteps,
    segmentSources,
    usedDirectFallback: bridgedSpans.length > 0,
    overallDetourRatio: Number(overallDetourRatio.toFixed(2)),
    bridgedSpans,
  };
}
