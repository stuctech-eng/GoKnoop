import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { computeNwbClusterAssignments, type SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const CONNECTOR_SEARCH_TOLERANCE_M = 20; // zelfde waarde als cached-nwb-provider.ts

/**
 * POST /api/admin/precompute-nwb-clustering
 * Body: { nwbDatasetVersionId }
 *
 * Fase M6/M7 (structurele fix), 11-9-2026. Berekent de union-find-clustering
 * ÉÉN KEER, als aparte, eenmalige admin-actie -- niet bij elke aanvraag.
 * Schrijft de resulterende fromClusterId/toClusterId direct terug in de
 * bestaande, gebatchte segmentdocumenten (overschrijft elk batch-document
 * met dezelfde segmenten + de twee nieuwe velden).
 *
 * Live gemeten tijdsbudget (10-9-2026, 08:52): lezen ~3,2s + clustering
 * ~2,9-3,6s (229k punten) = ~6-7s. Dit endpoint doet GEEN GoKnoop-graaf-
 * opbouw, GEEN connectorverwerking, GEEN Dijkstra -- puur lezen + clusteren
 * + terugschrijven, dus de volledige 10s-marge is hiervoor beschikbaar.
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

  const t0 = Date.now();
  const timings: Record<string, number> = {};

  try {
    const db = getDb();
    const batchesRef = db.collection("nwbSegments").doc(nwbDatasetVersionId).collection("batches");
    const batchesSnap = await batchesRef.get();
    timings.batchesGelezenMs = Date.now() - t0;

    const allSegments: SlimNwbSegment[] = [];
    const segmentsByBatchDoc = new Map<string, SlimNwbSegment[]>();
    for (const doc of batchesSnap.docs) {
      const data = doc.data() as { segments: SlimNwbSegment[] };
      allSegments.push(...data.segments);
      segmentsByBatchDoc.set(doc.id, data.segments);
    }
    timings.segmentenUitgepaktMs = Date.now() - t0;

    const assignments = await computeNwbClusterAssignments(allSegments, CONNECTOR_SEARCH_TOLERANCE_M);
    timings.clusteringKlaarMs = Date.now() - t0;

    // Terugschrijven: elk batch-document opnieuw opslaan met de cluster-ID's toegevoegd.
    // Individuele set()-aanroepen, parallel in groepjes -- GEEN db.batch() (eerdere
    // live "Transaction too big"-fout bij dat mechanisme, zie clear-goknoop-batched).
    const PARALLEL_GROUP_SIZE = 20;
    const batchDocIds = Array.from(segmentsByBatchDoc.keys());
    for (let i = 0; i < batchDocIds.length; i += PARALLEL_GROUP_SIZE) {
      const group = batchDocIds.slice(i, i + PARALLEL_GROUP_SIZE);
      await Promise.all(
        group.map((docId) => {
          const segs = segmentsByBatchDoc.get(docId)!;
          const updatedSegs = segs.map((s) => {
            const assignment = assignments.get(s.id);
            return assignment ? { ...s, fromClusterId: assignment.fromClusterId, toClusterId: assignment.toClusterId } : s;
          });
          return batchesRef.doc(docId).set({ segments: updatedSegs });
        })
      );
    }
    timings.terugschrijvenKlaarMs = Date.now() - t0;

    return NextResponse.json({
      ok: true,
      nwbDatasetVersionId,
      aantalSegmenten: allSegments.length,
      aantalBatchDocumenten: batchDocIds.length,
      aantalClusterToewijzingen: assignments.size,
      timings,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Precompute mislukt.", details: err instanceof Error ? err.message : String(err), timings },
      { status: 502 }
    );
  }
}
