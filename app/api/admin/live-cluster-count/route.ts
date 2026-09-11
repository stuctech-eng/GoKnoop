import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { computeNwbClusterAssignments, type SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const CONNECTOR_SEARCH_TOLERANCE_M = 20;

/**
 * GET /api/admin/live-cluster-count?nwbDatasetVersionId=...
 *
 * Fase M6/M7-diagnose, 11-9-2026. MINIMALE versie: uitsluitend lezen +
 * live clusteren + aantal teruggeven -- geen enkele extra vergelijkings-
 * logica (die maakte de vorige poging te traag, live bevestigd met een
 * 504). Moet, net als de geslaagde precompute-stap (~8,5s), binnen budget
 * passen.
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const nwbDatasetVersionId = req.nextUrl.searchParams.get("nwbDatasetVersionId") ?? "nwb-2026-09-10-v2-gebatcht";

  try {
    const db = getDb();
    const batchesSnap = await db.collection("nwbSegments").doc(nwbDatasetVersionId).collection("batches").get();

    const allSegments: SlimNwbSegment[] = [];
    for (const doc of batchesSnap.docs) {
      const data = doc.data() as { segments: SlimNwbSegment[] };
      allSegments.push(...data.segments);
    }

    const liveAssignments = await computeNwbClusterAssignments(allSegments, CONNECTOR_SEARCH_TOLERANCE_M);

    const liveClusterIds = new Set<string>();
    for (const a of liveAssignments.values()) {
      liveClusterIds.add(a.fromClusterId);
      liveClusterIds.add(a.toClusterId);
    }

    return NextResponse.json({
      nwbDatasetVersionId,
      totaalSegmenten: allSegments.length,
      liveClusterAantal: liveClusterIds.size,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Live-clustering mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
