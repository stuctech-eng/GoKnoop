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
        });
      }
    }

    nearbyEndpoints.sort((a, b) => a.distToCenterM - b.distToCenterM);

    const unmatchedNearby = nearbyEndpoints.filter((e) => e.matchedToSourceNodeId === null);
    const justOutsideTolerance = nearbyEndpoints.filter((e) => e.matchedDistanceM !== null && e.matchedDistanceM > 5 && e.matchedDistanceM <= 15);

    return NextResponse.json({
      datasetVersionId,
      center: { lat, lon },
      radiusM,
      totalEndpointsFound: nearbyEndpoints.length,
      unmatchedEndpointCount: unmatchedNearby.length,
      justOutsideToleranceCount: justOutsideTolerance.length,
      interpretation: {
        hint: "Als 'justOutsideToleranceCount' hoog is (endpoints net buiten de 5m-grens, bv. 5-15m), wijst dat op een kalibratieprobleem (tolerantie te strak voor dit gebied). Als endpoints juist ONMATCHED zijn met GEEN nabije sourceNode binnen enkele tientallen meters, wijst dat op een structureel dekkingsgat (geen brondata i.p.v. net gemist).",
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
