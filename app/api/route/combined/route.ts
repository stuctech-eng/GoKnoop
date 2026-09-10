import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { computeCombinedRoute } from "@/lib/route-engine/combined-route-engine";
import { loadCachedNwbData } from "@/lib/route-engine/cached-nwb-provider";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * POST /api/route/combined
 *
 * Fase G/H/I, 9-9-2026 -- NIEUW, APART eindpunt. De bestaande /api/route
 * (route-engine.ts, plain Dijkstra) is hierdoor GEEN BYTE gewijzigd en blijft
 * exact het huidige productiegedrag geven.
 *
 * Body: { fromLogicalNodeId, toLogicalNodeId }
 *
 * Degradeert VEILIG naar GoKnoop-only gedrag als config/activeNwbDataset nog
 * niet bestaat (het Fase F-schema is een ONTWERP, nog niet gevuld met echte
 * productiedata) -- dit endpoint kan dus zonder risico gedeployed worden
 * vóórdat de daadwerkelijke NWB-dataverzameling in productie draait.
 *
 * BEKENDE BEPERKING: `geometryAvailable.nwb` is altijd `false` -- zie
 * docs/ROUTING-IMPROVEMENT-MASTER.md. Dit endpoint levert een correcte
 * afstand/samenstelling/kwaliteitsoordeel, nog geen volledig navigeerbare
 * geometrie voor het NWB-deel van een route.
 */
export async function POST(req: NextRequest) {
  let body: { fromLogicalNodeId?: string; toLogicalNodeId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { fromLogicalNodeId, toLogicalNodeId } = body;
  if (!fromLogicalNodeId || !toLogicalNodeId) {
    return NextResponse.json({ error: "fromLogicalNodeId en toLogicalNodeId zijn verplicht." }, { status: 400 });
  }

  try {
    const db = getDb();

    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd (config/activeDataset ontbreekt)." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    if (!provider.getNode(fromLogicalNodeId)) {
      return NextResponse.json({ error: `fromLogicalNodeId '${fromLogicalNodeId}' bestaat niet in dataset ${datasetVersionId}.` }, { status: 404 });
    }
    if (!provider.getNode(toLogicalNodeId)) {
      return NextResponse.json({ error: `toLogicalNodeId '${toLogicalNodeId}' bestaat niet in dataset ${datasetVersionId}.` }, { status: 404 });
    }

    // NWB-data laden -- NU MET CACHING (Fase K), zelfde patroon als CachedGraphProvider.
    // Veilige degradatie blijft: als er geen actieve NWB-dataset is, geeft dit lege lijsten.
    const nwbData = await loadCachedNwbData(datasetVersionId);
    const { nwbDatasetVersionId, segments: nwbSegments, connectors: validatedConnectors } = nwbData;

    const result = computeCombinedRoute(provider, nwbSegments, validatedConnectors, fromLogicalNodeId, toLogicalNodeId);

    if (!result.ok) {
      const status = result.reason === "node_not_found" ? 404 : 422;
      return NextResponse.json({ error: result.message, reason: result.reason, quality: result.quality }, { status });
    }

    return NextResponse.json({
      ...result,
      datasetVersionId,
      nwbDatasetVersionId,
      nwbActief: nwbDatasetVersionId !== null,
      nwbCacheHit: nwbData.cacheHit,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Gecombineerde route-berekening mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
