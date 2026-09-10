import {
  dijkstraWithCostModel,
  makeCostFn,
  type CombinedGraph,
} from "../nwb-analysis/combined-graph";
import { evaluateRouteQuality, type RouteQualityResult } from "../nwb-analysis/route-quality";

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
