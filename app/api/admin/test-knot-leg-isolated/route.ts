import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { loadCachedCombinedGraph } from "@/lib/route-engine/cached-nwb-provider";
import { computeRouteBetweenCandidatesWithFallback } from "@/lib/route-engine/route-between-candidates";
import { reportProgress } from "@/lib/diagnostics/report-progress";
import type { LoopStartCandidate } from "@/lib/route-engine/loop-route-generator";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

// Zelfde bekende, echte kandidaten als de eerdere live-test.
const ORIGIN_CANDIDATES = ["CJSXBPUMG49vOPmYvhJd", "MQAnNb1IMego7dnVPXpS"];
const DESTINATION_CANDIDATES = ["ZYuO6ZfzSa2iim0HcUbn"];

/**
 * GET /api/admin/test-knot-leg-isolated
 *
 * Fase M6/M7-diagnose, 10-9-2026. Test UITSLUITEND graafopbouw + knot-leg
 * (geen last-mile, geen ORS) -- isoleert of de ~10s-vertraging hier zit.
 * Elke stap wordt apart getimed EN naar Firestore geschreven (niet-
 * afgewacht) -- console.log bleek onbetrouwbaar bij een harde
 * platform-timeout, zie report-progress.ts voor de volledige toelichting.
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const timings: Record<string, number> = {};
  const t0 = Date.now();
  function mark(label: string, extra?: Record<string, unknown>) {
    timings[label] = Date.now() - t0;
    reportProgress("latest", label, { elapsedMs: Date.now() - t0, ...extra });
  }
  reportProgress("latest", "test-knot-leg-isolated: START", { elapsedMs: 0 });

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    mark("activeDatasetLookup");
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd.", timings }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();
    mark("goknoopProviderLoad");

    const { graph, cacheHit: graphCacheHit } = await loadCachedCombinedGraph(provider, datasetVersionId);
    mark("combinedGraphLoad", { graphCacheHit });

    const graphStats = {
      totalConnectorsCreated: graph.totalConnectorsCreated,
      nodePositionSize: graph.nodePosition.size,
      adjacencySize: graph.adjacency.size,
      goknoopNodeCountInProvider: provider.getAllNodeIds().length,
    };

    const fromCandidates: LoopStartCandidate[] = ORIGIN_CANDIDATES.map((logicalNodeId) => ({ logicalNodeId }));
    const toCandidates: LoopStartCandidate[] = DESTINATION_CANDIDATES.map((logicalNodeId) => ({ logicalNodeId }));

    const knotResult = await computeRouteBetweenCandidatesWithFallback(provider, datasetVersionId, graph, fromCandidates, toCandidates);
    mark("knotLeg");

    if ("ok" in knotResult) {
      return NextResponse.json({ ok: false, reason: knotResult.reason, message: knotResult.message, timings, graphCacheHit, graphStats });
    }

    return NextResponse.json({
      ok: true,
      distanceM: knotResult.route.distanceM,
      edgeCount: knotResult.route.edges.length,
      timings,
      graphCacheHit,
      graphStats,
    });
  } catch (err) {
    reportProgress("latest", "EXCEPTION", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err), timings }, { status: 500 });
  }
}
