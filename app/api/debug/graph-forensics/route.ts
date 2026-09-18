import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getDb } from "@/lib/firebase-admin";
import { FieldPath } from "firebase-admin/firestore";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { loadPrecomputedOrBuildGraph } from "@/lib/route-engine/load-precomputed-graph";
import { loadCachedCombinedGraph } from "@/lib/route-engine/cached-nwb-provider";
import { computeConnectedComponents, type CombinedEdge, type CombinedGraph } from "@/lib/nwb-analysis/combined-graph";
import { computeCombinedRoute } from "@/lib/route-engine/combined-route-engine";
import type { NetworkBridge } from "@/lib/route-engine/network-bridge-types";

export const maxDuration = 60; // meerdere onafhankelijke graafopbouwen (modus 2) kunnen samen de 30s van de echte routeberekening overschrijden
export const dynamic = "force-dynamic";

/**
 * TOEGEVOEGD 18-9-2026 (GO van Te): puur forensisch/read-only diagnose-endpoint.
 *
 * MODUS 1 (standaard, geen `builds`-parameter): één graafopbouw, component-analyse
 * en directe edges voor een vast knooppuntpaar -- zoals eerder vandaag gebruikt.
 *
 * MODUS 2 (`?builds=N`, N>1): GO van Te voor een gerichte forensische vergelijking.
 * Voert N GEGARANDEERD onafhankelijke verse graafopbouwen uit (via de nieuwe,
 * standaard-uitgeschakelde `bypassCache`-optie op `loadCachedCombinedGraph` --
 * bestaat puur voor dit doel, de echte routeberekening geeft dit nooit mee en is
 * dus op geen enkele manier gewijzigd). Per opbouw: component-ID, componentgrootte,
 * een deterministische fingerprint (sha256) van de directe adjacency van from/to,
 * en het daadwerkelijke Dijkstra-resultaat (computeCombinedRoute) voor dit paar --
 * zodat opbouwen onderling exact vergeleken kunnen worden. GEEN wijziging aan de
 * routeberekening zelf; dit endpoint roept dezelfde functies aan die de productie-
 * route ook gebruikt, alleen met bypassCache aan.
 *
 * GET /api/debug/graph-forensics?from=<nodeId>&to=<nodeId>&key=<DEBUG_SECRET>[&builds=N]
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
  const buildsParam = req.nextUrl.searchParams.get("builds");
  const buildCount = buildsParam ? Math.max(1, Math.min(3, parseInt(buildsParam, 10) || 1)) : 1; // max 3: elke opbouw kost ~7-9s, veiligheidsmarge binnen maxDuration=60

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    // Bridges eenmalig apart opgehaald (onafhankelijk van welke graafopbouw dan ook) --
    // puur voor de "relevante bridges in de buurt"-weergave, niet voor de vergelijking zelf.
    const bridgesSnap = await db
      .collection("networkBridges")
      .where("datasetVersionId", "==", datasetVersionId)
      .where("validationStatus", "==", "valid")
      .orderBy(FieldPath.documentId())
      .get();
    const allBridges: NetworkBridge[] = bridgesSnap.docs.map((d) => d.data() as NetworkBridge);

    function fingerprintEdges(edges: readonly { to: string; distanceM: number; source: string }[]): string {
      const sorted = [...edges].sort((a, b) => (a.to === b.to ? (a.source === b.source ? a.distanceM - b.distanceM : a.source.localeCompare(b.source)) : a.to.localeCompare(b.to)));
      const payload = sorted.map((e) => `${e.to}|${e.source}|${e.distanceM}`).join(";");
      return createHash("sha256").update(payload).digest("hex").slice(0, 16); // ingekort -- alleen voor onderlinge vergelijking, geen cryptografisch doel
    }

    function analyzeGraph(graph: CombinedGraph) {
      const components = computeConnectedComponents(graph);
      const fromComponent = components.componentOfNode.get(fromNodeId) ?? null;
      const toComponent = components.componentOfNode.get(toNodeId) ?? null;
      const componentSize = (root: string | null) => {
        if (!root) return null;
        let count = 0;
        for (const r of components.componentOfNode.values()) if (r === root) count++;
        return count;
      };
      const fromEdges = graph.adjacency.get(fromNodeId) ?? [];
      const toEdges = graph.adjacency.get(toNodeId) ?? [];
      let totalEdgesInGraph = 0;
      for (const edges of graph.adjacency.values()) totalEdgesInGraph += edges.length;

      const dijkstraResult = computeCombinedRoute(graph, fromNodeId, toNodeId);

      const relevantBridges = allBridges
        .filter((b) => {
          const srcComp = components.componentOfNode.get(b.sourceNodeId);
          const tgtComp = components.componentOfNode.get(b.targetNodeId);
          return srcComp === fromComponent || srcComp === toComponent || tgtComp === fromComponent || tgtComp === toComponent;
        })
        .map((b) => {
          const sourceEdges = graph.adjacency.get(b.sourceNodeId) ?? [];
          const geselecteerdInGraaf = sourceEdges.some((e: CombinedEdge) => e.to === b.targetNodeId && e.source === "goknoop");
          return { id: b.id, sourceNodeId: b.sourceNodeId, targetNodeId: b.targetNodeId, geselecteerdInGraaf };
        });

      return {
        allPrecomputed: graph.allPrecomputed,
        clusterCount: graph.clusterCount,
        totalAdjacencyNodes: graph.adjacency.size,
        totalEdgesInGraph,
        fromComponent,
        toComponent,
        sameComponent: fromComponent !== null && fromComponent === toComponent,
        fromComponentSize: componentSize(fromComponent),
        toComponentSize: componentSize(toComponent),
        totalComponents: components.componentCount,
        fromEdgeCount: fromEdges.length,
        toEdgeCount: toEdges.length,
        fromAdjacencyFingerprint: fingerprintEdges(fromEdges),
        toAdjacencyFingerprint: fingerprintEdges(toEdges),
        fromDirectEdges: fromEdges.map((e) => ({ to: e.to, distanceM: e.distanceM, source: e.source })),
        toDirectEdges: toEdges.map((e) => ({ to: e.to, distanceM: e.distanceM, source: e.source })),
        relevantBridgesInGraaf: relevantBridges.filter((b) => b.geselecteerdInGraaf).length,
        relevantBridgesTotaal: relevantBridges.length,
        dijkstra: dijkstraResult,
      };
    }

    if (buildCount === 1) {
      // Modus 1: bestaande gedrag, via loadPrecomputedOrBuildGraph (kan het Optie-C-
      // artefact treffen als dat compleet is) -- ongewijzigd t.o.v. eerder vandaag.
      const provider = new CachedGraphProvider(datasetVersionId);
      const providerLoadPromise = provider.load();
      const graphLoadPromise = loadPrecomputedOrBuildGraph(provider, datasetVersionId, providerLoadPromise);
      await providerLoadPromise;
      const { graph, cacheHit, graphSource, bridgesPresent } = await graphLoadPromise;
      const analysis = analyzeGraph(graph);
      return NextResponse.json({
        datasetVersionId,
        fromNodeId,
        toNodeId,
        graphDiagnostics: { graphCacheHit: cacheHit, graphSource, bridgesPresent },
        ...analysis,
      });
    }

    // Modus 2: N onafhankelijke verse opbouwen, ALTIJD via het reconstructiepad
    // (loadCachedCombinedGraph rechtstreeks, bypassCache aan) -- dit is bewust het
    // pad dat vandaag zowel bij de succesvolle als de mislukte pogingen daadwerkelijk
    // gebruikt werd (graphSource: "reconstructed-combined"), dus het meest relevante
    // pad om hier te vergelijken.
    const builds = [];
    for (let i = 0; i < buildCount; i++) {
      const provider = new CachedGraphProvider(datasetVersionId);
      const providerLoadPromise = provider.load();
      await providerLoadPromise;
      const { graph } = await loadCachedCombinedGraph(provider, datasetVersionId, providerLoadPromise, { bypassCache: true });
      builds.push({ buildIndex: i + 1, graphSource: "reconstructed-combined" as const, ...analyzeGraph(graph) });
    }

    return NextResponse.json({ datasetVersionId, fromNodeId, toNodeId, buildCount, builds });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
