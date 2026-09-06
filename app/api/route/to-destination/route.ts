import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { computeRouteBetweenCandidatesWithFallback } from "@/lib/route-engine/route-between-candidates";
import { resolveNearestNodes } from "@/lib/route-engine/location-resolver";
import { combineRouteLegs } from "@/lib/route-engine/combine-route-legs";
import { computeDetourOffsetPoint } from "@/lib/route-engine/detour-waypoint";
import { rdToWgs84, wgs84ToRd } from "@/lib/route-engine/coordinate-transform";
import { LocalBikeRouter } from "@/lib/local-bike-router/local-bike-router";
import { OpenRouteServiceAdapter } from "@/lib/local-bike-router/open-route-service-adapter";
import type { LoopStartCandidate } from "@/lib/route-engine/loop-route-generator";

export const maxDuration = 10; // Vercel Hobby-plan kapt hoe dan ook af bij 10s.
export const dynamic = "force-dynamic";

/**
 * POST /api/route/to-destination
 * Body: { originCandidateNodeIds, originCandidateDistancesM?,
 *         destinationCandidateNodeIds, destinationCandidateDistancesM?,
 *         destinationLat, destinationLon, extraM? }
 * Response bij succes: { knotLeg: {...}, lastMileLeg: {...}, actualExtraM? }
 * Response bij falen: { error, reason, leg: "knot" | "lastMile" }
 *
 * "Route naar een adres" (sectie 9.21) + "Plus lusje" (sectie 9.49, 30-8-2026, op verzoek):
 * `extraM` optioneel -- als aanwezig (>0), wordt geprobeerd een TUSSENPUNT te vinden dat
 * ongeveer die extra afstand toevoegt (herkomst -> tussenpunt -> bestemming, i.p.v. de
 * kortste directe route). Puur additief -- zonder `extraM` (of als er geen bruikbare
 * omweg-kandidaat gevonden wordt) blijft het gedrag exact zoals voorheen: de kortste route.
 *
 * Rekenkundig licht gehouden (op verzoek, ná de eerdere Vercel-Hobby-10s-lessen, sectie
 * 9.43-9.48): maximaal 3 kandidaat-tussenpunten per kant (links/rechts), dus maximaal 6
 * kandidaten * 2 Dijkstra-benen = 12 extra berekeningen, ruim binnen budget op de al
 * ingeladen, gecachte graaf.
 */
export async function POST(req: NextRequest) {
  let body: {
    originCandidateNodeIds?: string[];
    originCandidateDistancesM?: number[];
    destinationCandidateNodeIds?: string[];
    destinationCandidateDistancesM?: number[];
    destinationLat?: number;
    destinationLon?: number;
    extraM?: number;
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
    extraM,
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
    let knotResult = computeRouteBetweenCandidatesWithFallback(provider, datasetVersionId, fromCandidates, toCandidates);
    if ("ok" in knotResult) {
      return NextResponse.json({ error: knotResult.message, reason: knotResult.reason, leg: "knot" }, { status: 404 });
    }

    let actualExtraM: number | undefined;

    // "Plus lusje" (sectie 9.49): probeer een omweg-tussenpunt te vinden, alleen als gevraagd.
    if (extraM && extraM > 0) {
      const originNode = provider.getNode(knotResult.selectedStartNodeId);
      if (originNode) {
        const originPoint = { x: originNode.x, y: originNode.y };
        const destinationRd = wgs84ToRd(destinationLat, destinationLon);
        const targetTotalM = knotResult.route.distanceM + extraM;

        let bestDiff = Infinity;
        let bestKnotResult: typeof knotResult | null = null;

        for (const side of ["left", "right"] as const) {
          const offsetPoint = computeDetourOffsetPoint(originPoint, destinationRd, extraM, side);
          const waypointCandidates = resolveNearestNodes(provider, offsetPoint, 3);

          for (const wp of waypointCandidates) {
            const leg1 = computeRouteBetweenCandidatesWithFallback(provider, datasetVersionId, fromCandidates, [
              { logicalNodeId: wp.logicalNodeId, distanceM: wp.distanceM },
            ]);
            if ("ok" in leg1) continue;

            const leg2 = computeRouteBetweenCandidatesWithFallback(
              provider,
              datasetVersionId,
              [{ logicalNodeId: leg1.selectedDestinationNodeId, distanceM: 0 }],
              toCandidates
            );
            if ("ok" in leg2) continue;

            const combined = combineRouteLegs(leg1, leg2);
            const diff = Math.abs(combined.route.distanceM - targetTotalM);
            if (diff < bestDiff) {
              bestDiff = diff;
              bestKnotResult = {
                ...combined,
                selectedStartNodeId: leg1.selectedStartNodeId,
                selectedStartNodeDisplayNumber: leg1.selectedStartNodeDisplayNumber,
                selectedCandidateRank: leg1.selectedCandidateRank,
                selectedDestinationNodeId: leg2.selectedDestinationNodeId,
                selectedDestinationNodeDisplayNumber: leg2.selectedDestinationNodeDisplayNumber,
                selectedDestinationCandidateRank: leg2.selectedDestinationCandidateRank,
              };
            }
          }
        }

        // Alleen overschakelen als er daadwerkelijk een bruikbare omweg gevonden is -- anders
        // gewoon terugvallen op de directe route (geen harde fout, geen verrassing).
        if (bestKnotResult) {
          knotResult = bestKnotResult;
          actualExtraM = bestKnotResult.route.distanceM - (targetTotalM - extraM);
        }
      }
    }

    // Been 2 (Layer B): bestemmings-knooppunt -> exact adres.
    const destinationNode = provider.getNode(knotResult.selectedDestinationNodeId)!;
    const destinationNodeWgs84 = rdToWgs84(destinationNode.x, destinationNode.y);
    const router = new LocalBikeRouter(new OpenRouteServiceAdapter());
    const lastMileResult = await router.route(destinationNodeWgs84, { lat: destinationLat, lon: destinationLon }, "cycling");

    if ("reason" in lastMileResult) {
      return NextResponse.json({ error: lastMileResult.message, reason: lastMileResult.reason, leg: "lastMile" }, { status: 502 });
    }

    return NextResponse.json({ knotLeg: knotResult, lastMileLeg: lastMileResult, actualExtraM });
  } catch (err) {
    return NextResponse.json(
      { error: "Route-naar-bestemming-berekening mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
