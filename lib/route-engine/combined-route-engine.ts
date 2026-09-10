import type { GraphProvider } from "./types";
import {
  buildValidatedCombinedGraph,
  dijkstraWithCostModel,
  makeCostFn,
  type SlimNwbSegment,
  type ValidatedConnectorInput,
} from "../nwb-analysis/combined-graph";
import { evaluateRouteQuality, type RouteQualityResult } from "../nwb-analysis/route-quality";

/**
 * Gecombineerde route-engine (GoKnoop + NWB + gevalideerde connectors +
 * kostenmodel + kwaliteitsvalidatie) -- Fase G/H/I, 9-9-2026.
 *
 * BEWUST EEN NIEUWE, APARTE MODULE, niet een wijziging aan route-engine.ts.
 * De bestaande /api/route-dataflow blijft volledig ongewijzigd; dit is een
 * additieve, nog niet aan de bestaande API/UI gekoppelde mogelijkheid.
 *
 * BEKENDE BEPERKING (zie docs/ROUTING-IMPROVEMENT-MASTER.md, "Belangrijke,
 * nieuw ontdekte beperking"): NWB-segmenten hebben geen volledige geometrie
 * beschikbaar in de huidige dataverzameling. `geometryAvailable.nwb` is
 * daarom altijd `false` -- dit endpoint levert een correcte AFSTAND en
 * SAMENSTELLING, nog geen volledig navigeerbare kaartweergave voor het
 * NWB-deel van een route.
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

/**
 * `toleranceM` (connector-zoekstraal) is bewust vast op 20m -- zelfde waarde
 * als in het volledige Fase 3/5-onderzoek gebruikt en gevalideerd.
 */
const CONNECTOR_SEARCH_TOLERANCE_M = 20;

export function computeCombinedRoute(
  provider: GraphProvider,
  nwbSegments: SlimNwbSegment[],
  validatedConnectors: ValidatedConnectorInput[],
  fromNodeId: string,
  toNodeId: string
): CombinedRouteResult {
  const t0 = Date.now();

  const fromNode = provider.getNode(fromNodeId);
  const toNode = provider.getNode(toNodeId);
  if (!fromNode || !toNode) {
    return { ok: false, reason: "node_not_found", message: "from- of to-knooppunt bestaat niet in de actieve dataset." };
  }
  const straightLineDistanceM = Math.hypot(toNode.x - fromNode.x, toNode.y - fromNode.y);

  const combined = buildValidatedCombinedGraph(provider, nwbSegments, CONNECTOR_SEARCH_TOLERANCE_M, validatedConnectors);
  const result = dijkstraWithCostModel(combined, fromNodeId, toNodeId, makeCostFn(F_NWB_PRODUCTION, F_CONNECTOR_PRODUCTION));
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
