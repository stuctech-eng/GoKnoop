import { NextRequest, NextResponse } from "next/server";
import { computeNwbClusterAssignments, type SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const CONNECTOR_SEARCH_TOLERANCE_M = 20;

/**
 * POST /api/admin/cluster-only
 * Body: { segments: SlimNwbSegment[] }
 *
 * Fase 1 van het GPT-uitvoeringsplan, 11-9-2026. GEEN Firestore-lezen, GEEN
 * dataset-opzoeken -- uitsluitend computeNwbClusterAssignments() op de
 * MEEGEGEVEN segmenten. De client haalt de segmenten apart op via het
 * al-bewezen snelle /api/admin/read-active-nwb-segments en stuurt ze hier
 * naartoe -- workload gesplitst, geen gecombineerde lezen+clusteren-timeout.
 */
export async function POST(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: { segments?: SlimNwbSegment[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }
  const segments = body.segments;
  if (!segments || !Array.isArray(segments)) {
    return NextResponse.json({ error: "segments (array) is verplicht." }, { status: 400 });
  }

  const t0 = Date.now();
  try {
    const assignments = await computeNwbClusterAssignments(segments, CONNECTOR_SEARCH_TOLERANCE_M);

    const uniqueClusterIds = new Set<string>();
    for (const a of assignments.values()) {
      uniqueClusterIds.add(a.fromClusterId);
      uniqueClusterIds.add(a.toClusterId);
    }

    // Compacte vorm teruggeven -- de client vergelijkt dit tegen de opgeslagen assignments.
    const compact: Record<string, { f: string; t: string }> = {};
    for (const [segId, a] of assignments) compact[segId] = { f: a.fromClusterId, t: a.toClusterId };

    return NextResponse.json({
      segmentCount: segments.length,
      pointCount: assignments.size * 2,
      uniqueClusterCount: uniqueClusterIds.size,
      segmentsWithClusters: assignments.size,
      segmentsWithoutClusters: segments.length - assignments.size,
      computeTimeMs: Date.now() - t0,
      assignments: compact,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Clustering mislukt.", details: err instanceof Error ? err.message : String(err), computeTimeMs: Date.now() - t0 },
      { status: 502 }
    );
  }
}
