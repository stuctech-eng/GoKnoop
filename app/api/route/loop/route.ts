import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { generateLoopRoutesWithFallback } from "@/lib/route-engine/loop-route-generator";
import type { LoopStartCandidate } from "@/lib/route-engine/loop-route-generator";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * POST /api/route/loop
 * Body: { startLogicalNodeId?, candidateNodeIds?, candidateDistancesM?, targetDistanceM, count? }
 * Response: LoopGenerationWithFallbackResult (zie loop-route-generator.ts) op succes,
 *           of { error, reason, attempts, ... } (404) als geen kandidaat werkte.
 *
 * Concrete invulling van Master Plan sectie 74/90: "Hoe ver? -> 20/30/40/50km
 * -> meerdere routevoorstellen" -- geen bekend eindpunt vooraf.
 *
 * UITGEBREID (Volendam-onderzoek 29-8-2026, additief -- `startLogicalNodeId`
 * blijft werken als vóór deze wijziging, geen breaking change): de
 * dichtstbijzijnde knooppunt-kandidaat is niet altijd een BRUIKBAAR
 * startpunt (bijv. een knooppunt op een dijk/doorgang zonder terugweg-optie
 * die de heenweg-edges vermijdt). De aanroeper kan nu `candidateNodeIds`
 * (in afstandsvolgorde, typisch de volledige `/api/location/resolve`-
 * kandidatenlijst) meegeven; deze endpoint probeert ze in die volgorde en
 * rapporteert transparant welk knooppunt daadwerkelijk gebruikt is
 * (`selectedStartNodeId`/`selectedCandidateRank`) -- nooit een stille
 * wissel zonder dat de aanroeper het kan zien.
 */

export async function POST(req: NextRequest) {
  let body: {
    startLogicalNodeId?: string;
    candidateNodeIds?: string[];
    candidateDistancesM?: number[];
    targetDistanceM?: number;
    count?: number;
    /** Edge-ID-sets van eerder gereden routes (Fase 2, 29-8-2026) -- optioneel, additief. */
    avoidRouteEdgeSets?: string[][];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { startLogicalNodeId, candidateNodeIds, candidateDistancesM, targetDistanceM, count = 4, avoidRouteEdgeSets } = body;

  const candidates: LoopStartCandidate[] =
    candidateNodeIds && candidateNodeIds.length > 0
      ? candidateNodeIds.map((logicalNodeId, i) => ({ logicalNodeId, distanceM: candidateDistancesM?.[i] }))
      : startLogicalNodeId
        ? [{ logicalNodeId: startLogicalNodeId }]
        : [];

  if (candidates.length === 0 || !targetDistanceM) {
    return NextResponse.json(
      { error: "startLogicalNodeId (of candidateNodeIds) en targetDistanceM zijn verplicht." },
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

    const result = generateLoopRoutesWithFallback(provider, datasetVersionId, candidates, targetDistanceM, {
      count,
      avoidRouteEdgeSets,
    });

    if ("ok" in result && result.ok === false) {
      return NextResponse.json(
        {
          error: result.message,
          reason: result.reason,
          candidatesAttempted: result.candidatesAttempted,
          attempts: result.attempts,
        },
        { status: 404 }
      );
    }

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: "Rondje-generatie mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
