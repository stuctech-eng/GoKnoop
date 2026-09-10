import { NextRequest, NextResponse } from "next/server";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { loadCachedCombinedGraph } from "@/lib/route-engine/cached-nwb-provider";
import { dijkstraWithCostModel, makeCostFn } from "@/lib/nwb-analysis/combined-graph";
import { F_NWB_PRODUCTION, F_CONNECTOR_PRODUCTION } from "@/lib/route-engine/combined-route-engine";
import { resolveNwbGeometry } from "@/lib/nwb-analysis/nwb-geometry-resolver";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

// Bekende testroutes.
const TEST_ROUTES: Record<string, { from: string; to: string }> = {
  hilversum: { from: "CJSXBPUMG49vOPmYvhJd", to: "ZYuO6ZfzSa2iim0HcUbn" },
  volendam: { from: "7fmSWIHYsKu3Wb3yOtM2", to: "CJSXBPUMG49vOPmYvhJd" },
  lochem: { from: "0pgYw2kgDphP2IT1RAi7", to: "61aNR7RWLxQhHTOfMHtm" },
};


/**
 * GET /api/admin/test-full-route-geometry?route=hilversum|volendam|lochem&datasetVersionId=...
 *
 * Fase M, punt 5-6, 10-9-2026. Berekent een echte route, haalt de volledige
 * geometrie op voor alle gebruikte NWB-segmenten, en controleert of de
 * opgehaalde geometrie qua lengte overeenkomt met de berekende routeafstand.
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const routeKey = req.nextUrl.searchParams.get("route") ?? "hilversum";
  const testRoute = TEST_ROUTES[routeKey];
  if (!testRoute) {
    return NextResponse.json({ error: `Onbekende route '${routeKey}'. Kies uit: ${Object.keys(TEST_ROUTES).join(", ")}.` }, { status: 400 });
  }

  const datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId") ?? "uINZ3y2QsgBdEyky3duq";

  try {
    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    const { graph } = await loadCachedCombinedGraph(provider, datasetVersionId);
    const result = dijkstraWithCostModel(graph, testRoute.from, testRoute.to, makeCostFn(F_NWB_PRODUCTION, F_CONNECTOR_PRODUCTION));

    if (!result.found) {
      return NextResponse.json({ error: "Route niet gevonden." }, { status: 404 });
    }

    // Betrouwbare segment-ID's rechtstreeks uit elke stap (Geometry Integration
    // Audit-fix, 10-9-2026) -- niet langer uit het cluster-knoop-ID geraden.
    const usedSegmentIds = new Set<string>();
    const segmentIdPerTraversal: string[] = []; // behoudt duplicaten, voor de per-doorkruising-som
    for (const step of result.steps) {
      if (step.edgeSource === "nwb" && step.nwbSegmentId) {
        usedSegmentIds.add(step.nwbSegmentId);
        segmentIdPerTraversal.push(step.nwbSegmentId);
      }
    }

    const geometryResult = await resolveNwbGeometry(Array.from(usedSegmentIds));

    // Twee sommen: uniek (oude methode, kan te laag uitvallen bij hergebruikte
    // segmenten) en per-doorkruising (nieuw, telt een dubbel gebruikt segment ook dubbel).
    function segmentLengthM(coords: { x: number; y: number }[]): number {
      let len = 0;
      for (let i = 1; i < coords.length; i++) len += Math.hypot(coords[i].x - coords[i - 1].x, coords[i].y - coords[i - 1].y);
      return len;
    }
    let resolvedNwbLengthSumM = 0;
    for (const coords of geometryResult.resolved.values()) resolvedNwbLengthSumM += segmentLengthM(coords);

    let perTraversalSumM = 0;
    for (const segId of segmentIdPerTraversal) {
      const coords = geometryResult.resolved.get(segId);
      if (coords) perTraversalSumM += segmentLengthM(coords);
    }

    return NextResponse.json({
      route: routeKey,
      berekendeRouteAfstandM: Math.round(result.distanceM),
      berekendeNwbAfstandM: Math.round(result.nwbDistanceM),
      aantalNwbDoorkruisingen: segmentIdPerTraversal.length,
      aantalUniekeNwbSegmenten: usedSegmentIds.size,
      geometrieOpgelost: geometryResult.resolved.size,
      geometrieMislukt: geometryResult.failed,
      somUniekeNwbGeometrieM: Math.round(resolvedNwbLengthSumM),
      somPerDoorkruisingM: Math.round(perTraversalSumM),
      verschilUniekM: Math.round(resolvedNwbLengthSumM - result.nwbDistanceM),
      verschilPerDoorkruisingM: Math.round(perTraversalSumM - result.nwbDistanceM),
      LET_OP: "verschilPerDoorkruisingM zou nu vrijwel 0 moeten zijn (kleine afronding) als de eerdere -1426m-afwijking inderdaad kwam door segmenten die het pad meer dan één keer doorkruist. Een resterend groot verschil zou op een andere oorzaak wijzen.",
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Volledige-route-geometrietest mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
