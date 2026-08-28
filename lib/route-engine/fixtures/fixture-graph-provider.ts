import { GraphEdge, GraphNode, GraphProvider } from "../types";
import { fixtureEdges, fixtureNodes } from "./simple-graph";

/**
 * GraphProvider-implementatie die de handmatige fixture teruggeeft.
 * Bewijst dat de Dijkstra-kern niets afweet van de databron (ontwerp sectie 4).
 */
export class FixtureGraphProvider implements GraphProvider {
  private nodes: Map<string, GraphNode> = new Map();
  private edgesByFromNode: Map<string, GraphEdge[]> = new Map();

  async load(): Promise<void> {
    for (const n of fixtureNodes) {
      this.nodes.set(n.id, n);
    }
    for (const e of fixtureEdges) {
      // Beide richtingen indexeren -- welke kant daadwerkelijk traversable is,
      // bepaalt isTraversable(), niet de GraphProvider zelf.
      this.addEdgeIndex(e.fromLogicalNodeId, e);
      this.addEdgeIndex(e.toLogicalNodeId, e);
    }
  }

  private addEdgeIndex(nodeId: string, edge: GraphEdge) {
    const list = this.edgesByFromNode.get(nodeId) || [];
    list.push(edge);
    this.edgesByFromNode.set(nodeId, list);
  }

  getNode(nodeId: string): GraphNode | undefined {
    return this.nodes.get(nodeId);
  }

  getAllNodeIds(): string[] {
    return Array.from(this.nodes.keys());
  }

  getEdgesFrom(nodeId: string): GraphEdge[] {
    return this.edgesByFromNode.get(nodeId) || [];
  }
}
