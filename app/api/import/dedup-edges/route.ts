import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 60;

/**
 * Eenmalige opschoonroute: verwijdert dubbele edge-documenten die zijn
 * ontstaan vóór de invoering van deterministische document-ID's
 * (datasetVersionId_sourceObjectId). Een edge is een duplicaat als er
 * meerdere documenten bestaan met hetzelfde sourceObjectId binnen dezelfde
 * datasetVersionId — het document met de canonieke (deterministische) ID
 * blijft staan, alle andere (met een willekeurig gegenereerde ID) worden
 * verwijderd.
 *
 * dryRun=1 (default): toont alleen wat verwijderd zou worden, verwijdert niets.
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

    const snapshot = await db.collection("edges").where("datasetVersionId", "==", datasetVersionId).get();

    const bySourceObjectId: Record<string, { id: string }[]> = {};
    let emptySourceObjectIdCount = 0;
    snapshot.docs.forEach((doc) => {
      const sourceObjectId = doc.data().sourceObjectId as string;
      if (!sourceObjectId || sourceObjectId.trim() === "") {
        // Nooit als duplicaat behandelen — een lege/ontbrekende sourceObjectId
        // betekent niet dat meerdere van zulke edges dezelfde bron zijn.
        emptySourceObjectIdCount++;
        return;
      }
      (bySourceObjectId[sourceObjectId] ||= []).push({ id: doc.id });
    });

    const toDelete: string[] = [];
    let duplicateGroups = 0;

    for (const [sourceObjectId, docs] of Object.entries(bySourceObjectId)) {
      if (docs.length <= 1) continue;
      duplicateGroups++;
      const canonicalId = `${datasetVersionId}_${sourceObjectId}`;
      const hasCanonical = docs.some((d) => d.id === canonicalId);
      if (hasCanonical) {
        // Bewaar de canonieke, verwijder de rest.
        for (const d of docs) {
          if (d.id !== canonicalId) toDelete.push(d.id);
        }
      } else {
        // Geen canonieke variant aanwezig (onverwacht) — bewaar de eerste, verwijder de rest.
        for (const d of docs.slice(1)) toDelete.push(d.id);
      }
    }

    if (!dryRun) {
      const BATCH_LIMIT = 450;
      for (let i = 0; i < toDelete.length; i += BATCH_LIMIT) {
        const chunk = toDelete.slice(i, i + BATCH_LIMIT);
        const batch = db.batch();
        for (const id of chunk) {
          batch.delete(db.collection("edges").doc(id));
        }
        await batch.commit();
      }
    }

    return NextResponse.json({
      datasetVersionId,
      dryRun,
      totalEdgeDocs: snapshot.size,
      emptySourceObjectIdCount,
      uniqueSourceObjectIds: Object.keys(bySourceObjectId).length,
      duplicateGroups,
      documentsToDelete: toDelete.length,
      documentsDeleted: dryRun ? 0 : toDelete.length,
      expectedRemainingAfterCleanup: snapshot.size - toDelete.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Dedup mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
