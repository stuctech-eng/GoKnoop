import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import type { SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const FIRESTORE_BATCH_LIMIT = 450; // ruim onder de harde 500-limiet van Firestore

/**
 * POST /api/admin/migrate-nwb-to-production
 *
 * Fase F (technische uitvoering), 9-9-2026. Migreert AL-VERZAMELDE
 * onderzoeksdata (uit nwbResearchTiles, via de client geconsolideerd) naar
 * het Fase F-productieschema. GEEN nieuwe PDOK-aanroepen -- puur een
 * overzetting van al-gevalideerde data.
 *
 * BEWUST NIET: dit endpoint activeert de nieuwe versie niet automatisch
 * (schrijft niet naar config/activeNwbDataset). Dat is een aparte, expliciete
 * stap (zie /api/admin/activate-nwb-dataset) -- "data schrijven" en "data
 * live zetten" blijven bewust gescheiden acties.
 *
 * Body per aanroep (herhaald aangeroepen door de client, zelfde gepagineerde
 * patroon als de onderzoeksfase):
 *   { nwbDatasetVersionId, segments: SlimNwbSegment[], isFirstChunk, metadata? }
 */
export async function POST(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: {
    nwbDatasetVersionId?: string;
    segments?: SlimNwbSegment[];
    isFirstChunk?: boolean;
    metadata?: { bron: string; licentie: string; regios: string[]; opgehaaldOp: string };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { nwbDatasetVersionId, segments, isFirstChunk, metadata } = body;
  if (!nwbDatasetVersionId || !segments) {
    return NextResponse.json({ error: "nwbDatasetVersionId en segments zijn verplicht." }, { status: 400 });
  }

  try {
    const db = getDb();

    if (isFirstChunk) {
      if (!metadata) {
        return NextResponse.json({ error: "Bij isFirstChunk is metadata verplicht." }, { status: 400 });
      }
      await db
        .collection("nwbDatasetVersions")
        .doc(nwbDatasetVersionId)
        .set({
          ...metadata,
          segmentCount: 0, // wordt bijgewerkt in het laatste-chunk-antwoord van de client, ter info -- niet leidend
          reproduceerbaar: true,
          migratedAt: new Date().toISOString(),
          status: "migrating",
        });
    }

    // Segmenten wegschrijven in batches (Firestore: max 500 writes/batch).
    for (let i = 0; i < segments.length; i += FIRESTORE_BATCH_LIMIT) {
      const chunk = segments.slice(i, i + FIRESTORE_BATCH_LIMIT);
      const batch = db.batch();
      for (const seg of chunk) {
        const ref = db.collection("nwbSegments").doc(nwbDatasetVersionId).collection("segments").doc(seg.id);
        batch.set(ref, seg);
      }
      await batch.commit();
    }

    return NextResponse.json({ ok: true, nwbDatasetVersionId, segmentsGeschreven: segments.length });
  } catch (err) {
    return NextResponse.json(
      { error: "Migratie-chunk mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
