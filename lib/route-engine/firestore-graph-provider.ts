import { getDb } from "@/lib/firebase-admin";
import { GraphEdge, GraphNode, GraphProvider } from "./types";

/**
 * Firestore-implementatie van GraphProvider (ontwerp sectie 4, optie A:
 * per-aanvraag inladen). Laadt alleen matchConfidence='matched' edges
 * (ontwerp sectie 3) -- unmatched edges bestaan gewoon in de database,
 * worden hier simpelweg niet meegenomen in de routing-graph.
 */
export class FirestoreGraphProvider implements GraphProvider {
  private nodes: Map<string, GraphNode> = new Map();
  private edgesByNode: Map<string, GraphEdge[]> = new Map();

  constructor(private datasetVersionId: string) {}

  async load(): Promise<void> {
    const db = getDb();

    const [nodesSnap, edgesSnap] = await Promise.all([
      db.collection("logicalNodes").where("datasetVersionId", "==", this.datasetVersionId).get(),
      db
        .collection("edges")
        .where("datasetVersionId", "==", this.datasetVersionId)
        .where("matchConfidence", "==", "matched")
        .get(),
    ]);

    for (const doc of nodesSnap.docs) {
      const d = doc.data();
      this.nodes.set(doc.id, {
        id: doc.id,
        displayNumber: d.displayNumber,
        displayRegio: d.displayRegio,
        x: d.x,
        y: d.y,
      });
    }

    for (const doc of edgesSnap.docs) {
      const d = doc.data();
      const edge: GraphEdge = {
        id: doc.id,
        fromLogicalNodeId: d.fromLogicalNodeId,
        toLogicalNodeId: d.toLogicalNodeId,
        distanceM: d.distanceM,
        directionality: d.directionality || "unknown",
        geometry: d.coords || [],
      };
      this.addEdgeIndex(edge.fromLogicalNodeId, edge);
      this.addEdgeIndex(edge.toLogicalNodeId, edge);
    }
  }

  private addEdgeIndex(nodeId: string, edge: GraphEdge) {
    const list = this.edgesByNode.get(nodeId) || [];
    list.push(edge);
    this.edgesByNode.set(nodeId, list);
  }

  getNode(nodeId: string): GraphNode | undefined {
    return this.nodes.get(nodeId);
  }

  getAllNodeIds(): string[] {
    return Array.from(this.nodes.keys());
  }

  getEdgesFrom(nodeId: string): GraphEdge[] {
    return this.edgesByNode.get(nodeId) || [];
  }
}
