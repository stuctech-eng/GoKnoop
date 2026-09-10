import { NextRequest, NextResponse } from "next/server";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { loadCachedCombinedGraph } from "@/lib/route-engine/cached-nwb-provider";
import { dijkstraWithCostModel, makeCostFn } from "@/lib/nwb-analysis/combined-graph";
import { F_NWB_PRODUCTION, F_CONNECTOR_PRODUCTION } from "@/lib/route-engine/combined-route-engine";
import { buildCombinedRouteGeometry } from "@/lib/route-engine/combined-route-geometry";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const TEST_ROUTES: Record<string, { from: string; to: string }> = {
  hilversum: { from: "CJSXBPUMG49vOPmYvhJd", to: "ZYuO6ZfzSa2iim0HcUbn" },
  volendam: { from: "7fmSWIHYsKu3Wb3yOtM2", to: "CJSXBPUMG49vOPmYvhJd" },
  lochem: { from: "0pgYw2kgDphP2IT1RAi7", to: "61aNR7RWLxQhHTOfMHtm" },
};

/**
 * GET /api/admin/test-combined-route-geometry-e2e?route=hilversum
 *
 * Fase M4, 10-9-2026. End-to-end: berekent een echte route, bouwt de
 * VOLLEDIGE geometrie op via buildCombinedRouteGeometry (niet alleen
 * losse segmenten zoals de eerdere test), en controleert consistentie:
 * som van edge-afstanden vs. route.distanceM, aantal geometriepunten,
 * eerste/laatste punt van de volledige lijn.
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
    return NextResponse.json({ error: `Onbekende route '${routeKey}'.` }, { status: 400 });
  }
  const datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId") ?? "uINZ3y2QsgBdEyky3duq";

  try {
    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();
    const { graph } = await loadCachedCombinedGraph(provider, datasetVersionId);
    const dijkstraResult = dijkstraWithCostModel(graph, testRoute.from, testRoute.to, makeCostFn(F_NWB_PRODUCTION, F_CONNECTOR_PRODUCTION));

    if (!dijkstraResult.found) {
      return NextResponse.json({ error: "Route niet gevonden." }, { status: 404 });
    }

    const t0 = Date.now();
    const geometryResult = await buildCombinedRouteGeometry(dijkstraResult.steps, graph, provider);
    const geometryBuildTimeMs = Date.now() - t0;

    if (!geometryResult.ok) {
      return NextResponse.json({ error: "Geometrie-opbouw mislukt.", reason: geometryResult.reason }, { status: 502 });
    }

    const edgeDistanceSum = geometryResult.edges.reduce((sum, e) => sum + e.distanceM, 0);

    return NextResponse.json({
      route: routeKey,
      berekendeRouteAfstandM: Math.round(dijkstraResult.distanceM),
      somVanEdgeAfstandenM: Math.round(edgeDistanceSum),
      verschilM: Math.round(edgeDistanceSum - dijkstraResult.distanceM),
      aantalEdges: geometryResult.edges.length,
      aantalGeometriePunten: geometryResult.geometry.length,
      eerstePunt: geometryResult.geometry[0],
      laatstePunt: geometryResult.geometry[geometryResult.geometry.length - 1],
      onopgelosteNwbSegmenten: geometryResult.unresolvedNwbSegments,
      geometryBuildTimeMs,
      edgeSourceVerdeling: {
        goknoop: geometryResult.edges.filter((e) => e.id.startsWith("nwb-edge") === false && e.id.startsWith("connector-edge") === false).length,
        nwb: geometryResult.edges.filter((e) => e.id.startsWith("nwb-edge")).length,
        connector: geometryResult.edges.filter((e) => e.id.startsWith("connector-edge")).length,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "End-to-end-geometrietest mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
