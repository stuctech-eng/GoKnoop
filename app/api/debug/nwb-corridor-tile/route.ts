import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { fetchAllNwbSegmentsInBbox } from "@/lib/nwb-analysis/nwb-client";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/nwb-corridor-tile?datasetVersionId=...&from=...&to=...&tileIndex=0&totalTiles=6&radiusM=3000
 *
 * TIJDELIJK, puur lezend (8-9-2026), onderdeel van de beslissende
 * gecombineerde-routingtest. Levert ÉÉN tegel van de corridor tussen `from`
 * en `to` (RD-lijn geïnterpoleerd, tegels gelijkmatig verdeeld) -- elke tegel
 * is klein genoeg om gegarandeerd compleet te zijn (geen afkapping). De
 * client haalt alle tegels op en voegt ze zelf samen (zie
 * nwb-corridor-collector-pagina), vóór de daadwerkelijke routetest
 * (/api/debug/nwb-combined-route-test).
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
  const fromNodeId = req.nextUrl.searchParams.get("from");
  const toNodeId = req.nextUrl.searchParams.get("to");
  const tileIndex = Number(req.nextUrl.searchParams.get("tileIndex") ?? "0");
  const totalTiles = Number(req.nextUrl.searchParams.get("totalTiles") ?? "6");
  const radiusM = Number(req.nextUrl.searchParams.get("radiusM") ?? "3000");

  if (!datasetVersionId || !fromNodeId || !toNodeId) {
    return NextResponse.json({ error: "datasetVersionId, from en to zijn verplicht." }, { status: 400 });
  }

  try {
    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();
    const fromNode = provider.getNode(fromNodeId);
    const toNode = provider.getNode(toNodeId);
    if (!fromNode || !toNode) {
      return NextResponse.json({ error: "from- of to-knooppunt niet gevonden." }, { status: 404 });
    }

    // Tegelcentrum: gelijkmatig geïnterpoleerd langs de rechte lijn from->to.
    const t = totalTiles <= 1 ? 0 : tileIndex / (totalTiles - 1);
    const centerX = fromNode.x + t * (toNode.x - fromNode.x);
    const centerY = fromNode.y + t * (toNode.y - fromNode.y);
    const bbox = { minX: centerX - radiusM, maxX: centerX + radiusM, minY: centerY - radiusM, maxY: centerY + radiusM };

    const { segments, pagesRetrieved, truncated } = await fetchAllNwbSegmentsInBbox(bbox, 4);

    return NextResponse.json({
      tileIndex,
      totalTiles,
      center: { x: centerX, y: centerY },
      bboxRD: bbox,
      segments,
      pagesRetrieved,
      truncated,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Tegel ophalen mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
