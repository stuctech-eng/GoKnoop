import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Zet edges.fromLogicalNodeId/toLogicalNodeId/matchConfidence/endpointMatches
 * terug op null, en verwijdert de edgeMatchCache. Nodig na een her-clustering
 * (nieuwe logicalNodeId's) — de bestaande matches verwijzen naar de oude,
 * inmiddels verwijderde logicalNodes.
 *
 * dryRun=1 (default): toont alleen aantallen. dryRun=0: voert het uit.
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
    return NextResponse.json({ error: "datasetVersionId is verplicht." }, { status: 400 });
  }
  const dryRun = req.nextUrl.searchParams.get("dryRun") !== "0";

  try {
    const db = getDb();

    const [edgesSnap, cacheMetaSnap] = await Promise.all([
      db.collection("edges").where("datasetVersionId", "==", datasetVersionId).get(),
      db.collection("edgeMatchCache").doc(datasetVersionId).get(),
    ]);

    const cacheChunkCount = cacheMetaSnap.exists ? (cacheMetaSnap.data()?.chunkCount as number) || 0 : 0;

    if (!dryRun) {
      const BATCH_LIMIT = 450;

      const edgeIds = edgesSnap.docs.map((d) => d.id);
      for (let i = 0; i < edgeIds.length; i += BATCH_LIMIT) {
        const batch = db.batch();
        for (const id of edgeIds.slice(i, i + BATCH_LIMIT)) {
          batch.update(db.collection("edges").doc(id), {
            fromLogicalNodeId: null,
            toLogicalNodeId: null,
            matchConfidence: null,
            endpointMatches: null,
          });
        }
        await batch.commit();
      }

      const cacheRefs = [
        db.collection("edgeMatchCache").doc(datasetVersionId),
        ...Array.from({ length: cacheChunkCount }, (_, i) =>
          db.collection("edgeMatchCache").doc(`${datasetVersionId}_chunk${i}`)
        ),
      ];
      for (let i = 0; i < cacheRefs.length; i += BATCH_LIMIT) {
        const batch = db.batch();
        for (const ref of cacheRefs.slice(i, i + BATCH_LIMIT)) {
          batch.delete(ref);
        }
        await batch.commit();
      }
    }

    return NextResponse.json({
      datasetVersionId,
      dryRun,
      edgesToReset: edgesSnap.size,
      cacheChunksFound: cacheChunkCount,
      done: !dryRun,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Wipe mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
