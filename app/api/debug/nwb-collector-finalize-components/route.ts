import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { COLLECTOR_REGIONS, regionRootBbox } from "@/lib/nwb-analysis/collector-regions";
import { classifySegment } from "@/lib/nwb-analysis/classify";
import { analyzeSlimNwbGraph } from "@/lib/nwb-analysis/graph-analysis";
import type { SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const TILES_COLLECTION = "nwbResearchTiles";

/**
 * GET /api/debug/nwb-collector-finalize-components?region=...&datasetVersionId=...
 *
 * TIJDELIJKE onderzoeksinfrastructuur (9-9-2026). HERZIEN: afgesplitst van
 * het oorspronkelijke finalize-eindpunt, dat bij grote regio's (Hilversum,
 * 103+ tegels) een 504 FUNCTION_INVOCATION_TIMEOUT gaf -- de combinatie van
 * alle tegels inlezen + component-analyse + de zware Dijkstra-routetest
 * paste niet meer in 10s. Dit eindpunt doet uitsluitend het lichte deel:
 * inlezen, classificeren, component-analyse, GoKnoop-nabijheid. De
 * (zware) routetest zit apart in nwb-collector-finalize-routing.
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
    const bstCodeDistribution: Record<string, number> = {};
    for (const s of allSegments) {
      const code = s.bstCode ?? "(leeg)";
      bstCodeDistribution[code] = (bstCodeDistribution[code] || 0) + 1;
    }

    const setASegments = allSegments.filter((s) => classifySegment(s.bstCode, s.wegnummer) === "setA");
    const setBSegments = allSegments.filter((s) => classifySegment(s.bstCode, s.wegnummer) !== "excluded");

    const componentAnalyse = {
      setA: Object.fromEntries([5, 10, 20].map((t) => [`${t}m`, analyzeSlimNwbGraph(setASegments, t)])),
      setB: Object.fromEntries([5, 10, 20].map((t) => [`${t}m`, analyzeSlimNwbGraph(setBSegments, t)])),
    };

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    const regionBbox = regionRootBbox(region);
    const allNodeIds = provider.getAllNodeIds();
    const goknoopNodesInRegion: { x: number; y: number }[] = [];
    for (const id of allNodeIds) {
      const n = provider.getNode(id);
      if (!n) continue;
      if (n.x >= regionBbox.minX && n.x <= regionBbox.maxX && n.y >= regionBbox.minY && n.y <= regionBbox.maxY) {
        goknoopNodesInRegion.push({ x: n.x, y: n.y });
      }
    }
    const nwbEndpoints = setBSegments.flatMap((s) => [s.from, s.to]);
    const proximity: Record<string, number> = {};
    for (const tol of [10, 20, 50]) {
      proximity[`${tol}m`] = goknoopNodesInRegion.filter((gn) => nwbEndpoints.some((p) => Math.hypot(p.x - gn.x, p.y - gn.y) <= tol)).length;
    }

    return NextResponse.json({
      region: regionKey,
      label: region.label,
      tegelsCompleet: completeSnap.size,
      uniekeSegmenten: allSegments.length,
      bstCodeVerdeling: bstCodeDistribution,
      setASegmentCount: setASegments.length,
      setBSegmentCount: setBSegments.length,
      componentAnalyse,
      goknoop: {
        knopenInRegio: goknoopNodesInRegion.length,
        proximityTotNwbSetB: proximity,
      },
      routingTestBeschikbaarVia: region.fromNodeId !== region.toNodeId ? "/api/debug/nwb-collector-finalize-routing" : null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Afronden (componenten) mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
