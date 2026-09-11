import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { loadCachedCombinedGraph } from "@/lib/route-engine/cached-nwb-provider";
import { computeCombinedRoute } from "@/lib/route-engine/combined-route-engine";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

// Directe knooppunt-paren (geen kandidaat-fallback) -- exact wat Fase 1 van de fallback-wrapper intern doet.
const ROUTES: Record<string, { from: string; to: string }> = {
  hilversum: { from: "CJSXBPUMG49vOPmYvhJd", to: "ZYuO6ZfzSa2iim0HcUbn" },
  "hilversum-alt": { from: "MQAnNb1IMego7dnVPXpS", to: "ZYuO6ZfzSa2iim0HcUbn" },
  volendam: { from: "7fmSWIHYsKu3Wb3yOtM2", to: "CJSXBPUMG49vOPmYvhJd" },
  lochem: { from: "0pgYw2kgDphP2IT1RAi7", to: "61aNR7RWLxQhHTOfMHtm" },
};

/**
 * GET /api/admin/diagnose-dijkstra-raw
 *
 * Fase 5-voorbereiding, 11-9-2026. `computeCombinedRoute` DIRECT aanroepen
 * (niet via `computeRouteWithFallback`, die alleen "wel/niet bruikbaar"
 * teruggeeft) -- onderscheidt EXPLICIET tussen:
 * - reason: "disconnected" -- Dijkstra vindt LETTERLIJK geen pad (echte
 *   structurele netwerkbreuk)
 * - reason: "quality_rejected" -- Dijkstra vindt WEL een pad, maar het wordt
 *   afgewezen door de kwaliteitscontrole (deviationFactor te hoog) --
 *   heeft een heel andere oorzaak/oplossing dan een echte breuk.
 *
 * Clustering (Fase 1+2) en GoKnoop-edges (Fase 4) zijn beide al BEWEZEN
 * correct -- dit test de laatste, nog niet uitgesloten mogelijkheid.
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

    const routeKey = req.nextUrl.searchParams.get("route") ?? "hilversum";
    const selected = ROUTES[routeKey] ?? ROUTES.hilversum;
    const result = computeCombinedRoute(graph, selected.from, selected.to);

    return NextResponse.json({ datasetVersionId, route: routeKey, resultaat: result });
  } catch (err) {
    return NextResponse.json(
      { error: "Diagnose mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
