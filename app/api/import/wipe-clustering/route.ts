import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 60;

/**
 * Verwijdert alle logicalNodes en de bijbehorende clusterComputeCache voor
 * een datasetVersionId, en zet sourceNodes.logicalNodeId terug op null.
 * Nodig na het opschonen van sourceNodes-duplicaten — de bestaande clustering
 * was gebaseerd op de verdubbelde dataset en moet schoon opnieuw draaien.
 *
 * dryRun=1 (default): toont alleen aantallen, verwijdert niets.
 * dryRun=0: voert de verwijdering daadwerkelijk uit.
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

    const [logicalNodesSnap, cacheMetaSnap, sourceNodesSnap] = await Promise.all([
      db.collection("logicalNodes").where("datasetVersionId", "==", datasetVersionId).get(),
      db.collection("clusterComputeCache").doc(datasetVersionId).get(),
      db.collection("sourceNodes").where("datasetVersionId", "==", datasetVersionId).get(),
    ]);

    const cacheChunkCount = cacheMetaSnap.exists ? (cacheMetaSnap.data()?.chunkCount as number) || 0 : 0;

    if (!dryRun) {
      const BATCH_LIMIT = 450;

      // logicalNodes verwijderen
      const logicalIds = logicalNodesSnap.docs.map((d) => d.id);
      for (let i = 0; i < logicalIds.length; i += BATCH_LIMIT) {
        const batch = db.batch();
        for (const id of logicalIds.slice(i, i + BATCH_LIMIT)) {
          batch.delete(db.collection("logicalNodes").doc(id));
        }
        await batch.commit();
      }

      // cache-chunks + meta-document verwijderen
      const cacheRefs = [
        db.collection("clusterComputeCache").doc(datasetVersionId),
        ...Array.from({ length: cacheChunkCount }, (_, i) =>
          db.collection("clusterComputeCache").doc(`${datasetVersionId}_chunk${i}`)
        ),
      ];
      for (let i = 0; i < cacheRefs.length; i += BATCH_LIMIT) {
        const batch = db.batch();
        for (const ref of cacheRefs.slice(i, i + BATCH_LIMIT)) {
          batch.delete(ref);
        }
        await batch.commit();
      }

      // sourceNodes.logicalNodeId terugzetten op null
      const sourceIds = sourceNodesSnap.docs.map((d) => d.id);
      for (let i = 0; i < sourceIds.length; i += BATCH_LIMIT) {
        const batch = db.batch();
        for (const id of sourceIds.slice(i, i + BATCH_LIMIT)) {
          batch.update(db.collection("sourceNodes").doc(id), { logicalNodeId: null });
        }
        await batch.commit();
      }
    }

    return NextResponse.json({
      datasetVersionId,
      dryRun,
      logicalNodesFound: logicalNodesSnap.size,
      cacheChunksFound: cacheChunkCount,
      sourceNodesToReset: sourceNodesSnap.size,
      done: !dryRun,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Wipe mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
