import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { COLLECTOR_REGIONS, regionRootBbox } from "@/lib/nwb-analysis/collector-regions";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/nwb-collector-goknoop-bearings?region=...&datasetVersionId=...
 *
 * TIJDELIJKE onderzoeksinfrastructuur, Fase 3 (9-9-2026). Levert GoKnoop-
 * knopen binnen de regio-bbox MET lokale richtingsvector per edge (nodig
 * voor de parallel-infrastructuur-check in connector-candidates.ts) --
 * apart van het bestaande nwb-collector-goknoop-nodes-eindpunt, om dat
 * al-werkende eindpunt niet aan te raken (modulair, Fase 3-regel).
 *
 * Belangrijk: FirestoreGraphProvider/CachedGraphProvider indexeren elke edge
 * onder BEIDE knooppunten (bidirectioneel) -- de "uitgaande" richting vanaf
 * een specifieke node wordt hier daarom expliciet bepaald a.h.v. of de node
 * overeenkomt met fromLogicalNodeId of toLogicalNodeId van de edge (zelfde
 * les als eerder vandaag bij combined-graph.ts -- niet blind een kant aannemen).
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
    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    const regionBbox = regionRootBbox(region);
    const allNodeIds = provider.getAllNodeIds();
    const nodes: { id: string; x: number; y: number; edgeBearings: { x: number; y: number }[] }[] = [];

    for (const id of allNodeIds) {
      const n = provider.getNode(id);
      if (!n) continue;
      if (!(n.x >= regionBbox.minX && n.x <= regionBbox.maxX && n.y >= regionBbox.minY && n.y <= regionBbox.maxY)) continue;

      const edgeBearings: { x: number; y: number }[] = [];
      for (const edge of provider.getEdgesFrom(id)) {
        // Bepaal de uitgaande kant t.o.v. DEZE node (niet blind edge.toLogicalNodeId aannemen -- zie docstring).
        const isFromSide = edge.fromLogicalNodeId === id;
        const geometry = edge.geometry;
        if (!geometry || geometry.length < 2) continue;
        // Eerste twee punten vanaf de kant waar deze node zich bevindt, voor een lokale (geen edge-brede) richting.
        const p0 = isFromSide ? geometry[0] : geometry[geometry.length - 1];
        const p1 = isFromSide ? geometry[1] : geometry[geometry.length - 2];
        edgeBearings.push({ x: p1.x - p0.x, y: p1.y - p0.y });
      }

      nodes.push({ id, x: n.x, y: n.y, edgeBearings });
    }

    return NextResponse.json({ region: regionKey, nodes });
  } catch (err) {
    return NextResponse.json(
      { error: "GoKnoop-richtingen ophalen mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
