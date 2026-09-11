import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/clear-nwb-batches
 * Body: { nwbDatasetVersionId }
 *
 * Fase 9 (performance-vervolg), 11-9-2026. Batchgrootte vergroot (400 ->
 * 2000, minder documenten, minder Firestore-overhead) -- oude batch-
 * documenten met hogere index (66-329) moeten opgeruimd worden vóór een
 * hermigratie, anders blijven ze als "geesten" hangen naast de nieuwe.
 * Zelfde, al-bewezen veilige patroon als `clear-goknoop-batched`:
 * individuele `delete()`-aanroepen, GEEN `db.batch()` (die gaf eerder
 * live een "Transaction too big"-fout, ook bij kleine aantallen).
 */
export async function POST(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: { nwbDatasetVersionId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }
  const { nwbDatasetVersionId } = body;
  if (!nwbDatasetVersionId) {
    return NextResponse.json({ error: "nwbDatasetVersionId is verplicht." }, { status: 400 });
  }

  const MAX_BATCH_INDEX = 999;
  const PARALLEL_GROUP_SIZE = 50;

  try {
    const db = getDb();
    const collRef = db.collection("nwbSegments").doc(nwbDatasetVersionId).collection("batches");

    for (let start = 0; start <= MAX_BATCH_INDEX; start += PARALLEL_GROUP_SIZE) {
      const end = Math.min(start + PARALLEL_GROUP_SIZE, MAX_BATCH_INDEX + 1);
      const deletions: Promise<unknown>[] = [];
      for (let i = start; i < end; i++) {
        deletions.push(collRef.doc(String(i)).delete());
      }
      await Promise.all(deletions);
    }

    return NextResponse.json({ ok: true, verwijderdBereik: `0-${MAX_BATCH_INDEX}` });
  } catch (err) {
    return NextResponse.json(
      { error: "Opruimen mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
