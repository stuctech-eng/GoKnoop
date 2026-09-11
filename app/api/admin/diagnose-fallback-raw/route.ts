import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { loadCachedCombinedGraph } from "@/lib/route-engine/cached-nwb-provider";
import { computeCombinedRoute } from "@/lib/route-engine/combined-route-engine";

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

    // Kandidaat 2 apart, direct testen (nooit eerder gedaan -- alleen kandidaat 1 is bewezen).
    const candidate2Direct = computeCombinedRoute(graph, ORIGIN_CANDIDATES[1], DESTINATION);

    // ALLEEN Fase 1 van computeRouteWithFallback repliceren (de goedkope lus) --
    // NIET de volledige functie aanroepen, die roept ook Fase 2 aan (dure PDOK-
    // geometrie-opbouw voor de winnaar), wat de vorige poging deed timeouten.
    let bestIndex = -1;
    let bestDistanceM = Infinity;
    const perCandidateResults: unknown[] = [];
    for (let i = 0; i < ORIGIN_CANDIDATES.length; i++) {
      const nodeExists = !!provider.getNode(ORIGIN_CANDIDATES[i]);
      const cheapResult = nodeExists ? computeCombinedRoute(graph, ORIGIN_CANDIDATES[i], DESTINATION) : null;
      perCandidateResults.push({ candidateId: ORIGIN_CANDIDATES[i], nodeExists, cheapResult });
      if (cheapResult?.ok && cheapResult.distanceM < bestDistanceM) {
        bestDistanceM = cheapResult.distanceM;
        bestIndex = i;
      }
    }

    return NextResponse.json({
      datasetVersionId,
      candidate2DirectResult: candidate2Direct,
      fase1LusResultaat: { bestIndex, bestDistanceM: bestIndex === -1 ? null : bestDistanceM, perCandidateResults },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Diagnose mislukt.", details: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
      { status: 502 }
    );
  }
}
