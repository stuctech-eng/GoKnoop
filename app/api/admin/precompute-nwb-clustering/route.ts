import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { computeNwbClusterAssignments, type SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";
import { reportProgress } from "@/lib/diagnostics/report-progress";

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
 * HERZIEN, 11-9-2026: eerste versie timede live uit (10.475ms, geen JSON-
 * respons). Eerdere schatting (lezen ~3,2s + clustering ~2,9-3,6s = ~6-7s)
 * VERGAT de terugschrijf-stap (330 documenten) mee te rekenen. reportProgress
 * toegevoegd op elke stap, inclusief per schrijfgroep -- zelfde bewezen
 * patroon als test-knot-leg-isolated, om nu precies te zien welke stap
 * de tijd kost i.p.v. te gokken.
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
  function mark(label: string, extra?: Record<string, unknown>) {
    timings[label] = Date.now() - t0;
    reportProgress("latest", `precompute: ${label}`, { elapsedMs: Date.now() - t0, ...extra });
  }
  reportProgress("latest", "precompute: START", { elapsedMs: 0 });

  try {
    const db = getDb();
    const batchesRef = db.collection("nwbSegments").doc(nwbDatasetVersionId).collection("batches");
    const batchesSnap = await batchesRef.get();
    mark("batchesGelezen");

    const allSegments: SlimNwbSegment[] = [];
    const segmentsByBatchDoc = new Map<string, SlimNwbSegment[]>();
    for (const doc of batchesSnap.docs) {
      const data = doc.data() as { segments: SlimNwbSegment[] };
      allSegments.push(...data.segments);
      segmentsByBatchDoc.set(doc.id, data.segments);
    }
    mark("segmentenUitgepakt", { aantalSegmenten: allSegments.length });

    const assignments = await computeNwbClusterAssignments(allSegments, CONNECTOR_SEARCH_TOLERANCE_M, (label, extra) =>
      reportProgress("latest", `precompute-clustering: ${label}`, extra)
    );
    mark("clusteringKlaar", { aantalToewijzingen: assignments.size });

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
      mark("terugschrijven voortgang", { groepenKlaar: Math.floor(i / PARALLEL_GROUP_SIZE) + 1, totaalGroepen: Math.ceil(batchDocIds.length / PARALLEL_GROUP_SIZE) });
    }
    mark("terugschrijvenKlaar");

    return NextResponse.json({
      ok: true,
      nwbDatasetVersionId,
      aantalSegmenten: allSegments.length,
      aantalBatchDocumenten: batchDocIds.length,
      aantalClusterToewijzingen: assignments.size,
      timings,
    });
  } catch (err) {
    reportProgress("latest", "precompute: EXCEPTION", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { error: "Precompute mislukt.", details: err instanceof Error ? err.message : String(err), timings },
      { status: 502 }
    );
  }
}
