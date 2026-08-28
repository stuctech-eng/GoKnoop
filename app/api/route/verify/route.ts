import { NextRequest, NextResponse } from "next/server";
import { FirestoreGraphProvider } from "@/lib/route-engine/firestore-graph-provider";
import { computeRoute } from "@/lib/route-engine/route-engine";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Handmatige verificatieroute (implementatiestap 10): draait de Route Engine
 * tegen de echte productiedataset, met een expliciete datasetVersionId
 * (i.p.v. via config/activeDataset zoals de echte API-route) -- puur om te
 * controleren dat de engine ook op de volledige 11.003-node-graph correct
 * en snel genoeg werkt, los van de activatiestap.
 */

export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId");
  const fromLogicalNodeId = req.nextUrl.searchParams.get("from");
  const toLogicalNodeId = req.nextUrl.searchParams.get("to");
  if (!datasetVersionId || !fromLogicalNodeId || !toLogicalNodeId) {
    return NextResponse.json(
      { error: "datasetVersionId, from en to zijn verplicht." },
      { status: 400 }
    );
  }

  try {
    const t0 = Date.now();
    const provider = new FirestoreGraphProvider(datasetVersionId);
    await provider.load();
    const loadTimeMs = Date.now() - t0;

    const fromNode = provider.getNode(fromLogicalNodeId);
    const toNode = provider.getNode(toLogicalNodeId);

    const result = computeRoute(provider, datasetVersionId, fromLogicalNodeId, toLogicalNodeId);

    return NextResponse.json({
      loadTimeMs,
      totalNodesLoaded: provider.getAllNodeIds().length,
      fromNodeFound: !!fromNode,
      toNodeFound: !!toNode,
      result:
        "reason" in result
          ? { ok: false, reason: result.reason, message: result.message }
          : {
              ok: true,
              distanceM: result.distanceM,
              nodeCount: result.nodes.length,
              edgeCount: result.edges.length,
              geometryPointCount: result.geometry.length,
              computeTimeMs: result.metadata.computeTimeMs,
              edgesConsidered: result.metadata.edgesConsidered,
              nodes: result.nodes,
            },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Verificatie mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
