import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { COLLECTOR_REGIONS, regionRootBbox } from "@/lib/nwb-analysis/collector-regions";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/nwb-collector-goknoop-nodes?region=...&datasetVersionId=...
 *
 * TIJDELIJKE onderzoeksinfrastructuur (9-9-2026). Levert alleen de GoKnoop-
 * knopen binnen de regio-bbox -- klein, snel, geen NWB-data en geen zware
 * berekening. De daadwerkelijke component-analyse en nabijheidsberekening
 * gebeurt hierna CLIENT-SIDE (de browser heeft geen 10s-tijdslimiet, in
 * tegenstelling tot een serverless functie) -- zie nwb-collector-runner
 * page.tsx.
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
    const nodes: { x: number; y: number }[] = [];
    for (const id of allNodeIds) {
      const n = provider.getNode(id);
      if (!n) continue;
      if (n.x >= regionBbox.minX && n.x <= regionBbox.maxX && n.y >= regionBbox.minY && n.y <= regionBbox.maxY) {
        nodes.push({ x: n.x, y: n.y });
      }
    }

    return NextResponse.json({ region: regionKey, nodes, routingTestBeschikbaar: region.fromNodeId !== region.toNodeId });
  } catch (err) {
    return NextResponse.json(
      { error: "GoKnoop-knopen ophalen mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
