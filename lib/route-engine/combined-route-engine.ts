import type { GraphProvider, Route, RouteConstraints } from "./types";
import { dijkstraWithCostModel, makeCostFn, type CombinedGraph } from "../nwb-analysis/combined-graph";
import { evaluateRouteQuality, type RouteQualityResult } from "../nwb-analysis/route-quality";
import { buildCombinedRouteGeometry } from "./combined-route-geometry";

/**
 * Gecombineerde route-engine (GoKnoop + NWB + gevalideerde connectors +
 * kostenmodel + kwaliteitsvalidatie) -- Fase G/H/I, 9-9-2026, HERZIEN in
 * Fase K (performance).
 *
 * HERZIENING FASE K: deze functie bouwt de graaf niet meer zelf -- die komt
 * nu AL-GEBOUWD binnen (`graph: CombinedGraph`), zodat de aanroeper
 * (app/api/route/combined/route.ts, via cached-nwb-provider.ts) de dure
 * graafopbouw kan cachen tussen aanvragen. Coördinaten voor de
 * hemelsbrede-afstandsberekening komen nu uit `graph.nodePosition` (die
 * bevat zowel GoKnoop- als NWB-clusterknopen) -- geen aparte GraphProvider
 * meer nodig in deze functie.
 *
 * BEWUST EEN NIEUWE, APARTE MODULE, niet een wijziging aan route-engine.ts.
 * De bestaande /api/route-dataflow blijft volledig ongewijzigd.
 *
 * BEKENDE BEPERKING (zie docs/ROUTING-IMPROVEMENT-MASTER.md): NWB-segmenten
 * hebben geen volledige geometrie beschikbaar. `geometryAvailable.nwb` is
 * daarom altijd `false`.
 */

// Fase C-besluit (9-9-2026), kwantitatief onderbouwd -- zie master-document.
export const F_NWB_PRODUCTION = 1.2;
export const F_CONNECTOR_PRODUCTION = 1.0;

export type CombinedRouteResult =
  | {
      ok: true;
      distanceM: number;
      straightLineDistanceM: number;
      goknoopEdgeCount: number;
      nwbEdgeCount: number;
      connectorCount: number;
      quality: RouteQualityResult;
      geometryAvailable: { goknoop: boolean; nwb: boolean };
      computeTimeMs: number;
    }
  | {
      ok: false;
      reason: "node_not_found" | "disconnected" | "quality_rejected";
      message: string;
      quality?: RouteQualityResult;
    };

export function computeCombinedRoute(graph: CombinedGraph, fromNodeId: string, toNodeId: string): CombinedRouteResult {
  const t0 = Date.now();

  const fromPos = graph.nodePosition.get(fromNodeId);
  const toPos = graph.nodePosition.get(toNodeId);
  if (!fromPos || !toPos) {
    return { ok: false, reason: "node_not_found", message: "from- of to-knooppunt bestaat niet in de actieve dataset." };
  }
  const straightLineDistanceM = Math.hypot(toPos.x - fromPos.x, toPos.y - fromPos.y);

  const result = dijkstraWithCostModel(graph, fromNodeId, toNodeId, makeCostFn(F_NWB_PRODUCTION, F_CONNECTOR_PRODUCTION));
  const computeTimeMs = Date.now() - t0;

  if (!result.found) {
    return { ok: false, reason: "disconnected", message: "Geen route gevonden in de gecombineerde graaf (GoKnoop + NWB + connectors)." };
  }

  const quality = evaluateRouteQuality({
    distanceM: result.distanceM,
    straightLineDistanceM,
    switchCount: result.connectorCount,
  });

  if (quality.verdict !== "geaccepteerd") {
    return {
      ok: false,
      reason: "quality_rejected",
      message: `Route afgewezen door de kwaliteitsvalidatie: ${quality.reden}`,
      quality,
    };
  }

  return {
    ok: true,
    distanceM: Math.round(result.distanceM),
    straightLineDistanceM: Math.round(straightLineDistanceM),
    goknoopEdgeCount: result.goknoopEdgeCount,
    nwbEdgeCount: result.nwbEdgeCount,
    connectorCount: result.connectorCount,
    quality,
    geometryAvailable: { goknoop: true, nwb: false },
    computeTimeMs,
  };
}

/**
 * Fase M5, 10-9-2026. Bouwt een ECHTE, volledige `Route` (zelfde vorm als
 * `route-builder.ts`'s `buildRoute()`) via de gecombineerde engine --
 * inclusief volledige, gestikte geometrie (`buildCombinedRouteGeometry`)
 * en al-opgeloste `GraphEdge[]` (geen aparte `resolveRouteEdges()`-stap
 * nodig, en die zou hier ook niet werken -- die kent alleen GoKnoop-edges).
 *
 * BEWUST ASYNC (in tegenstelling tot de bestaande, synchrone `computeRoute`)
 * -- geometrie-opbouw vereist een live PDOK-aanroep. Aanroepers moeten dit
 * awaiten; dat is precies de reden waarom dit een NIEUWE functie is, geen
 * wijziging aan de bestaande, synchrone `computeRoute`.
 */
const DISTANCE_INVARIANT_TOLERANCE_M = 1; // iets ruimer dan de bestaande 0.01m -- realistische marge gezien de e2e-test (11m op 29.978m, floating-point-opstapeling over 1300+ punten)

export type CombinedRouteAsRouteResult =
  | { ok: true; route: Route; resolvedEdges: import("./types").GraphEdge[]; nodeDisplayNumbers: string[] }
  | { ok: false; reason: "node_not_found" | "disconnected" | "quality_rejected" | "geometry_failed"; message: string; quality?: RouteQualityResult };

export async function computeCombinedRouteAsRoute(
  graph: CombinedGraph,
  goknoopProvider: GraphProvider,
  datasetVersionId: string,
  fromNodeId: string,
  toNodeId: string,
  constraints: RouteConstraints = {}
): Promise<CombinedRouteAsRouteResult> {
  const t0 = Date.now();

  const fromPos = graph.nodePosition.get(fromNodeId);
  const toPos = graph.nodePosition.get(toNodeId);
  if (!fromPos || !toPos) {
    return { ok: false, reason: "node_not_found", message: "from- of to-knooppunt bestaat niet in de actieve dataset." };
  }
  const straightLineDistanceM = Math.hypot(toPos.x - fromPos.x, toPos.y - fromPos.y);

  const dijkstraResult = dijkstraWithCostModel(graph, fromNodeId, toNodeId, makeCostFn(F_NWB_PRODUCTION, F_CONNECTOR_PRODUCTION));
  if (!dijkstraResult.found) {
    return { ok: false, reason: "disconnected", message: "Geen route gevonden in de gecombineerde graaf (GoKnoop + NWB + connectors)." };
  }

  const quality = evaluateRouteQuality({
    distanceM: dijkstraResult.distanceM,
    straightLineDistanceM,
    switchCount: dijkstraResult.connectorCount,
  });
  if (quality.verdict !== "geaccepteerd") {
    return { ok: false, reason: "quality_rejected", message: `Route afgewezen door de kwaliteitsvalidatie: ${quality.reden}`, quality };
  }

  const geometryResult = await buildCombinedRouteGeometry(dijkstraResult.steps, graph, goknoopProvider);
  if (!geometryResult.ok) {
    return { ok: false, reason: "geometry_failed", message: `Geometrie-opbouw mislukt: ${geometryResult.reason}` };
  }

  const computeTimeMs = Date.now() - t0;
  const sumOfEdgeDistances = geometryResult.edges.reduce((sum, e) => sum + e.distanceM, 0);
  if (Math.abs(sumOfEdgeDistances - dijkstraResult.distanceM) > DISTANCE_INVARIANT_TOLERANCE_M) {
    return {
      ok: false,
      reason: "geometry_failed",
      message: `Distance-invariant geschonden: Σ edges[i].distanceM (${sumOfEdgeDistances}) wijkt te veel af van de berekende afstand (${dijkstraResult.distanceM}).`,
    };
  }

  const nodes = dijkstraResult.steps.map((s) => s.nodeId);
  const nodeDisplayNumbers = nodes.map((id) => goknoopProvider.getNode(id)?.displayNumber ?? (id.startsWith("nwb:") ? "fietspad" : id));

  const route: Route = {
    id: `route_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    datasetVersionId,
    source: "combined-route-engine-v1",
    network: "fiets",
    mode: "bicycle",
    nodes,
    edges: geometryResult.edges.map((e) => e.id),
    geometry: geometryResult.geometry,
    distanceM: dijkstraResult.distanceM,
    elevation: null,
    durationEstimate: null,
    preferences: {},
    constraints,
    waypoints: [],
    alternatives: [],
    navigation: null,
    metadata: {
      algorithm: "combined-cost-aware-dijkstra",
      computedAt: new Date().toISOString(),
      computeTimeMs,
      edgesConsidered: geometryResult.edges.length,
    },
  };

  return { ok: true, route, resolvedEdges: geometryResult.edges, nodeDisplayNumbers };
}
