import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { computeNwbClusterAssignments, type SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const CONNECTOR_SEARCH_TOLERANCE_M = 20;

type StoredSegment = SlimNwbSegment & { fromClusterId?: string; toClusterId?: string };

/**
 * GET /api/admin/compare-clustering-direct?nwbDatasetVersionId=...
 *
 * Fase 1+2 van het uitvoeringsplan, 11-9-2026, TWEEDE HERZIENING: de eerste
 * herziening (kleine respons, maar segmenten via de browser doorgestuurd
 * van het ene naar het andere endpoint) timede ALSNOG uit -- het opnieuw
 * serialiseren/parsen van 131k segmenten over HTTP+JSON bleek zelf al te
 * traag, los van de clustering. Dit endpoint doet PRECIES wat de EERDER
 * WEL SUCCESVOLLE precompute-stap deed: rechtstreeks uit Firestore lezen
 * (geen browser-omweg), en gebruikt de fromClusterId/toClusterId die AL IN
 * DEZELFDE, ZOJUIST GELEZEN data zitten voor de vergelijking -- geen
 * tweede aanvraag nodig.
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
  const t0 = Date.now();
  const timings: Record<string, number> = {};

  try {
    const db = getDb();
    const batchesSnap = await db.collection("nwbSegments").doc(nwbDatasetVersionId).collection("batches").get();
    timings.batchesGelezenMs = Date.now() - t0;

    const storedSegments: StoredSegment[] = [];
    for (const doc of batchesSnap.docs) {
      const data = doc.data() as { segments: StoredSegment[] };
      storedSegments.push(...data.segments);
    }
    timings.uitgepaktMs = Date.now() - t0;

    // Vers clusteren -- computeNwbClusterAssignments negeert fromClusterId/toClusterId,
    // die worden hier alleen gebruikt voor de vergelijking hieronder.
    const computed = await computeNwbClusterAssignments(storedSegments, CONNECTOR_SEARCH_TOLERANCE_M);
    timings.clusteringKlaarMs = Date.now() - t0;

    const computedUniqueClusters = new Set<string>();
    for (const a of computed.values()) {
      computedUniqueClusters.add(a.fromClusterId);
      computedUniqueClusters.add(a.toClusterId);
    }

    const storedToComputedFrom = new Map<string, Set<string>>();
    const computedToStoredFrom = new Map<string, Set<string>>();
    const storedToComputedTo = new Map<string, Set<string>>();
    const computedToStoredTo = new Map<string, Set<string>>();

    let totalCompared = 0;
    let missingComputed = 0;
    const storedUniqueClusters = new Set<string>();

    for (const seg of storedSegments) {
      const comp = computed.get(seg.id);
      if (!comp) {
        missingComputed++;
        continue;
      }
      if (!seg.fromClusterId || !seg.toClusterId) continue;
      totalCompared++;
      storedUniqueClusters.add(seg.fromClusterId);
      storedUniqueClusters.add(seg.toClusterId);

      if (!storedToComputedFrom.has(seg.fromClusterId)) storedToComputedFrom.set(seg.fromClusterId, new Set());
      storedToComputedFrom.get(seg.fromClusterId)!.add(comp.fromClusterId);
      if (!computedToStoredFrom.has(comp.fromClusterId)) computedToStoredFrom.set(comp.fromClusterId, new Set());
      computedToStoredFrom.get(comp.fromClusterId)!.add(seg.fromClusterId);

      if (!storedToComputedTo.has(seg.toClusterId)) storedToComputedTo.set(seg.toClusterId, new Set());
      storedToComputedTo.get(seg.toClusterId)!.add(comp.toClusterId);
      if (!computedToStoredTo.has(comp.toClusterId)) computedToStoredTo.set(comp.toClusterId, new Set());
      computedToStoredTo.get(comp.toClusterId)!.add(seg.toClusterId);
    }
    timings.vergelekenMs = Date.now() - t0;

    function countNonBijective(map: Map<string, Set<string>>): number {
      let count = 0;
      for (const set of map.values()) if (set.size > 1) count++;
      return count;
    }
    function firstExamples(map: Map<string, Set<string>>, limit: number): { key: string; values: string[] }[] {
      const out: { key: string; values: string[] }[] = [];
      for (const [k, set] of map) {
        if (set.size > 1) {
          out.push({ key: k, values: Array.from(set) });
          if (out.length >= limit) break;
        }
      }
      return out;
    }

    const storedFromSplits = countNonBijective(storedToComputedFrom);
    const computedFromSplits = countNonBijective(computedToStoredFrom);
    const storedToSplits = countNonBijective(storedToComputedTo);
    const computedToSplits = countNonBijective(computedToStoredTo);
    const isEquivalent = storedFromSplits === 0 && computedFromSplits === 0 && storedToSplits === 0 && computedToSplits === 0;

    return NextResponse.json({
      nwbDatasetVersionId,
      segmentCount: storedSegments.length,
      pointCount: computed.size * 2,
      totalCompared,
      missingComputed,
      storedUniqueClusterCount: storedUniqueClusters.size,
      computedUniqueClusterCount: computedUniqueClusters.size,
      timings,
      bijectieCheck: {
        isEquivalent,
        storedFromSplitsIntoMultipleComputed: storedFromSplits,
        computedFromSplitsIntoMultipleStored: computedFromSplits,
        storedToSplitsIntoMultipleComputed: storedToSplits,
        computedToSplitsIntoMultipleStored: computedToSplits,
      },
      exactMatchPercentage: totalCompared > 0 ? Math.round(((totalCompared - storedFromSplits - storedToSplits) / totalCompared) * 10000) / 100 : null,
      differenceExamples: {
        storedFromSplitsIntoMultipleComputed: firstExamples(storedToComputedFrom, 10),
        computedFromSplitsIntoMultipleStored: firstExamples(computedToStoredFrom, 10),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Vergelijking mislukt.", details: err instanceof Error ? err.message : String(err), timings },
      { status: 502 }
    );
  }
}
