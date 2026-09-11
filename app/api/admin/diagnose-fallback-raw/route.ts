import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { loadCachedCombinedGraph } from "@/lib/route-engine/cached-nwb-provider";
import { computeCombinedRoute, computeCombinedRouteAsRoute } from "@/lib/route-engine/combined-route-engine";
import { reportProgress } from "@/lib/diagnostics/report-progress";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const ORIGIN_CANDIDATES = ["CJSXBPUMG49vOPmYvhJd", "MQAnNb1IMego7dnVPXpS"];
const DESTINATION = "ZYuO6ZfzSa2iim0HcUbn";

/**
 * GET /api/admin/diagnose-fallback-raw
 *
 * Fase 5-voorbereiding (vervolg), 11-9-2026. `computeCombinedRoute`
 * DIRECT bewees dat Dijkstra/graaf/clustering correct werken (distanceM
 * 29978, geaccepteerd) -- met ÉÉN vaste kandidaat. Dit test nu specifiek
 * `computeRouteWithFallback` (de kandidaat-fallback-laag) met de EXACTE
 * twee originele kandidaten, om te isoleren of de bug in DIE lus zit --
 * ook wordt kandidaat 2 apart, direct getest (nooit eerder gedaan).
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();
    const { graph } = await loadCachedCombinedGraph(provider, datasetVersionId);

    // Volledige Fase 1+2-keten repliceren (identiek aan computeRouteWithFallback), MET
    // reportProgress op elke stap -- geeft zichtbaarheid ongeacht of dit timet of niet.
    reportProgress("latest", "diagnose-fallback: Fase 1 start");
    let bestIndex = -1;
    let bestDistanceM = Infinity;
    for (let i = 0; i < ORIGIN_CANDIDATES.length; i++) {
      const nodeExists = !!provider.getNode(ORIGIN_CANDIDATES[i]);
      const cheapResult = nodeExists ? computeCombinedRoute(graph, ORIGIN_CANDIDATES[i], DESTINATION) : null;
      reportProgress("latest", `diagnose-fallback: kandidaat ${i} klaar`, { nodeExists, ok: cheapResult?.ok, distanceM: cheapResult?.ok ? cheapResult.distanceM : null });
      if (cheapResult?.ok && cheapResult.distanceM < bestDistanceM) {
        bestDistanceM = cheapResult.distanceM;
        bestIndex = i;
      }
    }
    reportProgress("latest", "diagnose-fallback: Fase 1 klaar", { bestIndex, bestDistanceM: bestIndex === -1 ? null : bestDistanceM });

    if (bestIndex === -1) {
      return NextResponse.json({ datasetVersionId, result: "fase1_geen_winnaar", bestIndex });
    }

    reportProgress("latest", "diagnose-fallback: Fase 2 start (dure geometrie-opbouw)");
    const winner = ORIGIN_CANDIDATES[bestIndex];
    const fullResult = await computeCombinedRouteAsRoute(graph, provider, datasetVersionId, winner, DESTINATION);
    reportProgress("latest", "diagnose-fallback: Fase 2 klaar", { ok: fullResult.ok });

    return NextResponse.json({
      datasetVersionId,
      result: fullResult.ok ? "succes" : "fase2_gefaald",
      bestIndex,
      bestDistanceM,
      fase2Detail: fullResult.ok ? { distanceM: fullResult.route.distanceM } : { reason: fullResult.reason, message: fullResult.message },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Diagnose mislukt.", details: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
      { status: 502 }
    );
  }
}
