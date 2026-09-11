import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/clear-goknoop-batched
 * Body: { datasetVersionId, kind: "nodes"|"edges" }
 *
 * Fase M6/M7, 10-9-2026. Gevonden probleem: de edge-batchgrootte werd
 * gewijzigd (200 -> 1000, coords eruit gestript), maar oude batch-
 * documenten (index 16-77, MET coords) bleven gewoon bestaan naast de
 * nieuwe (index 0-15) -- Firestore verwijdert nooit automatisch
 * "overbodig geworden" documenten. `FirestoreGraphProvider.load()` leest
 * de HELE collectie, dus las alsnog alle 78 oude + nieuwe documenten,
 * inclusief de trage, met-coords exemplaren.
 *
 * HERZIEN, zelfde dag: de eerste versie las eerst de HELE collectie uit
 * om te weten wat te verwijderen (`collRef.get()`) -- maar dat betekent
 * dat het opruimen zelf de trage, oude met-coords-documenten moest lezen
 * (live bevestigd: "The string did not match the expected pattern" bij
 * edges, exact dezelfde 10s-platform-timeout-fout als bij de hoofdroute-
 * berekening). Nu VERWIJDEREN OP INDEX-BEREIK, zonder eerst te lezen --
 * Firestore's delete() op een niet-bestaand document-ID slaagt
 * probleemloos, dus een ruim bereik (0-999) dekken is veilig en snel.
 */
export async function POST(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: { datasetVersionId?: string; kind?: "nodes" | "edges" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { datasetVersionId, kind } = body;
  if (!datasetVersionId || (kind !== "nodes" && kind !== "edges")) {
    return NextResponse.json({ error: "datasetVersionId en kind (nodes|edges) zijn verplicht." }, { status: 400 });
  }

  const MAX_BATCH_INDEX = 999; // ruim boven het hoogst mogelijke aantal batches bij elke huidige batchgrootte
  const FIRESTORE_BATCH_LIMIT = 450;

  try {
    const db = getDb();
    const collRef = db.collection("goknoopBatched").doc(datasetVersionId).collection(kind);

    let deleted = 0;
    for (let start = 0; start <= MAX_BATCH_INDEX; start += FIRESTORE_BATCH_LIMIT) {
      const batch = db.batch();
      const end = Math.min(start + FIRESTORE_BATCH_LIMIT, MAX_BATCH_INDEX + 1);
      for (let i = start; i < end; i++) {
        batch.delete(collRef.doc(String(i)));
        deleted++;
      }
      await batch.commit();
    }

    return NextResponse.json({ ok: true, kind, verwijderdBereik: `0-${MAX_BATCH_INDEX}`, opmerking: "delete() op niet-bestaande ID's is probleemloos -- dit dekt gewoon het volledige mogelijke bereik." });
  } catch (err) {
    return NextResponse.json(
      { error: "Opruimen mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
