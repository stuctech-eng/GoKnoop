import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { loadCachedCombinedGraph } from "@/lib/route-engine/cached-nwb-provider";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

// Bekende kandidaten uit de drie testroutes.
const CANDIDATES: Record<string, string> = {
  "Amsterdam Centraal": "CJSXBPUMG49vOPmYvhJd",
  "Amsterdam alt-kandidaat": "MQAnNb1IMego7dnVPXpS",
  "Hilversum knooppunt 55": "ZYuO6ZfzSa2iim0HcUbn",
  "Volendam knooppunt 95": "7fmSWIHYsKu3Wb3yOtM2",
  "Lochem kandidaat": "0pgYw2kgDphP2IT1RAi7",
  "Lochem bestemming": "61aNR7RWLxQhHTOfMHtm",
};

/**
 * GET /api/admin/diagnose-candidate-connectivity
 *
 * Fase 4 van het uitvoeringsplan, 11-9-2026. Clustering is BEWEZEN correct
 * (Fase 1+2, bijectie-check 100%). Dit onderzoekt nu de connectorlaag EN de
 * mogelijkheid dat de (parallel doorgevoerde) GoKnoop-edge-opslagformaat-
 * wijziging (topologie losgekoppeld van geometrie) iets liet wegvallen --
 * niet aangenomen dat het per se de connectoren zijn.
 *
 * Laadt de graaf ÉÉN KEER (~8,4s, bekend/geaccepteerd), en doet daarna
 * uitsluitend GOEDKOPE, in-memory controles -- geen extra Firestore-
 * aanroepen, om niet opnieuw over het budget te gaan.
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
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
    const { graph } = await loadCachedCombinedGraph(provider, datasetVersionId);

    const results: Record<string, unknown> = {};

    for (const [label, nodeId] of Object.entries(CANDIDATES)) {
      const node = provider.getNode(nodeId);
      const edges = provider.getEdgesFrom(nodeId);
      const adjacencyEntries = graph.adjacency.get(nodeId) ?? [];

      // Goedkope BFS, 2 stappen diep, puur om te zien of er OVERHAUPT een
      // NWB-connector of NWB-edge binnen bereik is (geen volledige Dijkstra).
      let reachesNwbWithin2Hops = false;
      const nwbEdgesAtHop1: string[] = [];
      for (const e of adjacencyEntries) {
        if (e.source === "nwb" || e.source === "connector") {
          reachesNwbWithin2Hops = true;
          nwbEdgesAtHop1.push(`${e.source}->${e.to}`);
        } else {
          const hop2 = graph.adjacency.get(e.to) ?? [];
          for (const e2 of hop2) {
            if (e2.source === "nwb" || e2.source === "connector") {
              reachesNwbWithin2Hops = true;
              break;
            }
          }
        }
      }

      results[label] = {
        nodeId,
        bestaatInGoKnoopProvider: !!node,
        goknoopEdgeCountViaProvider: edges.length,
        adjacencyEntryCountViaGraph: adjacencyEntries.length,
        adjacencySourceBreakdown: {
          goknoop: adjacencyEntries.filter((e) => e.source === "goknoop").length,
          nwb: adjacencyEntries.filter((e) => e.source === "nwb").length,
          connector: adjacencyEntries.filter((e) => e.source === "connector").length,
        },
        reachesNwbOfConnectorWithin2Hops: reachesNwbWithin2Hops,
        nwbEdgesGevondenBijHop1: nwbEdgesAtHop1.slice(0, 5),
      };
    }

    return NextResponse.json({
      datasetVersionId,
      graphStats: {
        totalConnectorsCreated: graph.totalConnectorsCreated,
        nodePositionSize: graph.nodePosition.size,
        adjacencySize: graph.adjacency.size,
        goknoopNodeCountInProvider: provider.getAllNodeIds().length,
      },
      candidateResults: results,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Diagnose mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
