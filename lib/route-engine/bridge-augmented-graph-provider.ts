import type { GraphProvider, GraphNode, GraphEdge, Point } from "./types";
import type { NetworkBridge } from "./network-bridge-types";
import { wgs84ToRd } from "./coordinate-transform";

/**
 * BridgeAugmentedGraphProvider — Network Bridge Layer, plan §9
 * (docs/network-bridge-layer-plan.md). Wikkelt om een bestaande `GraphProvider`
 * (bv. `CachedGraphProvider`) zonder die aan te raken -- 437/437 bestaande
 * Route Engine-tests blijven ongewijzigd geldig, deze klasse is puur additief.
 *
 * BELANGRIJK (gecorrigeerd na GPT-review 5-9-2026, n.a.v. de 24-richtingentest):
 * een bridge is een UITSLUITEND UITGAANDE edge vanaf `sourceNodeId`, nooit ook
 * vanaf `targetNodeId` -- de omgekeerde richting bestaat alleen als een apart,
 * eigen gevalideerd `NetworkBridge`-document. `directionality: "forward"`
 * (i.p.v. "bidirectional") is hier geen extra veiligheidslaag bovenop de
 * `sourceNodeId`-filter, maar de ENIGE plek waar dat onderscheid afdwingbaar is
 * -- zie `isTraversable()` in `is-traversable.ts`, die voor "forward" al
 * expliciet checkt of `fromNodeId === edge.fromLogicalNodeId`. Die functie was
 * al zo gebouwd (comment: "Toekomstig: alleen traversable als fromNodeId ===
 * edge.fromLogicalNodeId... nog niet in productie in gebruik") -- dit is de
 * eerste plek in de codebase die dat pad daadwerkelijk gebruikt.
 */
export class BridgeAugmentedGraphProvider implements GraphProvider {
  /** Vooraf berekende edges per node -- eenmalig bij constructie, niet per aanroep. */
  private readonly bridgeEdgesByNode: Map<string, GraphEdge[]> = new Map();

  /**
   * @param base Onderliggende provider (bv. `CachedGraphProvider`), al geladen
   *   of nog te laden via `load()` -- deze klasse delegeert `load()` door.
   * @param bridges Alleen `validationStatus === "valid"` bridges, AL gefilterd
   *   tot maximaal `MAX_ACTIVE_BRIDGES_PER_NODE` per gap-node door de caller
   *   (plan §8) -- deze klasse voert die selectie zelf niet uit, puur een
   *   render/lookup-laag.
   */
  constructor(
    private readonly base: GraphProvider,
    bridges: NetworkBridge[]
  ) {
    for (const bridge of bridges) {
      const edge = toGraphEdge(bridge);
      const list = this.bridgeEdgesByNode.get(bridge.sourceNodeId) || [];
      list.push(edge);
      this.bridgeEdgesByNode.set(bridge.sourceNodeId, list);
    }
  }

  async load(): Promise<void> {
    await this.base.load();
  }

  getNode(nodeId: string): GraphNode | undefined {
    // Bridges introduceren geen nieuwe nodes, alleen edges tussen bestaande logicalNodes.
    return this.base.getNode(nodeId);
  }

  getAllNodeIds(): string[] {
    return this.base.getAllNodeIds();
  }

  getEdgesFrom(nodeId: string): GraphEdge[] {
    const baseEdges = this.base.getEdgesFrom(nodeId);
    const bridgeEdges = this.bridgeEdgesByNode.get(nodeId) || [];
    return bridgeEdges.length > 0 ? [...baseEdges, ...bridgeEdges] : baseEdges;
  }
}

function toGraphEdge(bridge: NetworkBridge): GraphEdge {
  return {
    id: `bridge_${bridge.id}`,
    fromLogicalNodeId: bridge.sourceNodeId,
    toLogicalNodeId: bridge.targetNodeId,
    distanceM: bridge.distanceM,
    directionality: "forward", // zie klasse-commentaar -- bewust NIET "bidirectional"
    geometry: bridge.geometry.map((p): Point => wgs84ToRd(p.lat, p.lon)), // RD, consistent met reguliere edges
  };
}
