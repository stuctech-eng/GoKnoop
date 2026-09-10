import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import type { SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const PAGE_SIZE = 2000;

/**
 * GET /api/admin/read-active-nwb-segments?cursor=<laatste-doc-id>
 *
 * Fase G (connector-generatie), 9-9-2026. Leest de ACTIEVE NWB-
 * productiedata (via config/activeNwbDataset) gepagineerd uit.
 * Cursor-gebaseerd (documentId, niet offset) -- bij ~144k documenten is
 * offset-paginering merkbaar trager naarmate de offset groeit.
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const db = getDb();
    const activeSnap = await db.collection("config").doc("activeNwbDataset").get();
    if (!activeSnap.exists) {
      return NextResponse.json({ error: "config/activeNwbDataset bestaat niet -- eerst migreren + activeren." }, { status: 404 });
    }
    const nwbDatasetVersionId = activeSnap.data()!.nwbDatasetVersionId as string;

    const cursor = req.nextUrl.searchParams.get("cursor");
    let query = db
      .collection("nwbSegments")
      .doc(nwbDatasetVersionId)
      .collection("segments")
      .orderBy("__name__")
      .limit(PAGE_SIZE);

    if (cursor) {
      const cursorDoc = await db.collection("nwbSegments").doc(nwbDatasetVersionId).collection("segments").doc(cursor).get();
      if (cursorDoc.exists) query = query.startAfter(cursorDoc);
    }

    const snap = await query.get();
    const segments = snap.docs.map((d) => d.data() as SlimNwbSegment);
    const nextCursor = snap.docs.length === PAGE_SIZE ? snap.docs[snap.docs.length - 1].id : null;

    return NextResponse.json({ nwbDatasetVersionId, segments, nextCursor, done: nextCursor === null });
  } catch (err) {
    return NextResponse.json(
      { error: "Actieve NWB-segmenten lezen mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
