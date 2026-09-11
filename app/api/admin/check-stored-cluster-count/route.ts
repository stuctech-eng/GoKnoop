import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import type { SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/check-stored-cluster-count?nwbDatasetVersionId=...
 *
 * Fase M6/M7-diagnose, 11-9-2026. ALLEEN lezen + tellen -- GEEN live
 * herberekening (die kostte samen met lezen te veel tijd, live bevestigd
 * met een 504). Snel, veilig binnen budget.
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

    let totaal = 0;
    let metClusters = 0;
    const clusterIds = new Set<string>();

    for (const doc of batchesSnap.docs) {
      const data = doc.data() as { segments: SlimNwbSegment[] };
      for (const s of data.segments) {
        totaal++;
        if (s.fromClusterId && s.toClusterId) {
          metClusters++;
          clusterIds.add(s.fromClusterId);
          clusterIds.add(s.toClusterId);
        }
      }
    }

    return NextResponse.json({
      nwbDatasetVersionId,
      totaalSegmenten: totaal,
      segmentenMetClusters: metClusters,
      segmentenZonderClusters: totaal - metClusters,
      uniekeClusterAantal: clusterIds.size,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Check mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
