import { NextRequest, NextResponse } from "next/server";
import { FirestoreGraphProvider } from "@/lib/route-engine/firestore-graph-provider";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { PrecomputedGraphProvider } from "@/lib/route-engine/precomputed-graph-provider";
import { computeRoute } from "@/lib/route-engine/route-engine";
import type { GraphProvider } from "@/lib/route-engine/types";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Eerlijke benchmark van de drie graph-loadingstrategieën uit ontwerp sectie 4,
 * zodat de keuze op meetgegevens berust, niet op aanname (GPT-review 26-8-2026).
 * Test tegelijk als regressietest voor correctheid (route/geen-route/constraints).
 *
 * mode=A  Firestore direct (huidige situatie, geen cache)
 * mode=B  In-memory cache op module-niveau
 * mode=C  Vooraf berekende, gechunkte adjacency-structuur
 */

export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const mode = (req.nextUrl.searchParams.get("mode") || "A") as "A" | "B" | "C";
  const datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId");
  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");
  const avoidNodeIds = req.nextUrl.searchParams.get("avoidNodeIds")?.split(",").filter(Boolean);
  const avoidEdgeIds = req.nextUrl.searchParams.get("avoidEdgeIds")?.split(",").filter(Boolean);

  if (!datasetVersionId || !from || !to) {
    return NextResponse.json({ error: "datasetVersionId, from en to zijn verplicht." }, { status: 400 });
  }

  try {
    const memBefore = process.memoryUsage().heapUsed;
    const tStart = Date.now();

    let provider: GraphProvider;
    let cachedProviderRef: CachedGraphProvider | null = null;

    if (mode === "A") {
      provider = new FirestoreGraphProvider(datasetVersionId);
    } else if (mode === "B") {
      cachedProviderRef = new CachedGraphProvider(datasetVersionId);
      provider = cachedProviderRef;
    } else {
      provider = new PrecomputedGraphProvider(datasetVersionId);
    }

    const tLoadStart = Date.now();
    await provider.load();
    const loadTimeMs = Date.now() - tLoadStart;
    const cacheHit = cachedProviderRef ? cachedProviderRef.wasCacheHit : null;

    const memAfterLoad = process.memoryUsage().heapUsed;

    const tDijkstra = Date.now();
    const result = computeRoute(provider, datasetVersionId, from, to, { avoidNodeIds, avoidEdgeIds });
    const dijkstraWallTimeMs = Date.now() - tDijkstra;

    const totalTimeMs = Date.now() - tStart;

    return NextResponse.json({
      mode,
      cacheHit, // alleen relevant bij mode=B; null bij A/C
      metrics: {
        loadTimeMs,
        dijkstraWallTimeMs, // inclusief route-reconstructie, zie ook metadata.computeTimeMs voor alleen Dijkstra
        totalTimeMs,
        heapUsedBeforeMB: (memBefore / 1024 / 1024).toFixed(1),
        heapUsedAfterLoadMB: (memAfterLoad / 1024 / 1024).toFixed(1),
        heapDeltaMB: ((memAfterLoad - memBefore) / 1024 / 1024).toFixed(1),
      },
      totalNodesLoaded: provider.getAllNodeIds().length,
      result:
        "reason" in result
          ? { ok: false, reason: result.reason, message: result.message }
          : {
              ok: true,
              distanceM: result.distanceM,
              nodeCount: result.nodes.length,
              edgeCount: result.edges.length,
              dijkstraComputeTimeMs: result.metadata.computeTimeMs,
            },
    });
  } catch (err) {
    return NextResponse.json(
      { mode, error: "Benchmark mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
