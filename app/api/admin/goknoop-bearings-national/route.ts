import { NextRequest, NextResponse } from "next/server";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/goknoop-bearings-national?datasetVersionId=...
 *
 * Fase G (connector-generatie), 9-9-2026. Landelijke variant van het
 * onderzoeks-eindpunt `nwb-collector-goknoop-bearings` (dat was bewust
 * regio-beperkt voor de onderzoeksfase). Productie heeft geen regio-concept
 * -- alle ~11.003 GoKnoop-knopen landelijk, met richtingsvector per edge
 * (nodig voor de parallel-check in connector-candidates.ts).
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
    const nodes: { id: string; x: number; y: number; edgeBearings: { x: number; y: number }[] }[] = [];

    for (const id of allNodeIds) {
      const n = provider.getNode(id);
      if (!n) continue;

      const edgeBearings: { x: number; y: number }[] = [];
      for (const edge of provider.getEdgesFrom(id)) {
        const isFromSide = edge.fromLogicalNodeId === id;
        const geometry = edge.geometry;
        if (!geometry || geometry.length < 2) continue;
        const p0 = isFromSide ? geometry[0] : geometry[geometry.length - 1];
        const p1 = isFromSide ? geometry[1] : geometry[geometry.length - 2];
        edgeBearings.push({ x: p1.x - p0.x, y: p1.y - p0.y });
      }

      nodes.push({ id, x: n.x, y: n.y, edgeBearings });
    }

    return NextResponse.json({ nodeCount: nodes.length, nodes });
  } catch (err) {
    return NextResponse.json(
      { error: "Landelijke GoKnoop-richtingen ophalen mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
