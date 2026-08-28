import { GraphEdge, GraphNode, GraphProvider } from "../types";

/**
 * Generieke, parametriseerbare GraphProvider voor tests. Los van de vaste
 * FixtureGraphProvider (die specifiek voor de Dijkstra-tests is gebouwd) --
 * hiermee kan elke test zijn eigen kleine graaf meegeven zonder een gedeeld
 * fixture-bestand te hoeven wijzigen (regressierisico op de bestaande 19
 * Dijkstra-tests vermijden).
 */
export class InMemoryGraphProvider implements GraphProvider {
  private nodeMap: Map<string, GraphNode> = new Map();
  private edgesByNode: Map<string, GraphEdge[]> = new Map();

  constructor(
    private inputNodes: GraphNode[],
    private inputEdges: GraphEdge[]
  ) {}

  async load(): Promise<void> {
    for (const n of this.inputNodes) this.nodeMap.set(n.id, n);
    for (const e of this.inputEdges) {
      this.addEdgeIndex(e.fromLogicalNodeId, e);
      this.addEdgeIndex(e.toLogicalNodeId, e);
    }
  }

  private addEdgeIndex(nodeId: string, edge: GraphEdge) {
    const list = this.edgesByNode.get(nodeId) || [];
    list.push(edge);
    this.edgesByNode.set(nodeId, list);
  }

  getNode(nodeId: string): GraphNode | undefined {
    return this.nodeMap.get(nodeId);
  }

  getAllNodeIds(): string[] {
    return Array.from(this.nodeMap.keys());
  }

  getEdgesFrom(nodeId: string): GraphEdge[] {
    return this.edgesByNode.get(nodeId) || [];
  }
}
