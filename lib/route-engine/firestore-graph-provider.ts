import { getDb } from "@/lib/firebase-admin";
import { GraphEdge, GraphNode, GraphProvider } from "./types";

/**
 * Firestore-implementatie van GraphProvider (ontwerp sectie 4, optie A:
 * per-aanvraag inladen). Laadt alleen matchConfidence='matched' edges
 * (ontwerp sectie 3) -- unmatched edges bestaan gewoon in de database,
 * worden hier simpelweg niet meegenomen in de routing-graph.
 *
 * FASE M6/M7 (opslagformaat-fix), 10-9-2026: live productiemeting toonde
 * dat het laden van `logicalNodes`/`edges` als LOSSE documenten (11.003 +
 * ~15.495) 11.185ms kostte -- ALLEEN AL boven de 10s-productielimiet, los
 * van alle NWB-werk. Zelfde diagnose als de eerdere NWB-144k-fix. Leest nu
 * EERST het nieuwe, gebatchte formaat (`goknoopBatched/{id}/nodes|edges/{n}`,
 * elk document een array van meerdere items); valt terug op het oude,
 * ongewijzigde per-document-formaat als er nog geen gebatchte data bestaat
 * (veilige overgang, geen harde volgorde-afhankelijkheid met de migratie).
 */
export class FirestoreGraphProvider implements GraphProvider {
  private nodes: Map<string, GraphNode> = new Map();
  private edgesByNode: Map<string, GraphEdge[]> = new Map();

  constructor(private datasetVersionId: string) {}

  async load(): Promise<void> {
    const db = getDb();

    const batchedNodesSnap = await db.collection("goknoopBatched").doc(this.datasetVersionId).collection("nodes").get();

    if (!batchedNodesSnap.empty) {
      // Gebatcht formaat beschikbaar -- gebruiken.
      const batchedEdgesSnap = await db.collection("goknoopBatched").doc(this.datasetVersionId).collection("edges").get();

      for (const doc of batchedNodesSnap.docs) {
        const data = doc.data() as { items: (GraphNode & { id: string })[] };
        for (const n of data.items) this.nodes.set(n.id, n);
      }
      for (const doc of batchedEdgesSnap.docs) {
        const data = doc.data() as { items: (Record<string, unknown> & { id: string; fromLogicalNodeId: string; toLogicalNodeId: string; distanceM: number; directionality?: string; coords?: unknown[] })[] };
        for (const d of data.items) {
          const edge: GraphEdge = {
            id: d.id,
            fromLogicalNodeId: d.fromLogicalNodeId,
            toLogicalNodeId: d.toLogicalNodeId,
            distanceM: d.distanceM,
            directionality: (d.directionality as GraphEdge["directionality"]) || "unknown",
            geometry: (d.coords as GraphEdge["geometry"]) || [],
          };
          this.addEdgeIndex(edge.fromLogicalNodeId, edge);
          this.addEdgeIndex(edge.toLogicalNodeId, edge);
        }
      }
      return;
    }

    // Terugval: oude, per-document-formaat (nog niet gemigreerd voor deze datasetVersionId).
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
