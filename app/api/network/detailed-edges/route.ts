import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { rdToWgs84, wgs84ToRd } from "@/lib/route-engine/coordinate-transform";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * GET /api/network/detailed-edges?bbox=minLat,minLon,maxLat,maxLon
 *
 * TOEGEVOEGD 7-9-2026, n.a.v. feedback dat de rechte-lijn-vereenvoudiging van
 * /api/network/overview op straatniveau te grof oogt (lijnen dwars door
 * gebouwen/water i.p.v. via de daadwerkelijke weg). Levert daarom de ECHTE,
 * volledige brongeometrie -- maar uitsluitend voor verbindingen binnen het
 * opgegeven kaartgebied, niet landelijk (dat zou de hele
 * dataoptimalisatie-reden van /overview tenietdoen). Bedoeld om alleen
 * aangeroepen te worden zodra er ver genoeg is ingezoomd om nog een beperkt
 * kaartgebied te hebben.
 */
export async function GET(req: NextRequest) {
  const bboxParam = req.nextUrl.searchParams.get("bbox");
  if (!bboxParam) {
    return NextResponse.json({ error: "bbox-parameter verplicht (minLat,minLon,maxLat,maxLon)." }, { status: 400 });
  }
  const parts = bboxParam.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return NextResponse.json({ error: "bbox moet 4 komma-gescheiden getallen zijn." }, { status: 400 });
  }
  const [minLat, minLon, maxLat, maxLon] = parts;

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    // Bbox-hoeken naar RD -- filtering gebeurt in RD-coördinaten (geen herhaalde
    // RD->WGS84-conversie per geometriepunt nodig tijdens het filteren zelf).
    const rdMin = wgs84ToRd(minLat, minLon);
    const rdMax = wgs84ToRd(maxLat, maxLon);
    const rdMinX = Math.min(rdMin.x, rdMax.x);
    const rdMaxX = Math.max(rdMin.x, rdMax.x);
    const rdMinY = Math.min(rdMin.y, rdMax.y);
    const rdMaxY = Math.max(rdMin.y, rdMax.y);

    const allNodeIds = provider.getAllNodeIds();
    const seenEdgeIds = new Set<string>();
    const edges: [number, number][][] = [];

    for (const id of allNodeIds) {
      for (const edge of provider.getEdgesFrom(id)) {
        if (seenEdgeIds.has(edge.id)) continue;
        seenEdgeIds.add(edge.id);

        // Snelle bbox-check: heeft ENIG geometriepunt van deze edge overlap met
        // het opgevraagde gebied? Zo niet, overslaan -- geen conversie nodig.
        const intersects = edge.geometry.some((p) => p.x >= rdMinX && p.x <= rdMaxX && p.y >= rdMinY && p.y <= rdMaxY);
        if (!intersects) continue;

        edges.push(edge.geometry.map((p) => { const w = rdToWgs84(p.x, p.y); return [w.lat, w.lon]; }));
      }
    }

    return NextResponse.json({ edges });
  } catch (err) {
    return NextResponse.json(
      { error: "Gedetailleerde geometrie laden mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
