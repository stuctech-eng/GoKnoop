import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { computeRoute } from "@/lib/route-engine/route-engine";
import { resolveRouteEdges } from "@/lib/route-engine/resolve-route-edges";
import { fetchGoknoopEdgeGeometry } from "@/lib/route-engine/fetch-goknoop-edge-geometry";
import { concatenateGeometry } from "@/lib/route-engine/route-builder";

export const maxDuration = 10; // GECORRIGEERD 13-9-2026 (Fase 2A-audit): stond op 60, maar Vercel Hobby kapt hoe dan ook af bij 10s -- elders in de codebase consequent op 10 gezet met exact deze reden, hier gemist. Geen gedragswijziging, alleen de misleidende waarde weg.
export const dynamic = "force-dynamic";

/**
 * POST /api/route
 *
 * Body: { fromLogicalNodeId, toLogicalNodeId, constraints?: { avoidNodeIds?, avoidEdgeIds? } }
 *
 * Contract: docs/phase2-route-engine-design.md sectie 7.
 * Graph-loadingstrategie: CachedGraphProvider (optie B), benchmark-onderbouwd
 * gekozen (sectie 4) -- warme aanvraag ~29ms, koude aanvraag ~6,5s.
 * - 404: fromLogicalNodeId/toLogicalNodeId bestaat niet in de actieve dataset
 * - 422: geen route mogelijk, met machineleesbare reason
 * - 200: Route-object
 */

export async function POST(req: NextRequest) {
  let body: {
    fromLogicalNodeId?: string;
    toLogicalNodeId?: string;
    constraints?: { avoidNodeIds?: string[]; avoidEdgeIds?: string[] };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { fromLogicalNodeId, toLogicalNodeId, constraints = {} } = body;
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
      return NextResponse.json(
        { error: "Geen actieve dataset geconfigureerd (config/activeDataset ontbreekt)." },
        { status: 500 }
      );
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    if (!provider.getNode(fromLogicalNodeId)) {
      return NextResponse.json(
        { error: `fromLogicalNodeId '${fromLogicalNodeId}' bestaat niet in dataset ${datasetVersionId}.` },
        { status: 404 }
      );
    }
    if (!provider.getNode(toLogicalNodeId)) {
      return NextResponse.json(
        { error: `toLogicalNodeId '${toLogicalNodeId}' bestaat niet in dataset ${datasetVersionId}.` },
        { status: 404 }
      );
    }

    const result = computeRoute(provider, datasetVersionId, fromLogicalNodeId, toLogicalNodeId, constraints);

    if ("reason" in result) {
      return NextResponse.json(
        { error: result.message, reason: result.reason },
        { status: 422 }
      );
    }

    // VEILIGHEIDSFIX 13-9-2026 (Fase 2A, uitsluitend dit endpoint): sinds de M6/M7-
    // opslagformaat-fix (10-9-2026) laadt de bulk-graaf alleen topologie -- computeRoute()
    // levert hier dus een Route met lege geometry op. Dit endpoint is het contract dat
    // lib/navigation/reroute gebruikt tijdens een echte rit (route-engine-client.ts);
    // een reroute zonder geometrie is geen crash meer (invariant is al versoepeld in
    // route-builder.ts) maar wel een stil kapotte/onzichtbare lijn op de kaart tijdens het
    // fietsen. Zelfde, geverifieerd-toepasselijke patroon als route/loop (13-9-2026): pas
    // NA succesvolle routeberekening, gericht op alleen de edges van déze ene route
    // (typisch een tiental) -- edges hier zijn gegarandeerd pure GoKnoop (deze provider
    // combineert geen NWB), dus fetchGoknoopEdgeGeometry is hier semantisch correct.
    const resolvedEdges = resolveRouteEdges(provider, result);
    const geometryMap = await fetchGoknoopEdgeGeometry(resolvedEdges.map((e) => e.id));
    const hydratedEdges = resolvedEdges.map((edge) => ({
      ...edge,
      geometry: geometryMap.get(edge.id) ?? edge.geometry,
    }));
    const hydratedResult = { ...result, geometry: concatenateGeometry(result.nodes, hydratedEdges) };

    return NextResponse.json(hydratedResult);
  } catch (err) {
    return NextResponse.json(
      { error: "Route-berekening mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
