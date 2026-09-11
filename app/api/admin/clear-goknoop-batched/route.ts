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
 * Dit endpoint wist ALLE documenten in de betreffende subcollectie vóór
 * een hermigratie, zodat oude batch-indices niet kunnen blijven hangen.
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

  try {
    const db = getDb();
    const collRef = db.collection("goknoopBatched").doc(datasetVersionId).collection(kind);
    const snap = await collRef.get();

    const BATCH_LIMIT = 450;
    let deleted = 0;
    for (let i = 0; i < snap.docs.length; i += BATCH_LIMIT) {
      const chunk = snap.docs.slice(i, i + BATCH_LIMIT);
      const batch = db.batch();
      for (const doc of chunk) batch.delete(doc.ref);
      await batch.commit();
      deleted += chunk.length;
    }

    return NextResponse.json({ ok: true, kind, verwijderd: deleted });
  } catch (err) {
    return NextResponse.json(
      { error: "Opruimen mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
