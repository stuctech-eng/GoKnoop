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

function parseNwbNodeId(nodeId: string): { segmentId: string; end: "from" | "to" } | null {
  if (!nodeId.startsWith("nwb:")) return null;
  const rest = nodeId.slice(4);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon === -1) return null;
  const end = rest.slice(lastColon + 1);
  if (end !== "from" && end !== "to") return null;
  return { segmentId: rest.slice(0, lastColon), end };
}

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

    // Unieke NWB-segment-ID's langs het pad verzamelen.
    const usedSegmentIds = new Set<string>();
    for (const step of result.steps) {
      const parsed = parseNwbNodeId(step.nodeId);
      if (parsed) usedSegmentIds.add(parsed.segmentId);
    }

    const geometryResult = await resolveNwbGeometry(Array.from(usedSegmentIds));

    // Sanity-check: som van de puntafstanden binnen elk opgehaald NWB-segment
    // (niet de volledige gestikte lijn inclusief GoKnoop -- dat vereist een
    // aparte geometrie-stiklaag die nog gebouwd moet worden; dit bevestigt
    // wel dat de opgehaalde NWB-geometrie zelf klopt met de lengte die het
    // kostenmodel er al die tijd voor gebruikte).
    let resolvedNwbLengthSumM = 0;
    for (const coords of geometryResult.resolved.values()) {
      for (let i = 1; i < coords.length; i++) {
        resolvedNwbLengthSumM += Math.hypot(coords[i].x - coords[i - 1].x, coords[i].y - coords[i - 1].y);
      }
    }

    return NextResponse.json({
      route: routeKey,
      berekendeRouteAfstandM: Math.round(result.distanceM),
      berekendeNwbAfstandM: Math.round(result.nwbDistanceM),
      aantalGebruikteNwbSegmenten: usedSegmentIds.size,
      geometrieOpgelost: geometryResult.resolved.size,
      geometrieMislukt: geometryResult.failed,
      somOpgehaaldeNwbGeometrieM: Math.round(resolvedNwbLengthSumM),
      verschilMetBerekendeNwbAfstandM: Math.round(resolvedNwbLengthSumM - result.nwbDistanceM),
      LET_OP: "Dit vergelijkt de opgehaalde NWB-geometrie-lengte met de al-berekende NWB-afstand (die zelf uit lengthM in SlimNwbSegment komt, apart vooraf berekend uit dezelfde brongeometrie) -- een klein verschil is normaal (afrondingen), een groot verschil zou duiden op een mismatch.",
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Volledige-route-geometrietest mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
