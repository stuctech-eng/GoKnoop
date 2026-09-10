import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import type { SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

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
 * FASE M6/M7 (opslagformaat-fix), 10-9-2026: live productiemeting toonde dat
 * ~144k LOSSE segment-documenten alleen al ~29s zouden kosten om terug te
 * lezen (ruim boven de 10s-productielimiet, bevestigd met een echte 504
 * FUNCTION_INVOCATION_TIMEOUT). Elke binnenkomende chunk wordt nu als ÉÉN
 * GEBATCHT document weggeschreven (`batches/{batchIndex}`, bevat een array
 * van alle segmenten in die chunk), niet als N losse documenten -- bij een
 * chunkgrootte van 400 betekent dit ~360 documenten i.p.v. 144.000 voor de
 * volledige dataset.
 *
 * Body per aanroep (herhaald aangeroepen door de client, zelfde gepagineerde
 * patroon als de onderzoeksfase):
 *   { nwbDatasetVersionId, segments: SlimNwbSegment[], batchIndex, isFirstChunk, metadata? }
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
    batchIndex?: number;
    isFirstChunk?: boolean;
    metadata?: { bron: string; licentie: string; regios: string[]; opgehaaldOp: string };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { nwbDatasetVersionId, segments, batchIndex, isFirstChunk, metadata } = body;
  if (!nwbDatasetVersionId || !segments || batchIndex === undefined) {
    return NextResponse.json({ error: "nwbDatasetVersionId, segments en batchIndex zijn verplicht." }, { status: 400 });
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
          opslagformaat: "gebatcht (batches/{n}, ~400-500 segmenten per document) -- Fase M6/M7-fix, 10-9-2026",
        });
    }

    // ÉÉN document voor deze hele chunk, geen losse documenten per segment.
    await db.collection("nwbSegments").doc(nwbDatasetVersionId).collection("batches").doc(String(batchIndex)).set({ segments });

    return NextResponse.json({ ok: true, nwbDatasetVersionId, batchIndex, segmentsGeschreven: segments.length });
  } catch (err) {
    return NextResponse.json(
      { error: "Migratie-chunk mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
