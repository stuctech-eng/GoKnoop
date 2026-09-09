import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { COLLECTOR_REGIONS } from "@/lib/nwb-analysis/collector-regions";
import { classifySegment } from "@/lib/nwb-analysis/classify";
import { buildCombinedGraph, dijkstraOnCombinedGraph, type SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const TILES_COLLECTION = "nwbResearchTiles";

/**
 * GET /api/debug/nwb-collector-finalize?region=...&datasetVersionId=...
 *
 * TIJDELIJKE onderzoeksinfrastructuur (8-9-2026). Leest alle COMPLETE
 * tegels van een regio, dedupliceert segmenten op ID, en draait de
 * definitieve analyse: connected components (per BST_CODE-classificatie
 * impliciet via combined-graph) + Dijkstra-routetest (alleen zinvol als
 * from != to -- voor Lochem/Volendam is dat nu een placeholder, dus dan
 * wordt alleen connectiviteit gerapporteerd).
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

  try {
    const db = getDb();
    const tilesRef = db.collection(TILES_COLLECTION);

    const [pendingSnap, completeSnap] = await Promise.all([
      tilesRef.where("region", "==", regionKey).where("status", "==", "pending").limit(1).get(),
      tilesRef.where("region", "==", regionKey).where("status", "==", "complete").get(),
    ]);

    if (!pendingSnap.empty) {
      return NextResponse.json(
        { error: "Verzameling voor deze regio is nog niet compleet -- er staan nog wachtende tegels." },
        { status: 409 }
      );
    }
    if (completeSnap.empty) {
      return NextResponse.json({ error: "Geen complete tegels gevonden voor deze regio -- nog niets verzameld." }, { status: 404 });
    }

    // Alle segment-chunks van alle complete tegels parallel ophalen.
    const segmentsById = new Map<string, SlimNwbSegment>();
    const chunkPromises = completeSnap.docs.map(async (tileDoc) => {
      const chunksSnap = await tileDoc.ref.collection("segments").get();
      for (const chunkDoc of chunksSnap.docs) {
        const chunkData = chunkDoc.data() as { segments: SlimNwbSegment[] };
        for (const seg of chunkData.segments) {
          segmentsById.set(seg.id, seg); // dedupliceren -- overlappende tegel-randen tellen niet dubbel
        }
      }
    });
    await Promise.all(chunkPromises);

    const allSegments = Array.from(segmentsById.values());
    const bstCodeDistribution: Record<string, number> = {};
    for (const s of allSegments) {
      const code = s.bstCode ?? "(leeg)";
      bstCodeDistribution[code] = (bstCodeDistribution[code] || 0) + 1;
    }

    const setACount = allSegments.filter((s) => classifySegment(s.bstCode, s.wegnummer) === "setA").length;
    const setBCount = allSegments.filter((s) => classifySegment(s.bstCode, s.wegnummer) !== "excluded").length;

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    const doRoutingTest = region.fromNodeId !== region.toNodeId;
    let routingResult: Record<string, unknown> | null = null;

    if (doRoutingTest) {
      const fromNode = provider.getNode(region.fromNodeId);
      const toNode = provider.getNode(region.toNodeId);
      if (fromNode && toNode) {
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

        const resultsPerTolerance: Record<string, unknown> = {};
        for (const tol of [5, 10]) {
          const graph = buildCombinedGraph(provider, allSegments, tol, connectorSearchBbox);
          const dijkstraResult = dijkstraOnCombinedGraph(graph, region.fromNodeId, region.toNodeId);
          resultsPerTolerance[`${tol}m`] = dijkstraResult.found
            ? {
                routeFound: true,
                distanceMeters: Math.round(dijkstraResult.distanceM),
                deviationFactor: (dijkstraResult.distanceM / straightLineDistanceM).toFixed(2),
                goknoopEdgeCount: dijkstraResult.goknoopEdgeCount,
                nwbEdgeCount: dijkstraResult.nwbEdgeCount,
                connectorCount: dijkstraResult.connectorCount,
                totalConnectorsInGraph: graph.totalConnectorsCreated,
              }
            : { routeFound: false, totalConnectorsInGraph: graph.totalConnectorsCreated };
        }
        routingResult = { straightLineDistanceM: Math.round(straightLineDistanceM), resultatenPerTolerantie: resultsPerTolerance };
      }
    }

    return NextResponse.json({
      region: regionKey,
      label: region.label,
      tegelsCompleet: completeSnap.size,
      uniekeSegmenten: allSegments.length,
      bstCodeVerdeling: bstCodeDistribution,
      setASegmentCount: setACount,
      setBSegmentCount: setBCount,
      routingTest: doRoutingTest ? routingResult : "niet van toepassing voor deze regio (connectiviteit-only)",
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Afronden mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
