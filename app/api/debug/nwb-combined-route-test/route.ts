import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { buildCombinedGraph, dijkstraOnCombinedGraph, type SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * POST /api/debug/nwb-combined-route-test
 * Body: { datasetVersionId, from, to, nwbSegments: SlimNwbSegment[], toleranceM }
 *
 * TIJDELIJKE, puur lezende beslissende test (8-9-2026). GEEN productiecode
 * gewijzigd, GEEN database geschreven, GEEN Bridge Layer/rijrichting
 * aangeraakt, GEEN externe routers gebruikt. Bouwt een tijdelijke,
 * uitsluitend-in-memory gecombineerde graaf (GoKnoop + al-verzamelde NWB-
 * corridordata + connectors) en draait Dijkstra.
 *
 * HERZIEN 8-9-2026: EEN tolerantie per aanroep (was: een lus over 2/5/10m in
 * één aanroep) -- bij een graaf van deze schaal (~11.000 GoKnoop-knopen +
 * tienduizenden NWB-punten) bleek dat een echte Vercel-timeout te
 * veroorzaken, drie zware berekeningen die het 10s-budget moesten delen. De
 * client (nwb-combined-route-test-pagina) roept dit nu 3x apart aan.
 */
export async function POST(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: { datasetVersionId?: string; from?: string; to?: string; nwbSegments?: SlimNwbSegment[]; toleranceM?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { datasetVersionId, from, to, nwbSegments } = body;
  const toleranceM = body.toleranceM ?? 5;

  if (!datasetVersionId || !from || !to || !nwbSegments) {
    return NextResponse.json({ error: "datasetVersionId, from, to en nwbSegments zijn verplicht." }, { status: 400 });
  }

  try {
    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    const fromNode = provider.getNode(from);
    const toNode = provider.getNode(to);
    if (!fromNode || !toNode) {
      return NextResponse.json({ error: "from- of to-knooppunt niet gevonden." }, { status: 404 });
    }
    const straightLineDistanceM = Math.hypot(toNode.x - fromNode.x, toNode.y - fromNode.y);

    // Zoekgebied voor connectors: bounding box van alle meegegeven NWB-segmenten,
    // met een kleine marge -- geen reden om buiten dit gebied naar aansluitingen
    // te zoeken (daar is toch geen NWB-data verzameld).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of nwbSegments) {
      for (const c of [s.from, s.to]) {
        if (c.x < minX) minX = c.x;
        if (c.x > maxX) maxX = c.x;
        if (c.y < minY) minY = c.y;
        if (c.y > maxY) maxY = c.y;
      }
    }
    const connectorSearchBbox = { minX: minX - 50, minY: minY - 50, maxX: maxX + 50, maxY: maxY + 50 };

    const graph = buildCombinedGraph(provider, nwbSegments, toleranceM, connectorSearchBbox);
    const result = dijkstraOnCombinedGraph(graph, from, to);

    if (!result.found) {
      return NextResponse.json({
        from,
        to,
        toleranceM,
        straightLineDistanceM: Math.round(straightLineDistanceM),
        nwbSegmentenGebruikt: nwbSegments.length,
        routeFound: false,
      });
    }

    const deviationFactor = result.distanceM / straightLineDistanceM;

    const pathPositions = result.steps.map((s) => graph.nodePosition.get(s.nodeId)).filter((p): p is NonNullable<typeof p> => !!p);
    const netDisplacementM =
      pathPositions.length >= 2
        ? Math.hypot(
            pathPositions[pathPositions.length - 1].x - pathPositions[0].x,
            pathPositions[pathPositions.length - 1].y - pathPositions[0].y
          )
        : 0;
    const directionConsistencyRatio = result.distanceM > 0 ? netDisplacementM / result.distanceM : 0;

    const suspiciousConnectors = result.steps.filter((s) => s.edgeSource === "connector");

    const bstCodeBreakdown: Record<string, number> = {};
    for (const s of result.steps) {
      if (s.edgeSource === "nwb" && s.nwbInfo) {
        const code = s.nwbInfo.bstCode ?? "(leeg)";
        bstCodeBreakdown[code] = (bstCodeBreakdown[code] || 0) + 1;
      }
    }

    return NextResponse.json({
      from,
      to,
      toleranceM,
      straightLineDistanceM: Math.round(straightLineDistanceM),
      nwbSegmentenGebruikt: nwbSegments.length,
      huidigeGoKnoopOnlyAfstandM: 366859, // bekend, eerder gemeten -- ter vergelijking
      routeFound: true,
      distanceMeters: Math.round(result.distanceM),
      deviationFactor: deviationFactor.toFixed(2),
      goknoopEdgeCount: result.goknoopEdgeCount,
      nwbEdgeCount: result.nwbEdgeCount,
      connectorCount: result.connectorCount,
      totalHops: result.steps.length,
      sanityChecks: {
        directionConsistencyRatio: directionConsistencyRatio.toFixed(2),
        directionConsistencyOordeel:
          directionConsistencyRatio > 0.6 ? "plausibel (rechtlijnig)" : directionConsistencyRatio > 0.3 ? "matig, controleer handmatig" : "verdacht kronkelend/omweg",
        nwbBstCodeVerdelingInRoute: bstCodeBreakdown,
        aantalConnectorsGebruikt: suspiciousConnectors.length,
        connectorAfstanden: suspiciousConnectors.map((s) => ({ nodeId: s.nodeId, afstandTotaalOpDitPunt: Math.round(s.distanceM) })),
      },
      eersteStappen: result.steps.slice(0, 20).map((s) => ({ nodeId: s.nodeId, bron: s.edgeSource, cumulatieveAfstandM: Math.round(s.distanceM) })),
      laatsteStappen: result.steps.slice(-20).map((s) => ({ nodeId: s.nodeId, bron: s.edgeSource, cumulatieveAfstandM: Math.round(s.distanceM) })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Gecombineerde routetest mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
