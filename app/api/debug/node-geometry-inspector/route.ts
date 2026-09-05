import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { wgs84ToRd, rdToWgs84 } from "@/lib/route-engine/coordinate-transform";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/node-geometry-inspector
 *
 * GPT-voorstel (sessie 4-9-2026): voor specifieke probleem-knopen (knooppunt 5,
 * 56-kandidaten, andere 0-edge-nodes) niet alleen concluderen "unmatched", maar
 * de brongeometrie ERNAAST leggen: is het een net-buiten-tolerantie-geval (bv.
 * 7,2m i.p.v. 5m), of een structureel andere geometrische situatie?
 *
 * Query params:
 *   key      — DEBUG_SECRET
 *   datasetVersionId — optioneel, default: config/activeDataset
 *   lat, lon — middelpunt
 *   radiusM  — zoekradius in meter (default 150)
 *
 * Retourneert alle edge-endpoints (matched EN unmatched) binnen de radius, met
 * hun exacte matchConfidence, distanceM en de coördinaten van zowel het
 * bronpunt als de gematchte sourceNode (indien van toepassing) -- zodat
 * zichtbaar wordt OF en HOEVER de brongeometrie van de dichtstbijzijnde node
 * afligt, i.p.v. alleen "unmatched" te melden.
 */

export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const latStr = req.nextUrl.searchParams.get("lat");
  const lonStr = req.nextUrl.searchParams.get("lon");
  if (!latStr || !lonStr) {
    return NextResponse.json({ error: "lat en lon zijn verplicht." }, { status: 400 });
  }
  const lat = parseFloat(latStr);
  const lon = parseFloat(lonStr);
  const radiusM = parseFloat(req.nextUrl.searchParams.get("radiusM") || "150");

  try {
    const db = getDb();

    let datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId");
    if (!datasetVersionId) {
      const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
      if (!activeDatasetSnap.exists) {
        return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
      }
      datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;
    }

    const centerRd = wgs84ToRd(lat, lon);
    const radiusSq = radiusM * radiusM;

    const [edgesSnap, sourceNodesSnap] = await Promise.all([
      db.collection("edges").where("datasetVersionId", "==", datasetVersionId).get(),
      db.collection("sourceNodes").where("datasetVersionId", "==", datasetVersionId).get(),
    ]);

    const sourceNodeById = new Map<string, { x: number; y: number; logicalNodeId: string | null }>();
    for (const doc of sourceNodesSnap.docs) {
      const d = doc.data();
      sourceNodeById.set(doc.id, { x: d.x, y: d.y, logicalNodeId: d.logicalNodeId ?? null });
    }

    type EndpointMatch = {
      endpoint: "start" | "end";
      sourceCoordinate: { x: number; y: number };
      matchedSourceNodeId: string | null;
      logicalNodeId: string | null;
      distanceM: number | null;
      matchConfidence: string;
      ambiguous: boolean;
    };

    const sourceNodeList: { id: string; x: number; y: number }[] = [];
    for (const [id, n] of sourceNodeById) sourceNodeList.push({ id, x: n.x, y: n.y });

    function nearestSourceNode(point: { x: number; y: number }): { id: string; d: number } | null {
      let best: { id: string; d: number } | null = null;
      for (const n of sourceNodeList) {
        const d = Math.sqrt((n.x - point.x) ** 2 + (n.y - point.y) ** 2);
        if (!best || d < best.d) best = { id: n.id, d };
      }
      return best;
    }

    const nearbyEndpoints: {
      edgeId: string;
      edgeMatchConfidence: string;
      endpoint: "start" | "end";
      pointLat: number;
      pointLon: number;
      distToCenterM: number;
      matchedToSourceNodeId: string | null;
      matchedDistanceM: number | null;
      matchedSourceNodeLat: number | null;
      matchedSourceNodeLon: number | null;
      actualNearestSourceNodeId: string | null;
      actualNearestDistanceM: number | null;
    }[] = [];

    for (const doc of edgesSnap.docs) {
      const data = doc.data();
      const endpointMatches: EndpointMatch[] | undefined = data.endpointMatches;
      if (!endpointMatches) continue; // edge nog niet gematcht/geschreven

      for (const ep of endpointMatches) {
        const dx = ep.sourceCoordinate.x - centerRd.x;
        const dy = ep.sourceCoordinate.y - centerRd.y;
        const distSq = dx * dx + dy * dy;
        if (distSq > radiusSq) continue;

        const wgs = rdToWgs84(ep.sourceCoordinate.x, ep.sourceCoordinate.y);
        let matchedLat: number | null = null;
        let matchedLon: number | null = null;
        if (ep.matchedSourceNodeId) {
          const sn = sourceNodeById.get(ep.matchedSourceNodeId);
          if (sn) {
            const snWgs = rdToWgs84(sn.x, sn.y);
            matchedLat = snWgs.lat;
            matchedLon = snWgs.lon;
          }
        }

        const actual = nearestSourceNode(ep.sourceCoordinate);

        nearbyEndpoints.push({
          edgeId: doc.id,
          edgeMatchConfidence: data.matchConfidence,
          endpoint: ep.endpoint,
          pointLat: wgs.lat,
          pointLon: wgs.lon,
          distToCenterM: Math.sqrt(distSq),
          matchedToSourceNodeId: ep.matchedSourceNodeId,
          matchedDistanceM: ep.distanceM,
          matchedSourceNodeLat: matchedLat,
          matchedSourceNodeLon: matchedLon,
          actualNearestSourceNodeId: actual?.id ?? null,
          actualNearestDistanceM: actual ? Number(actual.d.toFixed(2)) : null,
        });
      }
    }

    nearbyEndpoints.sort((a, b) => a.distToCenterM - b.distToCenterM);

    const unmatchedNearby = nearbyEndpoints.filter((e) => e.matchedToSourceNodeId === null);
    const justOutsideTolerance = nearbyEndpoints.filter(
      (e) => e.actualNearestDistanceM !== null && e.actualNearestDistanceM > 5 && e.actualNearestDistanceM <= 15
    );
    const structurallyFar = unmatchedNearby.filter((e) => e.actualNearestDistanceM !== null && e.actualNearestDistanceM > 15);

    return NextResponse.json({
      datasetVersionId,
      center: { lat, lon },
      radiusM,
      totalEndpointsFound: nearbyEndpoints.length,
      unmatchedEndpointCount: unmatchedNearby.length,
      justOutsideToleranceCount: justOutsideTolerance.length,
      structurallyFarCount: structurallyFar.length,
      interpretation: {
        hint: "justOutsideToleranceCount = endpoints (matched of onmatched) met een werkelijk dichtstbijzijnde sourceNode net buiten de 5m-grens (5-15m) -- kalibratieprobleem. structurallyFarCount = onmatched endpoints waarvan de dichtstbijzijnde sourceNode zelfs >15m weg ligt -- structureel dekkingsgat, geen kalibratiekwestie. Let op: 'matchedDistanceM' is null voor onmatched endpoints (de bestaande matching-code onthoudt geen afstand buiten tolerantie); gebruik 'actualNearestDistanceM' voor de echte afstand, ook bij onmatched.",
      },
      endpoints: nearbyEndpoints,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Inspectie mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
