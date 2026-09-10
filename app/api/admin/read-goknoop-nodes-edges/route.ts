import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const PAGE_SIZE = 1500;

/**
 * GET /api/admin/read-goknoop-nodes-edges?datasetVersionId=...&kind=nodes|edges&cursor=<doc-id>
 *
 * Fase M6/M7 (GoKnoop-opslagformaat-fix), 10-9-2026. Live gemeten:
 * `CachedGraphProvider.load()` (dus `FirestoreGraphProvider`, die
 * `logicalNodes`/`edges` als LOSSE documenten leest -- 11.003 + ~15.495)
 * duurde 11.185ms, ALLEEN AL boven de 10s-limiet, los van alle NWB-werk.
 * Zelfde diagnose, zelfde soort oorzaak als de eerdere NWB-144k-fix.
 *
 * Dit eindpunt leest de BESTAANDE, ONGEWIJZIGDE collecties gepagineerd uit
 * -- voor eenmalige migratie naar een gebatcht formaat. Raakt de originele
 * data op geen enkele manier aan.
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
  const kind = req.nextUrl.searchParams.get("kind");
  if (!datasetVersionId || (kind !== "nodes" && kind !== "edges")) {
    return NextResponse.json({ error: "datasetVersionId en kind (nodes|edges) zijn verplicht." }, { status: 400 });
  }

  try {
    const db = getDb();
    const collectionName = kind === "nodes" ? "logicalNodes" : "edges";

    let query = db.collection(collectionName).where("datasetVersionId", "==", datasetVersionId).orderBy("__name__").limit(PAGE_SIZE);
    if (kind === "edges") {
      // Zelfde filter als FirestoreGraphProvider.load() -- alleen matched edges migreren.
      query = db
        .collection(collectionName)
        .where("datasetVersionId", "==", datasetVersionId)
        .where("matchConfidence", "==", "matched")
        .orderBy("__name__")
        .limit(PAGE_SIZE);
    }

    const cursor = req.nextUrl.searchParams.get("cursor");
    if (cursor) {
      const cursorDoc = await db.collection(collectionName).doc(cursor).get();
      if (cursorDoc.exists) query = query.startAfter(cursorDoc);
    }

    const snap = await query.get();
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const nextCursor = snap.docs.length === PAGE_SIZE ? snap.docs[snap.docs.length - 1].id : null;

    return NextResponse.json({ items, nextCursor, done: nextCursor === null });
  } catch (err) {
    return NextResponse.json(
      { error: "GoKnoop-data lezen mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
