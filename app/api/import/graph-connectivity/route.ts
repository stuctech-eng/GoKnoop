import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Phase 1B ontwerp sectie 7 — Graph-connectivity validatie.
 *
 * Werkt uitsluitend op logicalNodes + matched edges (al in Firestore) —
 * geen Routedatabank nodig. Rapporteert:
 *   - aantal connected components (idealiter 1, of een klein verklaarbaar aantal)
 *   - geïsoleerde nodes (0 edges)
 *   - dead-end nodes (precies 1 edge)
 *   - grootte van de grootste component(en)
 *   - ongewoon grote composite clusters (veel sourceNodes samengevoegd —
 *     mogelijk over-clustering, zie GPT-review 25-8-2026)
 */

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId");
  if (!datasetVersionId) {
    return NextResponse.json({ error: "datasetVersionId is verplicht." }, { status: 400 });
  }
  const largeClusterThreshold = parseInt(req.nextUrl.searchParams.get("largeClusterThreshold") || "5", 10);

  try {
    const db = getDb();

    const [logicalNodesSnap, edgesSnap] = await Promise.all([
      db.collection("logicalNodes").where("datasetVersionId", "==", datasetVersionId).get(),
      db
        .collection("edges")
        .where("datasetVersionId", "==", datasetVersionId)
        .where("matchConfidence", "==", "matched")
        .get(),
    ]);

    const nodeIds: string[] = logicalNodesSnap.docs.map((d) => d.id);
    const idToIndex: Record<string, number> = {};
    nodeIds.forEach((id, i) => (idToIndex[id] = i));
    // TOEGEVOEGD 19-9-2026 ("alles controleren en checken", stap 1 van 2, GO van Te):
    // per node displayNumber/displayRegio bijhouden, zodat de losse groepjes hieronder
    // concreet te tonen zijn (welke knooppunten, niet alleen hoeveel).
    const nodeInfo: { displayNumber: string | null; displayRegio: string | null }[] = logicalNodesSnap.docs.map((d) => {
      const data = d.data();
      return { displayNumber: data.displayNumber ?? null, displayRegio: data.displayRegio ?? null };
    });

    const degree: number[] = new Array(nodeIds.length).fill(0);
    const uf = new UnionFind(nodeIds.length);

    let edgesUsed = 0;
    let edgesSkippedInvalidRef = 0;

    for (const doc of edgesSnap.docs) {
      const d = doc.data();
      const fromIdx = idToIndex[d.fromLogicalNodeId];
      const toIdx = idToIndex[d.toLogicalNodeId];
      if (fromIdx === undefined || toIdx === undefined) {
        edgesSkippedInvalidRef++;
        continue;
      }
      degree[fromIdx]++;
      degree[toIdx]++;
      uf.union(fromIdx, toIdx);
      edgesUsed++;
    }

    // Connected components
    const componentSizes: Record<number, number> = {};
    for (let i = 0; i < nodeIds.length; i++) {
      const root = uf.find(i);
      componentSizes[root] = (componentSizes[root] || 0) + 1;
    }
    const sortedComponents = Object.values(componentSizes).sort((a, b) => b - a);

    // TOEGEVOEGD 19-9-2026 ("alles controleren en checken", stap 1 van 2): niet alleen de
    // top-10 als kaal getal, maar ALLE componenten BUITEN het grootste ("vasteland")
    // concreet oplijsten met hun knooppuntnummers/regio's -- dat is precies waarmee stap 2
    // (per gat beoordelen of er een echte, ontbrekende verbinding hoort te zijn) moet beginnen.
    const nodesByRoot = new Map<number, number[]>();
    for (let i = 0; i < nodeIds.length; i++) {
      const root = uf.find(i);
      const arr = nodesByRoot.get(root);
      if (arr) arr.push(i);
      else nodesByRoot.set(root, [i]);
    }
    const largestRootSize = Math.max(...Array.from(nodesByRoot.values()).map((arr) => arr.length));
    const allComponentsExceptLargest = Array.from(nodesByRoot.values())
      .filter((arr) => arr.length !== largestRootSize)
      .map((indices) => ({
        size: indices.length,
        nodes: indices.map((i) => ({ id: nodeIds[i], displayNumber: nodeInfo[i].displayNumber, displayRegio: nodeInfo[i].displayRegio })),
      }))
      .sort((a, b) => b.size - a.size);

    const isolatedCount = degree.filter((d) => d === 0).length;
    const deadEndCount = degree.filter((d) => d === 1).length;
    const wellConnectedCount = degree.filter((d) => d >= 2).length;

    // Composite-cluster diagnose: ongewoon grote samenvoegingen
    const largeClusters: { id: string; displayNumber: string; displayRegio: string; sourceNodeCount: number }[] = [];
    const clusterSizeHistogram: Record<string, number> = {};
    logicalNodesSnap.docs.forEach((doc) => {
      const d = doc.data();
      const mappingCount = (d.sourceNodeMappings || []).length;
      const bucket = mappingCount === 1 ? "1" : mappingCount <= 3 ? "2-3" : mappingCount <= 5 ? "4-5" : "6+";
      clusterSizeHistogram[bucket] = (clusterSizeHistogram[bucket] || 0) + 1;
      if (mappingCount >= largeClusterThreshold) {
        largeClusters.push({
          id: doc.id,
          displayNumber: d.displayNumber,
          displayRegio: d.displayRegio,
          sourceNodeCount: mappingCount,
        });
      }
    });
    largeClusters.sort((a, b) => b.sourceNodeCount - a.sourceNodeCount);

    return NextResponse.json({
      datasetVersionId,
      totalLogicalNodes: nodeIds.length,
      totalMatchedEdges: edgesSnap.size,
      edgesUsedInGraph: edgesUsed,
      edgesSkippedInvalidRef,
      connectivity: {
        connectedComponents: sortedComponents.length,
        largestComponentSize: sortedComponents[0] || 0,
        largestComponentPercent: sortedComponents[0]
          ? ((sortedComponents[0] / nodeIds.length) * 100).toFixed(1) + "%"
          : "0%",
        top10ComponentSizes: sortedComponents.slice(0, 10),
        isolatedNodes: isolatedCount,
        deadEndNodes: deadEndCount,
        wellConnectedNodes: wellConnectedCount,
      },
      allComponentsExceptLargest,
      compositeClusterDiagnostic: {
        sizeHistogram: clusterSizeHistogram,
        largeClusterThreshold,
        largeClusterCount: largeClusters.length,
        largeClusters: largeClusters.slice(0, 30),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Connectivity-validatie mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
