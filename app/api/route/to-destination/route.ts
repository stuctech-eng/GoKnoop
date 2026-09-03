import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { computeRouteBetweenCandidatesWithFallback } from "@/lib/route-engine/route-between-candidates";
import { rdToWgs84 } from "@/lib/route-engine/coordinate-transform";
import { LocalBikeRouter } from "@/lib/local-bike-router/local-bike-router";
import { OpenRouteServiceAdapter } from "@/lib/local-bike-router/open-route-service-adapter";
import type { LoopStartCandidate } from "@/lib/route-engine/loop-route-generator";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * POST /api/route/to-destination
 * Body: { originCandidateNodeIds, originCandidateDistancesM?,
 *         destinationCandidateNodeIds, destinationCandidateDistancesM?,
 *         destinationLat, destinationLon }
 * Response bij succes: { knotLeg: {...}, lastMileLeg: {...} }
 * Response bij falen: { error, reason, leg: "knot" | "lastMile" }
 *
 * "Route naar een adres" (sectie 9.21, 30-8-2026) -- zelfde drieledige opbouw als Back to
 * Start (sectie 9.18), nu voor een willekeurige bestemming i.p.v. terug naar de
 * parkeerplaats:
 *
 *   herkomst (GPS)         -- LocalBikeRouter -- automatisch via fase A van elke sessie
 *   dichtstbijzijnde knooppunt bij herkomst
 *         ↓ KnotRouteEngine, MET fallback aan BEIDE kanten (dit endpoint)
 *   dichtstbijzijnde knooppunt bij bestemming
 *         ↓ LocalBikeRouter (dit endpoint, lastMileLeg)
 *   exact adres
 *
 * Het eerste stukje (herkomst -> eerste knooppunt) hoeft dit endpoint niet zelf te
 * berekenen -- dat doet `fetchRouteToStart()` in NavigationScreen.tsx al automatisch voor
 * ELKE route, zodra de knotLeg als actieve route wordt gebruikt.
 */
export async function POST(req: NextRequest) {
  let body: {
    originCandidateNodeIds?: string[];
    originCandidateDistancesM?: number[];
    destinationCandidateNodeIds?: string[];
    destinationCandidateDistancesM?: number[];
    destinationLat?: number;
    destinationLon?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const {
    originCandidateNodeIds,
    originCandidateDistancesM,
    destinationCandidateNodeIds,
    destinationCandidateDistancesM,
    destinationLat,
    destinationLon,
  } = body;

  if (
    !originCandidateNodeIds ||
    originCandidateNodeIds.length === 0 ||
    !destinationCandidateNodeIds ||
    destinationCandidateNodeIds.length === 0 ||
    destinationLat === undefined ||
    destinationLon === undefined
  ) {
    return NextResponse.json(
      { error: "originCandidateNodeIds, destinationCandidateNodeIds en destinationLat/destinationLon zijn verplicht." },
      { status: 400 }
    );
  }

  const fromCandidates: LoopStartCandidate[] = originCandidateNodeIds.map((logicalNodeId, i) => ({
    logicalNodeId,
    distanceM: originCandidateDistancesM?.[i],
  }));
  const toCandidates: LoopStartCandidate[] = destinationCandidateNodeIds.map((logicalNodeId, i) => ({
    logicalNodeId,
    distanceM: destinationCandidateDistancesM?.[i],
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

    // Been 1 (Layer A, beide kanten met fallback): herkomst-knooppunt -> bestemmings-knooppunt.
    const knotResult = computeRouteBetweenCandidatesWithFallback(provider, datasetVersionId, fromCandidates, toCandidates);
    if ("ok" in knotResult) {
      return NextResponse.json({ error: knotResult.message, reason: knotResult.reason, leg: "knot" }, { status: 404 });
    }

    // Been 2 (Layer B): bestemmings-knooppunt -> exact adres.
    const destinationNode = provider.getNode(knotResult.selectedDestinationNodeId)!;
    const destinationNodeWgs84 = rdToWgs84(destinationNode.x, destinationNode.y);
    const router = new LocalBikeRouter(new OpenRouteServiceAdapter());
    const lastMileResult = await router.route(destinationNodeWgs84, { lat: destinationLat, lon: destinationLon }, "cycling");

    if ("reason" in lastMileResult) {
      return NextResponse.json({ error: lastMileResult.message, reason: lastMileResult.reason, leg: "lastMile" }, { status: 502 });
    }

    return NextResponse.json({ knotLeg: knotResult, lastMileLeg: lastMileResult });
  } catch (err) {
    return NextResponse.json(
      { error: "Route-naar-bestemming-berekening mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
