import { getDb } from "@/lib/firebase-admin";
import { GraphEdge, GraphNode, GraphProvider } from "./types";

/**
 * Optie C (ontwerp sectie 4, benchmark 26-8-2026): leest de door
 * /api/import/precompute-graph vooraf berekende, gechunkte structuur --
 * minder, grotere Firestore-reads in plaats van twee gefilterde
 * collection-queries over 11.003 + 16.345 losse documenten.
 */
export class PrecomputedGraphProvider implements GraphProvider {
  private nodes: Map<string, GraphNode> = new Map();
  private edgesByNode: Map<string, GraphEdge[]> = new Map();

  constructor(private datasetVersionId: string) {}

  async load(): Promise<void> {
    const db = getDb();
    const metaSnap = await db.collection("precomputedGraph").doc(`${this.datasetVersionId}_meta`).get();
    if (!metaSnap.exists) {
      throw new Error(
        `Geen precomputed graph gevonden voor ${this.datasetVersionId}. Roep eerst /api/import/precompute-graph aan.`
      );
    }
    const meta = metaSnap.data() as { nodeChunkCount: number; edgeChunkCount: number };

    const nodeChunkRefs = Array.from({ length: meta.nodeChunkCount }, (_, i) =>
      db.collection("precomputedGraph").doc(`${this.datasetVersionId}_nodes_${i}`)
    );
    const edgeChunkRefs = Array.from({ length: meta.edgeChunkCount }, (_, i) =>
      db.collection("precomputedGraph").doc(`${this.datasetVersionId}_edges_${i}`)
    );

    const [nodeChunkDocs, edgeChunkDocs] = await Promise.all([
      Promise.all(nodeChunkRefs.map((r) => r.get())),
      Promise.all(edgeChunkRefs.map((r) => r.get())),
    ]);

    for (const doc of nodeChunkDocs) {
      const items = (doc.data()?.items || []) as GraphNode[];
      for (const n of items) this.nodes.set(n.id, n);
    }
    for (const doc of edgeChunkDocs) {
      const items = (doc.data()?.items || []) as GraphEdge[];
      for (const e of items) {
        this.addEdgeIndex(e.fromLogicalNodeId, e);
        this.addEdgeIndex(e.toLogicalNodeId, e);
      }
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
