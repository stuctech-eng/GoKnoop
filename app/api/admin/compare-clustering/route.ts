import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { computeNwbClusterAssignments, type SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const CONNECTOR_SEARCH_TOLERANCE_M = 20;

/**
 * GET /api/admin/compare-clustering?nwbDatasetVersionId=...
 *
 * Fase M6/M7-diagnose, 11-9-2026. Berekent clustering LIVE (opnieuw, vers)
 * en vergelijkt dat direct met de OPGESLAGEN, vooraf-berekende cluster-ID's
 * in dezelfde segmenten -- bewijst of de precompute-pijplijn zelf een
 * inconsistentie introduceerde, of dat het probleem elders zit.
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

    const storedSegments: SlimNwbSegment[] = [];
    for (const doc of batchesSnap.docs) {
      const data = doc.data() as { segments: SlimNwbSegment[] };
      storedSegments.push(...data.segments);
    }

    const storedWithClusters = storedSegments.filter((s) => s.fromClusterId && s.toClusterId);
    const storedWithoutClusters = storedSegments.length - storedWithClusters.length;

    // Live, vers herberekenen -- GEEN gebruik van de opgeslagen fromClusterId/toClusterId,
    // puur op basis van de ruwe from/to-coördinaten.
    const rawSegmentsForLiveClustering: SlimNwbSegment[] = storedSegments.map((s) => ({
      ...s,
      fromClusterId: undefined,
      toClusterId: undefined,
    }));
    const liveAssignments = await computeNwbClusterAssignments(rawSegmentsForLiveClustering, CONNECTOR_SEARCH_TOLERANCE_M);

    // Live cluster-aantal (unieke fromClusterId/toClusterId-waarden).
    const liveClusterIds = new Set<string>();
    for (const a of liveAssignments.values()) {
      liveClusterIds.add(a.fromClusterId);
      liveClusterIds.add(a.toClusterId);
    }

    // Opgeslagen cluster-aantal.
    const storedClusterIds = new Set<string>();
    for (const s of storedWithClusters) {
      storedClusterIds.add(s.fromClusterId!);
      storedClusterIds.add(s.toClusterId!);
    }

    // Directe vergelijking: voor elk segment, komt de LIVE-berekende relatie
    // (zelfde cluster of niet) overeen met de OPGESLAGEN relatie?
    let matchCount = 0;
    let mismatchCount = 0;
    const mismatchExamples: { segmentId: string; live: { from: string; to: string; sameCluster: boolean }; stored: { from: string | undefined; to: string | undefined; sameCluster: boolean } }[] = [];

    for (const seg of storedSegments) {
      const live = liveAssignments.get(seg.id);
      if (!live) continue;
      const liveSameCluster = live.fromClusterId === live.toClusterId;
      const storedSameCluster = seg.fromClusterId !== undefined && seg.fromClusterId === seg.toClusterId;

      // We kunnen de exacte cluster-ID's niet vergelijken (die zijn willekeurige labels,
      // verschillend tussen twee onafhankelijke union-find-runs) -- WEL of twee segmenten
      // die in de LIVE-run in hetzelfde cluster zitten, dat ook in de OPGESLAGEN data doen.
      if (liveSameCluster === storedSameCluster) matchCount++;
      else {
        mismatchCount++;
        if (mismatchExamples.length < 5) {
          mismatchExamples.push({
            segmentId: seg.id,
            live: { from: live.fromClusterId, to: live.toClusterId, sameCluster: liveSameCluster },
            stored: { from: seg.fromClusterId, to: seg.toClusterId, sameCluster: storedSameCluster },
          });
        }
      }
    }

    return NextResponse.json({
      nwbDatasetVersionId,
      totaalSegmenten: storedSegments.length,
      opgeslagenMetClusters: storedWithClusters.length,
      opgeslagenZonderClusters: storedWithoutClusters,
      liveClusterAantal: liveClusterIds.size,
      opgeslagenClusterAantal: storedClusterIds.size,
      zelfdeSegmentAlsEenCluster: { matchCount, mismatchCount },
      mismatchVoorbeelden: mismatchExamples,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Vergelijking mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
