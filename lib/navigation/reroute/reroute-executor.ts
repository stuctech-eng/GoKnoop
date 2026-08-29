import { Route, RouteConstraints } from "../../route-engine/types";
import { RouteEngineClient } from "./route-engine-client";

/**
 * Reroute-uitvoering (ontwerp sectie 10/18/19) -- implementatiestap 8.
 *
 * Vertaalt `temporaryAvoidEdgeIds` (stap 7, `RerouteContextTracker`) naar
 * de bestaande `RouteConstraints` uit het Phase 2-contract, roept de
 * geïnjecteerde `RouteEngineClient` aan, en bewaakt drie dingen die het
 * ontwerp expliciet vereist:
 *   - de oorspronkelijke `Route` wordt NOOIT gemuteerd (puur lezen);
 *   - een succesvolle reroute levert een NIEUW `Route`-object op
 *     (`newRoute.id !== originalRoute.id`, afzonderlijk object);
 *   - de dataset-versie blijft gepind (ontwerp sectie 19) -- een resultaat
 *     met een afwijkende `datasetVersionId` wordt behandeld als mislukt,
 *     niet stilzwijgend geaccepteerd (zie route-engine-client.ts voor de
 *     achtergrond van deze kloof met de huidige API).
 */

export type RerouteRequest = {
  originalRoute: Route;
  /**
   * Dichtstbijzijnde routeerbare node bij de huidige matched-positie.
   * Resolutie hiervan (via `resolveNearestNodes()`, Phase 2/3) is de
   * verantwoordelijkheid van de aanroeper -- geen GPS/coördinatenlogica
   * hier, geen duplicatie van die bestaande functionaliteit.
   */
  fromLogicalNodeId: string;
  temporaryAvoidEdgeIds: readonly string[];
};

export type RerouteResult =
  | { outcome: "success"; newRoute: Route }
  | { outcome: "failed"; reason: string; message: string };

export class RerouteExecutor {
  constructor(private readonly client: RouteEngineClient) {}

  async execute(request: RerouteRequest): Promise<RerouteResult> {
    const { originalRoute, fromLogicalNodeId, temporaryAvoidEdgeIds } = request;
    const toLogicalNodeId = originalRoute.nodes[originalRoute.nodes.length - 1];

    const constraints: RouteConstraints = {
      // avoidNodeIds: ongewijzigd overgenomen van de oorspronkelijke route -- deze stap
      // introduceert geen node-constraints, alleen de tijdelijke edge-avoidance (stap 7).
      avoidNodeIds: originalRoute.constraints.avoidNodeIds,
      avoidEdgeIds: mergeUnique(originalRoute.constraints.avoidEdgeIds ?? [], temporaryAvoidEdgeIds),
    };

    let result: Route | { reason: string; message: string };
    try {
      result = await this.client.computeRoute({ fromLogicalNodeId, toLogicalNodeId, constraints });
    } catch (err) {
      return { outcome: "failed", reason: "network_error", message: err instanceof Error ? err.message : String(err) };
    }

    if ("reason" in result) {
      return { outcome: "failed", reason: result.reason, message: result.message };
    }

    if (result.datasetVersionId !== originalRoute.datasetVersionId) {
      return {
        outcome: "failed",
        reason: "dataset_version_mismatch",
        message: `Herberekening leverde dataset ${result.datasetVersionId} op; sessie is gepind op ${originalRoute.datasetVersionId}.`,
      };
    }

    return { outcome: "success", newRoute: result };
  }
}

function mergeUnique(a: readonly string[], b: readonly string[]): string[] {
  return Array.from(new Set([...a, ...b]));
}
