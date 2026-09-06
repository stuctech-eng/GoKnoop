import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { wgs84ToRd, rdToWgs84 } from "@/lib/route-engine/coordinate-transform";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * POST /api/debug/nearest-nodes
 * Body: { lat, lon, limit? }
 * Response: { queryLat, queryLon, nodes: [{ nodeId, displayNumber, edgeCount, lat, lon, distanceM }] }
 *
 * Diagnose-tool (NDSM-pontje-onderzoek, sectie 9.7x, 4-9-2026). Doel: het "dichtstbijzijnde
 * knooppunt bij een punt" van /api/debug/direct-route kan een vervuilde/geïsoleerde node
 * treffen (0 edges, geen weergavenummer) i.p.v. het echte, verbonden fietsknooppunt bij die
 * locatie. Deze tool toont de N dichtstbijzijnde knopen MET hun daadwerkelijke edge-count in
 * de matched graph, zodat het juiste patch-kandidaat-knooppunt te kiezen is zonder te gokken.
 */
export async function POST(req: NextRequest) {
  let body: { lat?: number; lon?: number; limit?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { lat, lon, limit } = body;
  if (lat === undefined || lon === undefined) {
    return NextResponse.json({ error: "lat en lon zijn verplicht." }, { status: 400 });
  }
  const n = Math.min(Math.max(limit ?? 15, 1), 50);

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    const queryRd = wgs84ToRd(lat, lon);

    const scored = provider.getAllNodeIds().map((id) => {
      const node = provider.getNode(id)!;
      const distSq = (node.x - queryRd.x) ** 2 + (node.y - queryRd.y) ** 2;
      return { id, node, distSq };
    });
    scored.sort((a, b) => a.distSq - b.distSq);

    const nearest = scored.slice(0, n).map(({ id, node, distSq }) => {
      const wgs84 = rdToWgs84(node.x, node.y);
      return {
        nodeId: id,
        displayNumber: node.displayNumber ?? null,
        edgeCount: provider.getEdgesFrom(id).length,
        lat: wgs84.lat,
        lon: wgs84.lon,
        distanceM: Math.sqrt(distSq),
      };
    });

    return NextResponse.json({ queryLat: lat, queryLon: lon, nodes: nearest });
  } catch (err) {
    return NextResponse.json(
      { error: "Diagnose mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
