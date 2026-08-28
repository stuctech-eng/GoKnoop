import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { calculateAlternatives } from "@/lib/route-engine/route-planner";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * POST /api/route/alternatives
 * Body: { fromLogicalNodeId, toLogicalNodeId, count?, constraints? }
 * Response: { routes: Route[], requestedCount, foundCount }
 *
 * Bouwt op de bestaande /api/route-primitive (computeRoute), verandert die
 * niet -- zie lib/route-engine/route-planner.ts.
 */

export async function POST(req: NextRequest) {
  let body: {
    fromLogicalNodeId?: string;
    toLogicalNodeId?: string;
    count?: number;
    constraints?: { avoidNodeIds?: string[]; avoidEdgeIds?: string[] };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { fromLogicalNodeId, toLogicalNodeId, count = 4, constraints = {} } = body;
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
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    if (!provider.getNode(fromLogicalNodeId)) {
      return NextResponse.json(
        { error: `fromLogicalNodeId '${fromLogicalNodeId}' bestaat niet.` },
        { status: 404 }
      );
    }
    if (!provider.getNode(toLogicalNodeId)) {
      return NextResponse.json({ error: `toLogicalNodeId '${toLogicalNodeId}' bestaat niet.` }, { status: 404 });
    }

    const result = calculateAlternatives(provider, datasetVersionId, fromLogicalNodeId, toLogicalNodeId, {
      count,
      baseConstraints: constraints,
    });

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: "Alternatieven-berekening mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
