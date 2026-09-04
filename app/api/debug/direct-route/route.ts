import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { computeRoute } from "@/lib/route-engine/route-engine";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * POST /api/debug/direct-route
 * Body: { fromDisplayNumber, toDisplayNumber }
 * Response: { attempts: {fromNodeId, toNodeId, result: "ok"|"failed", distanceM?, reason?}[] }
 *
 * Diagnose-tool (30-8-2026, "Hilversum doet een omweg", sectie 9.52) -- test DIRECT tussen
 * twee weergavenummers, ZONDER geocoding of kandidaat-selectie ertussen. Zoekt ALLE
 * knooppunten die het gevraagde weergavenummer hebben (er kunnen duplicaten zijn, al eerder
 * gezien bij "98"/"98" rond Volendam) en probeert ELKE combinatie -- geeft een definitief
 * antwoord of er een goede, korte verbinding bestaat tussen deze twee specifieke gebieden,
 * los van welke kandidaat een zoekopdracht toevallig zou kiezen.
 */
export async function POST(req: NextRequest) {
  let body: { fromDisplayNumber?: string; toDisplayNumber?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { fromDisplayNumber, toDisplayNumber } = body;
  if (!fromDisplayNumber || !toDisplayNumber) {
    return NextResponse.json({ error: "fromDisplayNumber en toDisplayNumber zijn verplicht." }, { status: 400 });
  }

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    const fromNodeIds = provider.getAllNodeIds().filter((id) => provider.getNode(id)?.displayNumber === fromDisplayNumber);
    const toNodeIds = provider.getAllNodeIds().filter((id) => provider.getNode(id)?.displayNumber === toDisplayNumber);

    if (fromNodeIds.length === 0 || toNodeIds.length === 0) {
      return NextResponse.json({
        error: `Weergavenummer niet gevonden: ${fromNodeIds.length === 0 ? fromDisplayNumber : toDisplayNumber}.`,
      }, { status: 404 });
    }

    const attempts: { fromNodeId: string; toNodeId: string; result: "ok" | "failed"; distanceM?: number; reason?: string }[] = [];
    for (const fromNodeId of fromNodeIds) {
      for (const toNodeId of toNodeIds) {
        const result = computeRoute(provider, datasetVersionId, fromNodeId, toNodeId);
        if ("reason" in result) {
          attempts.push({ fromNodeId, toNodeId, result: "failed", reason: result.reason });
        } else {
          attempts.push({ fromNodeId, toNodeId, result: "ok", distanceM: result.distanceM });
        }
      }
    }

    return NextResponse.json({ attempts, fromNodeIdsFound: fromNodeIds.length, toNodeIdsFound: toNodeIds.length });
  } catch (err) {
    return NextResponse.json(
      { error: "Diagnose mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
