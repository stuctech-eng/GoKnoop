import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { loadPrecomputedOrBuildGraph } from "@/lib/route-engine/load-precomputed-graph";
import { computeRouteWithFallback, type RouteToPointWithFallbackResult, type RouteToPointFallbackFailure } from "@/lib/route-engine/route-to-point-fallback";
import type { LoopStartCandidate } from "@/lib/route-engine/loop-route-generator";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * TOEGEVOEGD 19-9-2026 (GO van Te, puur diagnostisch -- forensisch onderzoek
 * Volendam/Lochem/Rondje no_usable_candidate).
 *
 * GEEN NIEUWE ROUTINGLOGICA. Dit bestand herimplementeert Fase 1/Fase 2 niet --
 * het roept `loadPrecomputedOrBuildGraph` en `computeRouteWithFallback` aan,
 * EXACT dezelfde functies, met EXACT dezelfde `effectiveProvider`, als
 * `/api/route/to-destination` daadwerkelijk gebruikt. Het enige verschil met
 * productie: per bestemmingskandidaat wordt de AL BESTAANDE returnwaarde van
 * `computeRouteWithFallback` (die bij een Fase-2-falen al een `message` bevat
 * met de onderliggende `computeCombinedRouteAsRoute`-foutreden erin geweven --
 * zie route-to-point-fallback.ts regel ~134) rechtstreeks in de JSON-response
 * gezet, in plaats van alleen intern gebruikt te worden voor de generieke
 * `no_usable_candidate`-aggregatie. Dit omzeilt bewust de fire-and-forget
 * `reportProgress`-logging (zie decisions-and-calibration.md, 19-9-2026) --
 * de informatie stond namelijk al in de bestaande returnwaarde, alleen nooit
 * zichtbaar gemaakt aan de aanroeper.
 *
 * `phase1`/`phase2`-onderverdeling hieronder is PUUR INTERPRETATIE van de
 * bestaande, ongewijzigde `message`-tekst (zie `classifyFailure()`) -- geen
 * wijziging aan wat de route-engine zelf teruggeeft of beslist.
 *
 * POST /api/admin/diagnose-candidate-phases?key=<DEBUG_SECRET>
 * Body: { originCandidateNodeIds: string[], destinationCandidateNodeIds: string[] }
 */

type CandidateDiagnostic = {
  index: number;
  toNode: string;
  phase1: { succeeded: boolean };
  phase2: { started: boolean; succeeded: boolean | null; reason: string | null };
  final: { accepted: boolean; reason: string | null };
  distanceM?: number;
  selectedStartNodeId?: string;
  selectedCandidateRank?: number;
  elapsedMs: number;
  exception?: { message: string; stack?: string };
};

// Zuiver classificerend, geen gedragswijziging -- leest alleen de bestaande
// `message`-tekst die route-to-point-fallback.ts al teruggeeft.
function classifyFailure(message: string): { phase1Succeeded: boolean; phase2Started: boolean; phase2Reason: string | null } {
  if (message.startsWith("Geen van de") && message.includes("kandidaat-knooppunten")) {
    // Fase 1 zelf vond geen winnaar voor deze bestemmingskandidaat.
    return { phase1Succeeded: false, phase2Started: false, phase2Reason: null };
  }
  if (message.startsWith("Winnende kandidaat leverde bij geometrie-opbouw")) {
    // Fase 1 vond een winnaar; Fase 2 (computeCombinedRouteAsRoute) faalde alsnog.
    return { phase1Succeeded: true, phase2Started: true, phase2Reason: message };
  }
  // Onbekend/nieuw formaat -- niet aannemen, expliciet als zodanig markeren.
  return { phase1Succeeded: false, phase2Started: false, phase2Reason: null };
}

export async function POST(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: { originCandidateNodeIds?: string[]; destinationCandidateNodeIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }
  const { originCandidateNodeIds, destinationCandidateNodeIds } = body;
  if (!originCandidateNodeIds?.length || !destinationCandidateNodeIds?.length) {
    return NextResponse.json({ error: "originCandidateNodeIds en destinationCandidateNodeIds zijn verplicht." }, { status: 400 });
  }

  const fromCandidates: LoopStartCandidate[] = originCandidateNodeIds.map((logicalNodeId) => ({ logicalNodeId }));

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    // Exact hetzelfde laadpad als /api/route/to-destination -- geen eigen variant.
    const provider = new CachedGraphProvider(datasetVersionId);
    const providerLoadPromise = provider.load();
    const graphLoadPromise = loadPrecomputedOrBuildGraph(provider, datasetVersionId, providerLoadPromise);
    await providerLoadPromise;
    const { graph, cacheHit, graphSource, bridgesPresent, effectiveProvider } = await graphLoadPromise;

    const candidates: CandidateDiagnostic[] = [];
    let winnerIndex = -1;
    let winnerDistanceM = Infinity;

    for (let i = 0; i < destinationCandidateNodeIds.length; i++) {
      const toNodeId = destinationCandidateNodeIds[i];
      const tStart = Date.now();

      let result: RouteToPointWithFallbackResult | RouteToPointFallbackFailure | undefined;
      let exception: { message: string; stack?: string } | undefined;
      try {
        // DE ECHTE PRODUCTIEFUNCTIE, ongewijzigd, met de echte effectiveProvider.
        result = await computeRouteWithFallback(effectiveProvider, datasetVersionId, graph, fromCandidates, toNodeId);
      } catch (err) {
        exception = { message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined };
      }
      const elapsedMs = Date.now() - tStart;

      if (exception) {
        candidates.push({
          index: i,
          toNode: toNodeId,
          phase1: { succeeded: false },
          phase2: { started: false, succeeded: null, reason: null },
          final: { accepted: false, reason: null },
          elapsedMs,
          exception,
        });
        continue;
      }

      if (result && "ok" in result) {
        // RouteToPointFallbackFailure -- message bevat al de onderliggende reden (zie classifyFailure).
        const classified = classifyFailure(result.message);
        candidates.push({
          index: i,
          toNode: toNodeId,
          phase1: { succeeded: classified.phase1Succeeded },
          phase2: { started: classified.phase2Started, succeeded: classified.phase2Started ? false : null, reason: classified.phase2Reason },
          final: { accepted: false, reason: result.message },
          elapsedMs,
        });
        continue;
      }

      if (result) {
        // RouteToPointWithFallbackResult -- Fase 1 en Fase 2 beide geslaagd voor deze bestemmingskandidaat.
        candidates.push({
          index: i,
          toNode: toNodeId,
          phase1: { succeeded: true },
          phase2: { started: true, succeeded: true, reason: null },
          final: { accepted: true, reason: null },
          distanceM: result.route.distanceM,
          selectedStartNodeId: result.selectedStartNodeId,
          selectedCandidateRank: result.selectedCandidateRank,
          elapsedMs,
        });
        if (result.route.distanceM < winnerDistanceM) {
          winnerDistanceM = result.route.distanceM;
          winnerIndex = i;
        }
        continue;
      }

      // Zou niet moeten gebeuren (geen result, geen exceptie) -- expliciet zichtbaar i.p.v. stil genegeerd.
      candidates.push({
        index: i,
        toNode: toNodeId,
        phase1: { succeeded: false },
        phase2: { started: false, succeeded: null, reason: null },
        final: { accepted: false, reason: "Geen resultaat en geen exceptie -- onverwacht." },
        elapsedMs,
      });
    }

    return NextResponse.json({
      provider: "effectiveProvider (bridge-augmented, identiek aan productie)",
      graphSource,
      graphCacheHit: cacheHit,
      bridgesPresent,
      allPrecomputed: graph.allPrecomputed,
      clusterCount: graph.clusterCount,
      candidates,
      winner: winnerIndex === -1 ? null : { index: winnerIndex, toNode: destinationCandidateNodeIds[winnerIndex], distanceM: winnerDistanceM },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Diagnose mislukt.", details: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
      { status: 502 }
    );
  }
}
