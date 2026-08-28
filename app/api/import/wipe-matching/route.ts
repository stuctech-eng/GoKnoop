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
  const step = req.nextUrl.searchParams.get("step") || "edges"; // 'edges' | 'cache'
  const offset = parseInt(req.nextUrl.searchParams.get("offset") || "0", 10);
  const batchSize = parseInt(req.nextUrl.searchParams.get("batchSize") || "300", 10);

  try {
    const db = getDb();

    if (step === "edges") {
      const snapshot = await db.collection("edges").where("datasetVersionId", "==", datasetVersionId).get();
      const total = snapshot.size;
      const slice = snapshot.docs.slice(offset, offset + batchSize);

      if (!dryRun) {
        const batch = db.batch();
        for (const doc of slice) {
          batch.update(doc.ref, {
            fromLogicalNodeId: null,
            toLogicalNodeId: null,
            matchConfidence: null,
            endpointMatches: null,
          });
        }
        await batch.commit();
      }

      const newOffset = offset + slice.length;
      const done = newOffset >= total;

      return NextResponse.json({
        datasetVersionId,
        dryRun,
        step: "edges",
        total,
        offset,
        processed: slice.length,
        newOffset,
        done,
        nextStep: done ? "Roep nu step=cache aan om de cache op te ruimen." : null,
      });
    }

    // step === 'cache'
    const cacheMetaSnap = await db.collection("edgeMatchCache").doc(datasetVersionId).get();
    const cacheChunkCount = cacheMetaSnap.exists ? (cacheMetaSnap.data()?.chunkCount as number) || 0 : 0;

    if (!dryRun) {
      const cacheRefs = [
        db.collection("edgeMatchCache").doc(datasetVersionId),
        ...Array.from({ length: cacheChunkCount }, (_, i) =>
          db.collection("edgeMatchCache").doc(`${datasetVersionId}_chunk${i}`)
        ),
      ];
      const BATCH_LIMIT = 450;
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
      step: "cache",
      cacheChunksFound: cacheChunkCount,
      done: true,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Wipe mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
