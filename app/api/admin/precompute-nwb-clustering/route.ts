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
 *
 * HERZIEN (2), 11-9-2026: live gemeten dat lezen (~4s) + clusteren (~4,6-5s,
 * NIET fully done binnen budget) samen al ~8,7-9,5s kosten -- GEEN ruimte
 * meer over voor het terugschrijven van 330 documenten in hetzelfde
 * endpoint. Dit endpoint doet daarom NU ALLEEN lezen + clusteren, en geeft
 * de toewijzingen terug als JSON. Het daadwerkelijke terugschrijven gebeurt
 * client-georkestreerd, in een APARTE aanvraag, via de al-bestaande,
 * bewezen `/api/admin/migrate-nwb-to-production`-schrijflogica (dezelfde
 * infrastructuur die de oorspronkelijke migratie al succesvol gebruikte) --
 * geen nieuwe, ongeteste schrijfweg nodig.
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
    for (const doc of batchesSnap.docs) {
      const data = doc.data() as { segments: SlimNwbSegment[] };
      allSegments.push(...data.segments);
    }
    mark("segmentenUitgepakt", { aantalSegmenten: allSegments.length });

    const assignments = await computeNwbClusterAssignments(allSegments, CONNECTOR_SEARCH_TOLERANCE_M, (label, extra) =>
      reportProgress("latest", `precompute-clustering: ${label}`, extra)
    );
    mark("clusteringKlaar", { aantalToewijzingen: assignments.size });

    // Compacte vorm: alleen segmentId + de twee cluster-ID's -- niet de volledige
    // segmenten (die heeft de client al, via read-active-nwb-segments).
    const compactAssignments: Record<string, { f: string; t: string }> = {};
    for (const [segId, a] of assignments) compactAssignments[segId] = { f: a.fromClusterId, t: a.toClusterId };
    mark("compacteVormKlaar");

    return NextResponse.json({
      ok: true,
      nwbDatasetVersionId,
      aantalSegmenten: allSegments.length,
      aantalClusterToewijzingen: assignments.size,
      assignments: compactAssignments,
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
