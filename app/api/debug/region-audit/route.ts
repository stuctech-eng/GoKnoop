import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { wgs84ToRd } from "@/lib/route-engine/coordinate-transform";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/region-audit
 *
 * GPT-voorstel (sessie 4-9-2026, "root-cause audit i.p.v. losse pontje-patches"):
 * vergelijk match%, edges-per-logicalNode en isolatie tussen Amsterdam-centrum en
 * een referentiegebied, om vast te stellen of dit een REGIONAAL matchingprobleem
 * is i.p.v. incidentele losse gaten.
 *
 * Query params:
 *   key              — DEBUG_SECRET
 *   datasetVersionId — optioneel, default: config/activeDataset
 *   regions          — JSON-array van { label, minLat, minLon, maxLat, maxLon }
 *                       (default: drie hardcoded gebieden, zie DEFAULT_REGIONS)
 *
 * Werkwijze: laadt volledige sourceNodes/logicalNodes/edges voor de dataset
 * (zelfde in-memory-aanpak als match-edges/isolated-edge-diagnostic), filtert
 * daarna per gebied in het geheugen op RD-bbox. Geen aparte Firestore-index
 * nodig, kost wel geheugen/tijd bij zeer grote datasets (vandaar maxDuration 60).
 */

type NamedRegion = { label: string; minLat: number; minLon: number; maxLat: number; maxLon: number };

// Ruwe, niet op de kaart geverifieerde schattingen -- doel is juist deze af te tasten.
const DEFAULT_REGIONS: NamedRegion[] = [
  { label: "Amsterdam-centrum (rond De Ruijterkade/NDSM/Buiksloterweg)", minLat: 52.36, minLon: 4.87, maxLat: 52.405, maxLon: 4.935 },
  { label: "Referentiegebied Volendam/Edam (bevestigd goed werkend)", minLat: 52.48, minLon: 4.98, maxLat: 52.52, maxLon: 5.06 },
  { label: "Overgangsgebied Amsterdam-Noord/Waterland", minLat: 52.4, minLon: 4.95, maxLat: 52.44, maxLon: 5.05 },
];

type RdBbox = { minX: number; minY: number; maxX: number; maxY: number };

function toRdBbox(r: NamedRegion): RdBbox {
  const corners = [
    wgs84ToRd(r.minLat, r.minLon),
    wgs84ToRd(r.minLat, r.maxLon),
    wgs84ToRd(r.maxLat, r.minLon),
    wgs84ToRd(r.maxLat, r.maxLon),
  ];
  return {
    minX: Math.min(...corners.map((c) => c.x)),
    maxX: Math.max(...corners.map((c) => c.x)),
    minY: Math.min(...corners.map((c) => c.y)),
    maxY: Math.max(...corners.map((c) => c.y)),
  };
}

function inBbox(x: number, y: number, b: RdBbox): boolean {
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

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

    let datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId");
    if (!datasetVersionId) {
      const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
      if (!activeDatasetSnap.exists) {
        return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
      }
      datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;
    }

    const regionsParam = req.nextUrl.searchParams.get("regions");
    const regions: NamedRegion[] = regionsParam ? JSON.parse(regionsParam) : DEFAULT_REGIONS;

    const [logicalNodesSnap, edgesSnap] = await Promise.all([
      db.collection("logicalNodes").where("datasetVersionId", "==", datasetVersionId).get(),
      db.collection("edges").where("datasetVersionId", "==", datasetVersionId).get(),
    ]);

    type LNode = { id: string; x: number; y: number; displayNumber?: string };
    const logicalNodes: LNode[] = logicalNodesSnap.docs.map((d) => {
      const data = d.data();
      return { id: d.id, x: data.x, y: data.y, displayNumber: data.displayNumber };
    });

    type EdgeRow = {
      matchConfidence: string;
      fromLogicalNodeId: string | null;
      toLogicalNodeId: string | null;
      coords: { x: number; y: number }[];
      endpointMatches?: { endpoint: string; sourceCoordinate: { x: number; y: number }; distanceM: number | null; matchConfidence: string }[];
    };
    const edges: EdgeRow[] = edgesSnap.docs.map((d) => {
      const data = d.data();
      return {
        matchConfidence: data.matchConfidence,
        fromLogicalNodeId: data.fromLogicalNodeId ?? null,
        toLogicalNodeId: data.toLogicalNodeId ?? null,
        coords: data.coords || [],
        endpointMatches: data.endpointMatches,
      };
    });

    // Edge-count per logicalNode, alleen matched edges (zelfde definitie als de routing-graph).
    const edgeCountByNode = new Map<string, number>();
    for (const e of edges) {
      if (e.matchConfidence !== "matched") continue;
      if (e.fromLogicalNodeId) edgeCountByNode.set(e.fromLogicalNodeId, (edgeCountByNode.get(e.fromLogicalNodeId) || 0) + 1);
      if (e.toLogicalNodeId) edgeCountByNode.set(e.toLogicalNodeId, (edgeCountByNode.get(e.toLogicalNodeId) || 0) + 1);
    }

    const results = regions.map((region) => {
      const bbox = toRdBbox(region);

      const nodesInRegion = logicalNodes.filter((n) => inBbox(n.x, n.y, bbox));
      const edgeCounts = nodesInRegion.map((n) => edgeCountByNode.get(n.id) || 0);
      const sortedCounts = [...edgeCounts].sort((a, b) => a - b);

      const zeroEdgeNodes = nodesInRegion.filter((n) => (edgeCountByNode.get(n.id) || 0) === 0);
      const oneEdgeNodes = nodesInRegion.filter((n) => (edgeCountByNode.get(n.id) || 0) === 1);

      // Edges die met minstens één eindpunt in dit gebied raken.
      const touchingEdges = edges.filter((e) => {
        if (e.coords.length === 0) return false;
        const start = e.coords[0];
        const end = e.coords[e.coords.length - 1];
        return inBbox(start.x, start.y, bbox) || inBbox(end.x, end.y, bbox);
      });
      const confidenceCounts: Record<string, number> = {};
      for (const e of touchingEdges) {
        confidenceCounts[e.matchConfidence] = (confidenceCounts[e.matchConfidence] || 0) + 1;
      }
      const matched = confidenceCounts["matched"] || 0;
      const matchPercent = touchingEdges.length ? ((matched / touchingEdges.length) * 100).toFixed(1) : "n/a";

      // Distance-distributie voor endpoints die in dit gebied liggen (ook onmatched).
      const inRegionDistances: number[] = [];
      for (const e of touchingEdges) {
        if (!e.endpointMatches) continue;
        for (const ep of e.endpointMatches) {
          if (inBbox(ep.sourceCoordinate.x, ep.sourceCoordinate.y, bbox) && ep.distanceM !== null) {
            inRegionDistances.push(ep.distanceM);
          }
        }
      }
      inRegionDistances.sort((a, b) => a - b);

      return {
        region: region.label,
        bboxWgs84: { minLat: region.minLat, minLon: region.minLon, maxLat: region.maxLat, maxLon: region.maxLon },
        logicalNodesInRegion: nodesInRegion.length,
        edgesTouchingRegion: touchingEdges.length,
        edgeConfidenceCounts: confidenceCounts,
        matchPercent: `${matchPercent}%`,
        edgesPerNode: {
          zeroEdgeNodeCount: zeroEdgeNodes.length,
          oneEdgeNodeCount: oneEdgeNodes.length,
          avg: edgeCounts.length ? (edgeCounts.reduce((a, b) => a + b, 0) / edgeCounts.length).toFixed(2) : "n/a",
          median: sortedCounts.length ? median(sortedCounts) : "n/a",
          max: sortedCounts.length ? sortedCounts[sortedCounts.length - 1] : "n/a",
        },
        zeroEdgeNodeSample: zeroEdgeNodes.slice(0, 10).map((n) => ({ id: n.id, displayNumber: n.displayNumber ?? null })),
        endpointDistanceStatsM: inRegionDistances.length
          ? {
              count: inRegionDistances.length,
              median: median(inRegionDistances).toFixed(2),
              p90: inRegionDistances[Math.floor(inRegionDistances.length * 0.9)].toFixed(2),
              max: inRegionDistances[inRegionDistances.length - 1].toFixed(2),
            }
          : null,
      };
    });

    return NextResponse.json({ datasetVersionId, totalLogicalNodes: logicalNodes.length, totalEdges: edges.length, regions: results });
  } catch (err) {
    return NextResponse.json(
      { error: "Regio-audit mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
