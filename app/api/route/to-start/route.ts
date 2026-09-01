import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { computeRouteWithFallback } from "@/lib/route-engine/route-to-point-fallback";
import type { LoopStartCandidate } from "@/lib/route-engine/loop-route-generator";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * POST /api/route/to-start
 * Body: { candidateNodeIds: string[], candidateDistancesM?: number[], toLogicalNodeId: string }
 * Response bij succes: { route, resolvedEdges, nodeDisplayNumbers, selectedStartNodeId,
 *   selectedStartNodeDisplayNumber, selectedCandidateRank }
 * Response bij falen: 404 { error, reason: "no_usable_candidate", candidatesAttempted }
 *
 * Sectie 6M/6N: "navigeer naar het startpunt" -- de live GPS-positie wordt
 * (client-side, in NavigationScreen) eerst geresolved naar kandidaat-
 * knooppunten via het bestaande `/api/location/resolve`, en die kandidaten
 * worden hier met dezelfde fallback-logica als de rondje-generator (sectie
 * 6B) geprobeerd totdat er een bruikbare route naar het startknooppunt
 * gevonden is.
 */
export async function POST(req: NextRequest) {
  let body: { candidateNodeIds?: string[]; candidateDistancesM?: number[]; toLogicalNodeId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { candidateNodeIds, candidateDistancesM, toLogicalNodeId } = body;
  if (!candidateNodeIds || candidateNodeIds.length === 0 || !toLogicalNodeId) {
    return NextResponse.json({ error: "candidateNodeIds en toLogicalNodeId zijn verplicht." }, { status: 400 });
  }

  const candidates: LoopStartCandidate[] = candidateNodeIds.map((logicalNodeId, i) => ({
    logicalNodeId,
    distanceM: candidateDistancesM?.[i],
  }));

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    if (!provider.getNode(toLogicalNodeId)) {
      return NextResponse.json({ error: `toLogicalNodeId '${toLogicalNodeId}' bestaat niet in dataset ${datasetVersionId}.` }, { status: 404 });
    }

    const result = computeRouteWithFallback(provider, datasetVersionId, candidates, toLogicalNodeId);

    if ("ok" in result && result.ok === false) {
      return NextResponse.json(
        { error: result.message, reason: result.reason, candidatesAttempted: result.candidatesAttempted },
        { status: 404 }
      );
    }

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: "Route-naar-startpunt-berekening mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
