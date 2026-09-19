import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { loadPrecomputedOrBuildGraph } from "@/lib/route-engine/load-precomputed-graph";
import { dijkstraWithCostModel, makeCostFn } from "@/lib/nwb-analysis/combined-graph";
import { F_NWB_PRODUCTION, F_CONNECTOR_PRODUCTION } from "@/lib/route-engine/combined-route-engine";
import { buildCombinedRouteGeometry } from "@/lib/route-engine/combined-route-geometry";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * TOEGEVOEGD 19-9-2026 (GO van Te, vervolg op de bewezen distance-invariant-
 * bevinding, decisions-and-calibration.md). Roept UITSLUITEND bestaande,
 * ongewijzigde functies aan -- `dijkstraWithCostModel` en
 * `buildCombinedRouteGeometry`, EXACT dezelfde twee aanroepen die
 * `computeCombinedRouteAsRoute` zelf intern al doet (zie combined-route-
 * engine.ts) -- met dezelfde `effectiveProvider` als productie. Geen nieuwe
 * routinglogica: dit legt alleen, per hop, de graaf-opgeslagen `distanceM`
 * (`graph.adjacency`, wat Dijkstra daadwerkelijk gebruikte) naast de
 * geometrie-opgeloste `distanceM` (`buildCombinedRouteGeometry`'s
 * `edges[i].distanceM`, live opnieuw berekend uit de opgehaalde polylijn)
 * -- puur ter observatie, om de eerder gevonden +36 tot +65m-afwijking te
 * lokaliseren tot de veroorzakende hop(s).
 *
 * GET /api/admin/diagnose-edge-breakdown?key=<DEBUG_SECRET>&from=<nodeId>&to=<nodeId>
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const fromNodeId = req.nextUrl.searchParams.get("from");
  const toNodeId = req.nextUrl.searchParams.get("to");
  if (!fromNodeId || !toNodeId) {
    return NextResponse.json({ error: "Queryparameters 'from' en 'to' zijn verplicht (één node-ID elk)." }, { status: 400 });
  }

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    // Exact hetzelfde laadpad als /api/route/to-destination.
    const provider = new CachedGraphProvider(datasetVersionId);
    const providerLoadPromise = provider.load();
    const graphLoadPromise = loadPrecomputedOrBuildGraph(provider, datasetVersionId, providerLoadPromise);
    await providerLoadPromise;
    const { graph, cacheHit, graphSource, bridgesPresent, effectiveProvider } = await graphLoadPromise;

    // Aanroep 1: EXACT dezelfde Dijkstra-aanroep als computeCombinedRouteAsRoute.
    const dijkstraResult = dijkstraWithCostModel(graph, fromNodeId, toNodeId, makeCostFn(F_NWB_PRODUCTION, F_CONNECTOR_PRODUCTION));
    if (!dijkstraResult.found) {
      return NextResponse.json({ error: "Geen route gevonden (disconnected).", datasetVersionId, graphSource, bridgesPresent }, { status: 404 });
    }

    // Aanroep 2: EXACT dezelfde geometrie-opbouw als computeCombinedRouteAsRoute.
    const geometryResult = await buildCombinedRouteGeometry(dijkstraResult.steps, graph, effectiveProvider);
    if (!geometryResult.ok) {
      return NextResponse.json({ error: "Geometrie-opbouw mislukt.", reason: geometryResult.reason, datasetVersionId, graphSource, bridgesPresent }, { status: 502 });
    }

    // Per hop: graaf-opgeslagen distanceM (waar Dijkstra op koos) opzoeken in graph.adjacency,
    // naast de geometrie-opgeloste distanceM (geometryResult.edges, zelfde volgorde/index).
    const hops: Record<string, unknown>[] = [];
    let sumGraphDistanceM = 0;
    let sumGeometryDistanceM = 0;

    for (let i = 1; i < dijkstraResult.steps.length; i++) {
      const fromStep = dijkstraResult.steps[i - 1];
      const toStep = dijkstraResult.steps[i];
      const geometryEdge = geometryResult.edges[i - 1];

      const candidateEdges = graph.adjacency.get(fromStep.nodeId) ?? [];
      const matchingGraphEdge = candidateEdges.find((e) => e.to === toStep.nodeId && e.source === toStep.edgeSource);

      const graphDistanceM = matchingGraphEdge?.distanceM ?? null;
      const geometryDistanceM = geometryEdge?.distanceM ?? null;
      const diffM = graphDistanceM !== null && geometryDistanceM !== null ? geometryDistanceM - graphDistanceM : null;

      if (graphDistanceM !== null) sumGraphDistanceM += graphDistanceM;
      if (geometryDistanceM !== null) sumGeometryDistanceM += geometryDistanceM;

      hops.push({
        hopIndex: i,
        fromNode: fromStep.nodeId,
        toNode: toStep.nodeId,
        edgeSource: toStep.edgeSource,
        nwbSegmentId: toStep.nwbSegmentId ?? null,
        edgeId: geometryEdge?.id ?? null,
        graphAdjacencyMatchFound: !!matchingGraphEdge,
        graphDistanceM,
        geometryDistanceM,
        diffM,
      });
    }

    return NextResponse.json({
      datasetVersionId,
      graphCacheHit: cacheHit,
      graphSource,
      bridgesPresent,
      fromNodeId,
      toNodeId,
      dijkstraTotalDistanceM: dijkstraResult.distanceM,
      sumGraphDistanceM,
      sumGeometryDistanceM,
      totalDiffM: sumGeometryDistanceM - sumGraphDistanceM,
      hopCount: hops.length,
      hops,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Diagnose mislukt.", details: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
      { status: 502 }
    );
  }
}
