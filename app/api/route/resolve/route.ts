import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { resolveRouteEdges } from "@/lib/route-engine/resolve-route-edges";
import type { Route } from "@/lib/route-engine/types";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * POST /api/route/resolve
 * Body: { datasetVersionId, edgeIds: string[], nodeIds: string[] }
 * Response: { resolvedEdges: GraphEdge[], nodeDisplayNumbers: string[], distanceM: number }
 *
 * Fase 3 ("Mijn routes", GOKNOOP-MASTER.md sectie 6F, 29-8-2026): een
 * bewaarde route wordt bewust NIET met volledige geometrie in localStorage
 * opgeslagen (te groot, en kan verouderen als de dataset ooit wijzigt) --
 * alleen `edgeIds`/`nodeIds`/`datasetVersionId`. Dit endpoint vertaalt die
 * lichte referentie terug naar de volledige, actuele `GraphEdge[]` +
 * weergavenummers, klaar om rechtstreeks in `NavigationScreen` te voeden.
 *
 * Hergebruikt UITSLUITEND bestaande bouwstenen: `resolveRouteEdges()`
 * (dataketen-fix) en dezelfde displayNumber-mapping als
 * `generateLoopRoutes()` -- geen nieuwe/afwijkende resolutielogica.
 */
export async function POST(req: NextRequest) {
  let body: { datasetVersionId?: string; edgeIds?: string[]; nodeIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { datasetVersionId, edgeIds, nodeIds } = body;
  if (!datasetVersionId || !edgeIds || !nodeIds || edgeIds.length === 0) {
    return NextResponse.json({ error: "datasetVersionId, edgeIds en nodeIds zijn verplicht." }, { status: 400 });
  }
  if (nodeIds.length !== edgeIds.length + 1) {
    return NextResponse.json({ error: "nodeIds.length moet edgeIds.length + 1 zijn." }, { status: 400 });
  }

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const activeDatasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    if (datasetVersionId !== activeDatasetVersionId) {
      // Expliciet, geen stille verkeerde-versie-fout later in de Navigation Engine --
      // dezelfde datasetVersionId-bewaking als bij reroute (ontwerp sectie 19).
      return NextResponse.json(
        { error: "Deze opgeslagen route is van een oudere datasetversie en kan niet meer worden opgehaald.", reason: "dataset_version_mismatch" },
        { status: 409 }
      );
    }

    const provider = new CachedGraphProvider(activeDatasetVersionId);
    await provider.load();

    const routeShaped: Route = {
      id: "saved-route-resolve",
      datasetVersionId: activeDatasetVersionId,
      source: "route-engine-v1",
      network: "fiets",
      mode: "bicycle",
      nodes: nodeIds,
      edges: edgeIds,
      geometry: [],
      distanceM: 0,
      elevation: null,
      durationEstimate: null,
      preferences: {},
      constraints: {},
      waypoints: [],
      alternatives: [],
      navigation: null,
      metadata: { algorithm: "dijkstra", computedAt: new Date().toISOString(), computeTimeMs: 0, edgesConsidered: 0 },
    };

    const resolvedEdges = resolveRouteEdges(provider, routeShaped);
    const nodeDisplayNumbers = nodeIds.map((nodeId) => provider.getNode(nodeId)?.displayNumber ?? nodeId);
    const distanceM = resolvedEdges.reduce((sum, edge) => sum + edge.distanceM, 0);

    return NextResponse.json({ resolvedEdges, nodeDisplayNumbers, distanceM });
  } catch (err) {
    return NextResponse.json(
      { error: "Route-resolutie mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
