import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { computeRoute } from "@/lib/route-engine/route-engine";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * POST /api/route
 *
 * Body: { fromLogicalNodeId, toLogicalNodeId, constraints?: { avoidNodeIds?, avoidEdgeIds? } }
 *
 * Contract: docs/phase2-route-engine-design.md sectie 7.
 * Graph-loadingstrategie: CachedGraphProvider (optie B), benchmark-onderbouwd
 * gekozen (sectie 4) -- warme aanvraag ~29ms, koude aanvraag ~6,5s.
 * - 404: fromLogicalNodeId/toLogicalNodeId bestaat niet in de actieve dataset
 * - 422: geen route mogelijk, met machineleesbare reason
 * - 200: Route-object
 */

export async function POST(req: NextRequest) {
  let body: {
    fromLogicalNodeId?: string;
    toLogicalNodeId?: string;
    constraints?: { avoidNodeIds?: string[]; avoidEdgeIds?: string[] };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { fromLogicalNodeId, toLogicalNodeId, constraints = {} } = body;
  if (!fromLogicalNodeId || !toLogicalNodeId) {
    return NextResponse.json(
      { error: "fromLogicalNodeId en toLogicalNodeId zijn verplicht." },
      { status: 400 }
    );
  }

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json(
        { error: "Geen actieve dataset geconfigureerd (config/activeDataset ontbreekt)." },
        { status: 500 }
      );
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    if (!provider.getNode(fromLogicalNodeId)) {
      return NextResponse.json(
        { error: `fromLogicalNodeId '${fromLogicalNodeId}' bestaat niet in dataset ${datasetVersionId}.` },
        { status: 404 }
      );
    }
    if (!provider.getNode(toLogicalNodeId)) {
      return NextResponse.json(
        { error: `toLogicalNodeId '${toLogicalNodeId}' bestaat niet in dataset ${datasetVersionId}.` },
        { status: 404 }
      );
    }

    const result = computeRoute(provider, datasetVersionId, fromLogicalNodeId, toLogicalNodeId, constraints);

    if ("reason" in result) {
      return NextResponse.json(
        { error: result.message, reason: result.reason },
        { status: 422 }
      );
    }

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: "Route-berekening mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
