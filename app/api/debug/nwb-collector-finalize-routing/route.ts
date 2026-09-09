import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { COLLECTOR_REGIONS } from "@/lib/nwb-analysis/collector-regions";
import { buildCombinedGraph, dijkstraOnCombinedGraph, type SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const TILES_COLLECTION = "nwbResearchTiles";

/**
 * GET /api/debug/nwb-collector-finalize-routing?region=...&datasetVersionId=...&toleranceM=10
 *
 * TIJDELIJKE onderzoeksinfrastructuur (9-9-2026). Het zware deel van het
 * oorspronkelijke finalize-eindpunt, nu apart: uitsluitend de
 * Dijkstra-routetest, en met ÉÉN tolerantie per aanroep (niet twee) om
 * binnen het 10s-budget te blijven bij grote regio's (Hilversum, tienduizenden
 * segmenten). Alleen zinvol voor regio's met een echt from/to-paar
 * (Hilversum) -- geeft een duidelijke melding voor connectiviteit-only
 * regio's (Lochem/Volendam).
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const regionKey = req.nextUrl.searchParams.get("region");
  const region = regionKey ? COLLECTOR_REGIONS[regionKey] : undefined;
  if (!region) {
    return NextResponse.json({ error: `region-parameter verplicht: ${Object.keys(COLLECTOR_REGIONS).join(", ")}` }, { status: 400 });
  }
  const datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId");
  if (!datasetVersionId) {
    return NextResponse.json({ error: "datasetVersionId-parameter verplicht." }, { status: 400 });
  }
  const toleranceM = Number(req.nextUrl.searchParams.get("toleranceM") ?? "10");

  if (region.fromNodeId === region.toNodeId) {
    return NextResponse.json({
      region: regionKey,
      routingTest: "niet van toepassing voor deze regio (connectiviteit-only, geen from/to-paar)",
    });
  }

  try {
    const db = getDb();
    const tilesRef = db.collection(TILES_COLLECTION);

    const [pendingSnap, completeSnap] = await Promise.all([
      tilesRef.where("region", "==", regionKey).where("status", "==", "pending").limit(1).get(),
      tilesRef.where("region", "==", regionKey).where("status", "==", "complete").get(),
    ]);
    if (!pendingSnap.empty) {
      return NextResponse.json({ error: "Verzameling voor deze regio is nog niet compleet." }, { status: 409 });
    }
    if (completeSnap.empty) {
      return NextResponse.json({ error: "Geen complete tegels gevonden voor deze regio." }, { status: 404 });
    }

    const segmentsById = new Map<string, SlimNwbSegment>();
    const chunkPromises = completeSnap.docs.map(async (tileDoc) => {
      const chunksSnap = await tileDoc.ref.collection("segments").get();
      for (const chunkDoc of chunksSnap.docs) {
        const chunkData = chunkDoc.data() as { segments: SlimNwbSegment[] };
        for (const seg of chunkData.segments) {
          segmentsById.set(seg.id, seg);
        }
      }
    });
    await Promise.all(chunkPromises);
    const allSegments = Array.from(segmentsById.values());

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    const fromNode = provider.getNode(region.fromNodeId);
    const toNode = provider.getNode(region.toNodeId);
    if (!fromNode || !toNode) {
      return NextResponse.json({ error: "from- of to-knooppunt niet gevonden." }, { status: 404 });
    }
    const straightLineDistanceM = Math.hypot(toNode.x - fromNode.x, toNode.y - fromNode.y);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of allSegments) {
      for (const c of [s.from, s.to]) {
        if (c.x < minX) minX = c.x;
        if (c.x > maxX) maxX = c.x;
        if (c.y < minY) minY = c.y;
        if (c.y > maxY) maxY = c.y;
      }
    }
    const connectorSearchBbox = { minX: minX - 50, minY: minY - 50, maxX: maxX + 50, maxY: maxY + 50 };

    const graph = buildCombinedGraph(provider, allSegments, toleranceM, connectorSearchBbox);
    const dijkstraResult = dijkstraOnCombinedGraph(graph, region.fromNodeId, region.toNodeId);

    return NextResponse.json({
      region: regionKey,
      toleranceM,
      straightLineDistanceM: Math.round(straightLineDistanceM),
      nwbSegmentenGebruikt: allSegments.length,
      totalConnectorsInGraph: graph.totalConnectorsCreated,
      routeFound: dijkstraResult.found,
      ...(dijkstraResult.found
        ? {
            distanceMeters: Math.round(dijkstraResult.distanceM),
            deviationFactor: (dijkstraResult.distanceM / straightLineDistanceM).toFixed(2),
            goknoopEdgeCount: dijkstraResult.goknoopEdgeCount,
            nwbEdgeCount: dijkstraResult.nwbEdgeCount,
            connectorCount: dijkstraResult.connectorCount,
          }
        : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Afronden (routetest) mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
