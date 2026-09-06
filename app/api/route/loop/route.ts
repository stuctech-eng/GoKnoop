import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { generateLoopRoutes } from "@/lib/route-engine/loop-route-generator";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * POST /api/route/loop
 * Body: { startLogicalNodeId, targetDistanceM, count? }
 * Response: LoopGenerationResult (zie loop-route-generator.ts)
 *
 * Concrete invulling van Master Plan sectie 74/90: "Hoe ver? -> 20/30/40/50km
 * -> meerdere routevoorstellen" -- geen bekend eindpunt vooraf.
 */

export async function POST(req: NextRequest) {
  let body: { startLogicalNodeId?: string; targetDistanceM?: number; count?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { startLogicalNodeId, targetDistanceM, count = 4 } = body;
  if (!startLogicalNodeId || !targetDistanceM) {
    return NextResponse.json(
      { error: "startLogicalNodeId en targetDistanceM zijn verplicht." },
      { status: 400 }
    );
  }
  if (targetDistanceM <= 0) {
    return NextResponse.json({ error: "targetDistanceM moet groter dan 0 zijn." }, { status: 400 });
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

    if (!provider.getNode(startLogicalNodeId)) {
      return NextResponse.json(
        { error: `startLogicalNodeId '${startLogicalNodeId}' bestaat niet.` },
        { status: 404 }
      );
    }

    const result = generateLoopRoutes(provider, datasetVersionId, startLogicalNodeId, targetDistanceM, {
      count,
    });

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: "Rondje-generatie mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
