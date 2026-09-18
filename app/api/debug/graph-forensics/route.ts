import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { FieldPath } from "firebase-admin/firestore";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { loadPrecomputedOrBuildGraph } from "@/lib/route-engine/load-precomputed-graph";
import { computeConnectedComponents, type CombinedEdge } from "@/lib/nwb-analysis/combined-graph";
import type { NetworkBridge } from "@/lib/route-engine/network-bridge-types";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * TOEGEVOEGD 18-9-2026 (GO van Te): puur forensisch/read-only diagnose-endpoint.
 * Doel: voor een VAST knooppuntpaar exact vastleggen hoe de graaf ze wel/niet
 * verbindt -- component-ID's, directe edges, en welke bridges/connectoren in de
 * buurt liggen -- ZONDER de routeberekening zelf op enige manier aan te raken
 * of te wijzigen. Laadt de graaf via exact dezelfde functie die /api/route/
 * to-destination gebruikt (loadPrecomputedOrBuildGraph), dus dit ziet precies
 * de graaf die een echte routeaanvraag ook zou zien.
 *
 * GET /api/debug/graph-forensics?from=<nodeId>&to=<nodeId>&key=<DEBUG_SECRET>
 * Standaard: Volendam knooppunt 95 (7fmSWIHYsKu3Wb3yOtM2) -> Amsterdam Centraal
 * (CJSXBPUMG49vOPmYvhJd) -- het vandaag herhaaldelijk geteste, ooit werkende paar.
 */
export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (key !== process.env.DEBUG_SECRET) {
    return NextResponse.json({ error: "Ongeldige of ontbrekende sleutel." }, { status: 401 });
  }

  const fromNodeId = req.nextUrl.searchParams.get("from") ?? "7fmSWIHYsKu3Wb3yOtM2"; // Volendam knooppunt 95
  const toNodeId = req.nextUrl.searchParams.get("to") ?? "CJSXBPUMG49vOPmYvhJd"; // Amsterdam Centraal

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const provider = new CachedGraphProvider(datasetVersionId);
    const providerLoadPromise = provider.load();
    const graphLoadPromise = loadPrecomputedOrBuildGraph(provider, datasetVersionId, providerLoadPromise);
    await providerLoadPromise;
    const { graph, cacheHit, graphSource, bridgesPresent } = await graphLoadPromise;

    // Component-analyse: zitten from/to in hetzelfde verbonden deel van de graaf?
    const components = computeConnectedComponents(graph);
    const fromComponent = components.componentOfNode.get(fromNodeId) ?? null;
    const toComponent = components.componentOfNode.get(toNodeId) ?? null;
    const componentSize = (root: string | null) => {
      if (!root) return null;
      let count = 0;
      for (const r of components.componentOfNode.values()) if (r === root) count++;
      return count;
    };

    const describeEdges = (nodeId: string) => {
      const edges = graph.adjacency.get(nodeId) ?? [];
      return edges.map((e) => ({
        to: e.to,
        distanceM: e.distanceM,
        source: e.source,
        nwbInfo: e.nwbInfo,
        toComponent: components.componentOfNode.get(e.to) ?? null,
      }));
    };

    // Bridges apart, onafhankelijk opnieuw opgehaald (bewust NIET via de productie-
    // functie, om zeker te zijn dat dit endpoint puur lezend is en niets deelt met
    // de al-lopende graafopbouw) -- exact dezelfde query als cached-nwb-provider.ts.
    const bridgesSnap = await db
      .collection("networkBridges")
      .where("datasetVersionId", "==", datasetVersionId)
      .where("validationStatus", "==", "valid")
      .orderBy(FieldPath.documentId())
      .get();
    const allBridges: NetworkBridge[] = bridgesSnap.docs.map((d) => d.data() as NetworkBridge);

    // Welke bridges raken de from- of to-component (op basis van de HUIDIGE
    // graaf, dus na de top-N-per-node-selectie -- zie ook "geselecteerdInGraaf").
    const relevantBridges = allBridges
      .filter((b) => {
        const srcComp = components.componentOfNode.get(b.sourceNodeId);
        const tgtComp = components.componentOfNode.get(b.targetNodeId);
        return srcComp === fromComponent || srcComp === toComponent || tgtComp === fromComponent || tgtComp === toComponent;
      })
      .map((b) => {
        const sourceEdges = graph.adjacency.get(b.sourceNodeId) ?? [];
        const geselecteerdInGraaf = sourceEdges.some((e: CombinedEdge) => e.to === b.targetNodeId && e.source === "goknoop");
        return {
          id: b.id,
          sourceNodeId: b.sourceNodeId,
          targetNodeId: b.targetNodeId,
          distanceM: b.distanceM,
          circuityRatio: b.circuityRatio,
          sourceComponent: components.componentOfNode.get(b.sourceNodeId) ?? null,
          targetComponent: components.componentOfNode.get(b.targetNodeId) ?? null,
          geselecteerdInGraaf, // true = deze bridge-edge zit daadwerkelijk in de graaf die zojuist gebouwd is
        };
      });

    return NextResponse.json({
      datasetVersionId,
      graphDiagnostics: { graphCacheHit: cacheHit, graphSource, allPrecomputed: graph.allPrecomputed, clusterCount: graph.clusterCount, bridgesPresent },
      fromNodeId,
      toNodeId,
      fromComponent,
      toComponent,
      sameComponent: fromComponent !== null && fromComponent === toComponent,
      fromComponentSize: componentSize(fromComponent),
      toComponentSize: componentSize(toComponent),
      totalComponents: components.componentCount,
      fromDirectEdges: describeEdges(fromNodeId),
      toDirectEdges: describeEdges(toNodeId),
      aantalRelevanteBridgesGevonden: relevantBridges.length,
      relevantBridges,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
