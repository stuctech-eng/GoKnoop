import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { computeRouteWithFallback } from "@/lib/route-engine/route-to-point-fallback";
import { rdToWgs84 } from "@/lib/route-engine/coordinate-transform";
import { LocalBikeRouter } from "@/lib/local-bike-router/local-bike-router";
import { OpenRouteServiceAdapter } from "@/lib/local-bike-router/open-route-service-adapter";
import type { LoopStartCandidate } from "@/lib/route-engine/loop-route-generator";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * POST /api/route/back-to-start
 * Body: { candidateNodeIds: string[], candidateDistancesM?: number[],
 *         routeStartNodeId: string, physicalStart: {lat, lon} }
 * Response bij succes: { knotLeg: {...}, lastMileLeg: {...} }
 * Response bij falen: { error, reason, leg: "knot" | "lastMile" }
 *
 * FASE 5 (GOKNOOP-MASTER.md sectie 9.18, 30-8-2026): "Back to Start" vanuit
 * het MIDDEN van de route (sectie 9.5's vereenvoudiging, al eerder
 * doordacht): eerst via de BESTAANDE Layer A (knooppunt-naar-knooppunt,
 * `computeRouteWithFallback` -- exact dezelfde fallback als Fase 4 al
 * gebruikte vóórdat die vervangen werd door LocalBikeRouter) terug naar het
 * startknooppunt van de route. Layer B (`LocalBikeRouter`) is UITSLUITEND
 * nodig voor het allerlaatste stukje: startknooppunt → parkeerplaats.
 *
 * Beide stukken worden hier in ÉÉN serveraanroep berekend (i.p.v. twee
 * losse client-aanroepen) -- "zo weinig mogelijk requests", sectie 9.6.
 *
 * Geen wijziging aan `lib/route-engine/` (harde eis, herbevestigd elke
 * fase): dit endpoint importeert er wel uit (`computeRouteWithFallback`,
 * `CachedGraphProvider`) maar wijzigt niets, puur hergebruik.
 */
export async function POST(req: NextRequest) {
  let body: {
    candidateNodeIds?: string[];
    candidateDistancesM?: number[];
    routeStartNodeId?: string;
    physicalStart?: { lat: number; lon: number };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { candidateNodeIds, candidateDistancesM, routeStartNodeId, physicalStart } = body;
  if (!candidateNodeIds || candidateNodeIds.length === 0 || !routeStartNodeId || !physicalStart) {
    return NextResponse.json(
      { error: "candidateNodeIds, routeStartNodeId en physicalStart zijn verplicht." },
      { status: 400 }
    );
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

    if (!provider.getNode(routeStartNodeId)) {
      return NextResponse.json({ error: `routeStartNodeId '${routeStartNodeId}' bestaat niet.` }, { status: 404 });
    }

    // Been 1 (Layer A): huidige positie -> startknooppunt, via het knooppuntennetwerk zelf.
    const knotResult = computeRouteWithFallback(provider, datasetVersionId, candidates, routeStartNodeId);
    if ("ok" in knotResult) {
      return NextResponse.json({ error: knotResult.message, reason: knotResult.reason, leg: "knot" }, { status: 404 });
    }

    // Been 2 (Layer B): startknooppunt -> parkeerplaats, via LocalBikeRouter/straten.
    const startNode = provider.getNode(routeStartNodeId)!;
    const startNodeWgs84 = rdToWgs84(startNode.x, startNode.y);
    const router = new LocalBikeRouter(new OpenRouteServiceAdapter());
    const lastMileResult = await router.route(startNodeWgs84, physicalStart, "cycling");

    if ("reason" in lastMileResult) {
      return NextResponse.json({ error: lastMileResult.message, reason: lastMileResult.reason, leg: "lastMile" }, { status: 502 });
    }

    return NextResponse.json({ knotLeg: knotResult, lastMileLeg: lastMileResult });
  } catch (err) {
    return NextResponse.json(
      { error: "Back to Start-berekening mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
