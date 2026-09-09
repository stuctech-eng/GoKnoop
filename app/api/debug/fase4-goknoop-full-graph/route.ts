import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/fase4-goknoop-full-graph?datasetVersionId=...
 *
 * TIJDELIJKE onderzoeksinfrastructuur, Fase 4 (9-9-2026). Levert de
 * VOLLEDIGE, landelijke GoKnoop-graaf (alle ~11.003 nodes + edges) als
 * platte JSON, zonder geometrie (niet nodig voor topologie-only Dijkstra --
 * scheelt fors in payload-grootte). Nodig omdat de Fase 4-topologiemeting
 * client-side gebeurt (geen serverless-tijdslimiet), en de client dus de
 * volledige basis-graaf nodig heeft, niet alleen knopen in één regio-bbox
 * (in tegenstelling tot de eerdere nwb-collector-goknoop-*-eindpunten).
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId");
  if (!datasetVersionId) {
    return NextResponse.json({ error: "datasetVersionId-parameter verplicht." }, { status: 400 });
  }

  try {
    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    const allNodeIds = provider.getAllNodeIds();
    const nodes: { id: string; x: number; y: number; displayNumber: string | null }[] = [];
    const edgesSeen = new Set<string>();
    const edges: { id: string; from: string; to: string; distanceM: number }[] = [];

    for (const id of allNodeIds) {
      const n = provider.getNode(id);
      if (!n) continue;
      nodes.push({ id, x: n.x, y: n.y, displayNumber: n.displayNumber ?? null });
      for (const e of provider.getEdgesFrom(id)) {
        if (edgesSeen.has(e.id)) continue; // elke edge komt via beide knopen langs -- maar 1x meenemen
        edgesSeen.add(e.id);
        edges.push({ id: e.id, from: e.fromLogicalNodeId, to: e.toLogicalNodeId, distanceM: e.distanceM });
      }
    }

    return NextResponse.json({ datasetVersionId, nodeCount: nodes.length, edgeCount: edges.length, nodes, edges });
  } catch (err) {
    return NextResponse.json(
      { error: "Volledige GoKnoop-graaf ophalen mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
