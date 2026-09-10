import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import type { SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/read-active-nwb-segments
 *
 * Fase G (connector-generatie), 9-9-2026. Leest de ACTIEVE NWB-
 * productiedata (via config/activeNwbDataset) volledig uit.
 *
 * FASE M6/M7 (opslagformaat-fix), 10-9-2026: sinds het gebatchte formaat
 * (~360 documenten i.p.v. 144.000 losse) is paginering niet meer nodig --
 * alles past ruimschoots in één aanvraag (zie de meting: 2000 losse
 * documenten in 401ms, dus ~360 gebatchte documenten in een fractie
 * daarvan). Cursor-paginering (voorheen hier aanwezig) is daarom verwijderd.
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

    const batchesSnap = await db.collection("nwbSegments").doc(nwbDatasetVersionId).collection("batches").get();
    const segments: SlimNwbSegment[] = [];
    for (const doc of batchesSnap.docs) {
      const data = doc.data() as { segments: SlimNwbSegment[] };
      segments.push(...data.segments);
    }

    return NextResponse.json({ nwbDatasetVersionId, segments, nextCursor: null, done: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Actieve NWB-segmenten lezen mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
