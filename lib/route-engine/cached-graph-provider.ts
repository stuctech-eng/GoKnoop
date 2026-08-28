import { GraphEdge, GraphNode, GraphProvider } from "./types";
import { FirestoreGraphProvider } from "./firestore-graph-provider";

/**
 * Optie B (ontwerp sectie 4, benchmark 26-8-2026): in-memory cache op
 * module-niveau. Zolang de serverless-functie "warm" blijft (Vercel houdt
 * een instance een tijd actief na de laatste aanroep), wordt de graph maar
 * één keer echt uit Firestore geladen -- volgende aanvragen binnen dezelfde
 * instance hergebruiken hem direct uit het geheugen.
 *
 * Belangrijk: dit is GEEN garantie. Een cold start (nieuwe instance, na
 * inactiviteit of een nieuwe deploy) laadt gewoon opnieuw vanaf nul -- dat is
 * precies waarom dit benchmark-eerst-aanpak nodig had (ontwerp sectie 4).
 */

type CachedGraph = {
  nodes: Map<string, GraphNode>;
  edgesByNode: Map<string, GraphEdge[]>;
  loadedAt: number;
};

// Module-niveau state: blijft bestaan zolang de serverless-instance warm is.
const moduleCache = new Map<string, CachedGraph>();

export class CachedGraphProvider implements GraphProvider {
  private cacheHit = false;

  constructor(private datasetVersionId: string) {}

  get wasCacheHit(): boolean {
    return this.cacheHit;
  }

  async load(): Promise<void> {
    const cached = moduleCache.get(this.datasetVersionId);
    if (cached) {
      this.cacheHit = true;
      return;
    }

    this.cacheHit = false;
    const underlying = new FirestoreGraphProvider(this.datasetVersionId);
    await underlying.load();

    const nodes = new Map<string, GraphNode>();
    for (const id of underlying.getAllNodeIds()) {
      const n = underlying.getNode(id);
      if (n) nodes.set(id, n);
    }
    const edgesByNode = new Map<string, GraphEdge[]>();
    for (const id of underlying.getAllNodeIds()) {
      edgesByNode.set(id, underlying.getEdgesFrom(id));
    }

    moduleCache.set(this.datasetVersionId, { nodes, edgesByNode, loadedAt: Date.now() });
  }

  getNode(nodeId: string): GraphNode | undefined {
    return moduleCache.get(this.datasetVersionId)?.nodes.get(nodeId);
  }

  getAllNodeIds(): string[] {
    return Array.from(moduleCache.get(this.datasetVersionId)?.nodes.keys() || []);
  }

  getEdgesFrom(nodeId: string): GraphEdge[] {
    return moduleCache.get(this.datasetVersionId)?.edgesByNode.get(nodeId) || [];
  }
}
