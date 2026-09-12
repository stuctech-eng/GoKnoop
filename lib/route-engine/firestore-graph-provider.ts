import { getDb } from "@/lib/firebase-admin";
import { GraphEdge, GraphNode, GraphProvider } from "./types";
import { reportProgress } from "@/lib/diagnostics/report-progress";

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
 *
 * TOEGEVOEGD 10-9-2026 (vervolg-diagnose): expliciete reportProgress-
 * checkpoints die aangeven welk pad daadwerkelijk gebruikt werd -- na de
 * eerste migratiepoging bleef laden onverwacht traag (6,8-8,3s i.p.v. een
 * fractie van een seconde), wat vermoeden doet dat de migratie niet
 * (volledig) gelukt is en er stilzwijgend werd teruggevallen. Dit maakt dat
 * zichtbaar i.p.v. te gokken.
 */
export class FirestoreGraphProvider implements GraphProvider {
  private nodes: Map<string, GraphNode> = new Map();
  private edgesByNode: Map<string, GraphEdge[]> = new Map();

  constructor(private datasetVersionId: string) {}

  async load(): Promise<void> {
    const db = getDb();
    reportProgress("latest", "FirestoreGraphProvider.load: start", { datasetVersionId: this.datasetVersionId });

    const tCheck = Date.now();
    const batchedNodesSnap = await db.collection("goknoopBatched").doc(this.datasetVersionId).collection("nodes").get();
    reportProgress("latest", "FirestoreGraphProvider.load: gebatcht-check klaar", {
      gebatchteNodeDocumenten: batchedNodesSnap.size,
      checkDurationMs: Date.now() - tCheck,
    });

    if (!batchedNodesSnap.empty) {
      // Gebatcht formaat beschikbaar -- gebruiken.
      reportProgress("latest", "FirestoreGraphProvider.load: GEBATCHT PAD gekozen");
      const tEdges = Date.now();
      const batchedEdgesSnap = await db.collection("goknoopBatched").doc(this.datasetVersionId).collection("edges").get();
      reportProgress("latest", "FirestoreGraphProvider.load: gebatchte edges opgehaald", {
        gebatchteEdgeDocumenten: batchedEdgesSnap.size,
        durationMs: Date.now() - tEdges,
      });

      const tParse = Date.now();
      for (const doc of batchedNodesSnap.docs) {
        const data = doc.data() as { items: (GraphNode & { id: string })[] };
        for (const n of data.items) this.nodes.set(n.id, n);
      }
      const tAfterNodeParse = Date.now();
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
      reportProgress("latest", "FirestoreGraphProvider.load: GEBATCHT PAD volledig klaar", {
        nodeCount: this.nodes.size,
        edgeIndexSize: this.edgesByNode.size,
        nodeParsingMs: tAfterNodeParse - tParse,
        edgeParsingMs: Date.now() - tAfterNodeParse,
      });
      return;
    }

    // Terugval: oude, per-document-formaat (nog niet gemigreerd voor deze datasetVersionId).
    reportProgress("latest", "FirestoreGraphProvider.load: TERUGVAL-PAD gekozen (geen gebatchte data gevonden!)");
    const tFallback = Date.now();
    const [nodesSnap, edgesSnap] = await Promise.all([
      db.collection("logicalNodes").where("datasetVersionId", "==", this.datasetVersionId).get(),
      db
        .collection("edges")
        .where("datasetVersionId", "==", this.datasetVersionId)
        .where("matchConfidence", "==", "matched")
        .get(),
    ]);
    reportProgress("latest", "FirestoreGraphProvider.load: terugval-query's klaar", {
      nodeDocs: nodesSnap.size,
      edgeDocs: edgesSnap.size,
      durationMs: Date.now() - tFallback,
    });

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
    reportProgress("latest", "FirestoreGraphProvider.load: TERUGVAL-PAD volledig klaar");
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
