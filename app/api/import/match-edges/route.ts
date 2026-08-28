import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 60;

/**
 * Phase 1C, stap 13 — importer, deel 4: edge-endpoint-matching.
 *
 * Pipeline (vastgelegd na review, niet te vereenvoudigen):
 *   edge endpoint -> source_node match (<=5m) -> source_node.logicalNodeId
 *
 * NIET rechtstreeks edge endpoint -> nearest logical node. Het bronpunt is
 * de tussenstap, zodat elke match herleidbaar blijft tot een echt Routedatabank-
 * record, niet tot een afgeleid centroid.
 *
 * Zelfde tweefasen-patroon als cluster-nodes (compute + cache, dan gepagineerd
 * schrijven) — geen stille failures: elk endpoint krijgt een matchConfidence,
 * nooit een edge die zomaar verdwijnt of overgeslagen wordt.
 */

type SourceNode = { id: string; x: number; y: number; logicalNodeId: string | null };
type EdgeDoc = {
  id: string;
  coords: { x: number; y: number }[];
};

type EndpointMatch = {
  endpoint: "start" | "end";
  sourceCoordinate: { x: number; y: number };
  matchedSourceNodeId: string | null;
  logicalNodeId: string | null;
  distanceM: number | null;
  matchConfidence: "exact" | "close" | "tolerance" | "unmatched";
  ambiguous: boolean; // meerdere kandidaten binnen tolerantie
};

const MATCH_TOLERANCE_M = 5;
const GRID_CELL_SIZE_M = 5;
const CACHE_CHUNK_SIZE = 1000;

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function buildGrid(nodes: SourceNode[]): Record<string, number[]> {
  const grid: Record<string, number[]> = {};
  nodes.forEach((n, i) => {
    const key = `${Math.floor(n.x / GRID_CELL_SIZE_M)}_${Math.floor(n.y / GRID_CELL_SIZE_M)}`;
    (grid[key] ||= []).push(i);
  });
  return grid;
}

function matchEndpoint(
  point: { x: number; y: number },
  nodes: SourceNode[],
  grid: Record<string, number[]>
): { matches: { index: number; d: number }[] } {
  const cellX = Math.floor(point.x / GRID_CELL_SIZE_M);
  const cellY = Math.floor(point.y / GRID_CELL_SIZE_M);
  const candidates: { index: number; d: number }[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const key = `${cellX + dx}_${cellY + dy}`;
      const indices = grid[key];
      if (!indices) continue;
      for (const i of indices) {
        const d = dist(point, nodes[i]);
        if (d <= MATCH_TOLERANCE_M) {
          candidates.push({ index: i, d });
        }
      }
    }
  }
  candidates.sort((a, b) => a.d - b.d);
  return { matches: candidates };
}

function classifyDistance(d: number | null): EndpointMatch["matchConfidence"] {
  if (d === null) return "unmatched";
  if (d <= 0.5) return "exact";
  if (d <= 2) return "close";
  return "tolerance"; // 2-5m
}

function resolveEndpointMatches(
  edges: EdgeDoc[],
  nodes: SourceNode[]
): { edgeId: string; start: EndpointMatch; end: EndpointMatch }[] {
  const grid = buildGrid(nodes);
  const results: { edgeId: string; start: EndpointMatch; end: EndpointMatch }[] = [];

  for (const edge of edges) {
    if (edge.coords.length === 0) continue;
    const startPoint = edge.coords[0];
    const endPoint = edge.coords[edge.coords.length - 1];

    const makeMatch = (point: { x: number; y: number }, which: "start" | "end"): EndpointMatch => {
      const { matches } = matchEndpoint(point, nodes, grid);
      if (matches.length === 0) {
        return {
          endpoint: which,
          sourceCoordinate: point,
          matchedSourceNodeId: null,
          logicalNodeId: null,
          distanceM: null,
          matchConfidence: "unmatched",
          ambiguous: false,
        };
      }
      const best = matches[0];
      const node = nodes[best.index];
      return {
        endpoint: which,
        sourceCoordinate: point,
        matchedSourceNodeId: node.id,
        logicalNodeId: node.logicalNodeId,
        distanceM: best.d,
        matchConfidence: classifyDistance(best.d),
        ambiguous: matches.length > 1,
      };
    };

    results.push({
      edgeId: edge.id,
      start: makeMatch(startPoint, "start"),
      end: makeMatch(endPoint, "end"),
    });
  }

  return results;
}

export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId");
  if (!datasetVersionId) {
    return NextResponse.json({ error: "datasetVersionId is verplicht." }, { status: 400 });
  }
  const phase = req.nextUrl.searchParams.get("phase") || "compute";
  const writeOffset = parseInt(req.nextUrl.searchParams.get("writeOffset") || "0", 10);
  const writeBatchSize = parseInt(req.nextUrl.searchParams.get("writeBatchSize") || "200", 10);

  try {
    const db = getDb();
    const cacheMetaRef = db.collection("edgeMatchCache").doc(datasetVersionId);

    if (phase === "compute") {
      const t0 = Date.now();
      const [nodesSnap, edgesSnap] = await Promise.all([
        db.collection("sourceNodes").where("datasetVersionId", "==", datasetVersionId).get(),
        db.collection("edges").where("datasetVersionId", "==", datasetVersionId).get(),
      ]);
      const readMs = Date.now() - t0;

      const nodes: SourceNode[] = nodesSnap.docs.map((doc) => {
        const d = doc.data();
        return { id: doc.id, x: d.x, y: d.y, logicalNodeId: d.logicalNodeId ?? null };
      });
      const edges: EdgeDoc[] = edgesSnap.docs.map((doc) => {
        const d = doc.data();
        return { id: doc.id, coords: d.coords || [] };
      });

      if (nodes.length === 0 || edges.length === 0) {
        return NextResponse.json(
          { error: "Geen sourceNodes en/of edges gevonden voor deze datasetVersionId." },
          { status: 404 }
        );
      }

      const t1 = Date.now();
      const matchResults = resolveEndpointMatches(edges, nodes);
      const matchMs = Date.now() - t1;

      // Aggregatiestatistieken over alle endpoints.
      const allEndpoints = matchResults.flatMap((r) => [r.start, r.end]);
      const distances = allEndpoints.map((e) => e.distanceM).filter((d): d is number => d !== null);
      const confidenceCounts: Record<string, number> = {};
      for (const e of allEndpoints) {
        confidenceCounts[e.matchConfidence] = (confidenceCounts[e.matchConfidence] || 0) + 1;
      }
      const ambiguousCount = allEndpoints.filter((e) => e.ambiguous).length;

      const report = {
        totalEdges: edges.length,
        totalEndpoints: allEndpoints.length,
        confidenceCounts,
        ambiguousCount,
        avgDistanceM: distances.length ? (distances.reduce((a, b) => a + b, 0) / distances.length).toFixed(3) : null,
        maxDistanceM: distances.length ? Math.max(...distances).toFixed(3) : null,
      };

      const t2 = Date.now();
      const chunks: typeof matchResults[] = [];
      for (let i = 0; i < matchResults.length; i += CACHE_CHUNK_SIZE) {
        chunks.push(matchResults.slice(i, i + CACHE_CHUNK_SIZE));
      }
      // Cache-documenten in kleine groepjes committen (niet alles in één batch —
      // dat overschrijdt Firestore's ~10MB request-payload-limiet bij grote datasets).
      const CHUNKS_PER_COMMIT = 5;
      for (let i = 0; i < chunks.length; i += CHUNKS_PER_COMMIT) {
        const commitGroup = chunks.slice(i, i + CHUNKS_PER_COMMIT);
        const cacheBatch = db.batch();
        commitGroup.forEach((chunk, j) => {
          const chunkIndex = i + j;
          const ref = db.collection("edgeMatchCache").doc(`${datasetVersionId}_chunk${chunkIndex}`);
          cacheBatch.set(ref, { datasetVersionId, chunkIndex, items: chunk });
        });
        await cacheBatch.commit();
      }
      await cacheMetaRef.set({
        datasetVersionId,
        totalItems: matchResults.length,
        chunkCount: chunks.length,
        report,
        computedAt: new Date().toISOString(),
      });
      const cacheMs = Date.now() - t2;

      return NextResponse.json({
        phase: "compute",
        datasetVersionId,
        report,
        timingMs: { read: readMs, match: matchMs, cacheWrite: cacheMs, total: Date.now() - t0 },
        nextStep: "Roep nu phase=write aan (writeOffset=0) om de matches naar edges weg te schrijven.",
      });
    }

    // phase === "write"
    const metaSnap = await cacheMetaRef.get();
    if (!metaSnap.exists) {
      return NextResponse.json({ error: "Geen cache gevonden. Roep eerst phase=compute aan." }, { status: 400 });
    }
    const meta = metaSnap.data() as { totalItems: number; chunkCount: number; report: unknown };

    const startChunk = Math.floor(writeOffset / CACHE_CHUNK_SIZE);
    const endChunk = Math.floor((writeOffset + writeBatchSize - 1) / CACHE_CHUNK_SIZE);
    let slice: { edgeId: string; start: EndpointMatch; end: EndpointMatch }[] = [];
    for (let c = startChunk; c <= endChunk && c < meta.chunkCount; c++) {
      const chunkSnap = await db.collection("edgeMatchCache").doc(`${datasetVersionId}_chunk${c}`).get();
      const chunkData = chunkSnap.data() as { items: typeof slice } | undefined;
      if (chunkData) slice = slice.concat(chunkData.items);
    }
    const localOffset = writeOffset - startChunk * CACHE_CHUNK_SIZE;
    slice = slice.slice(localOffset, localOffset + writeBatchSize);

    const FIRESTORE_OP_LIMIT = 450;
    for (let i = 0; i < slice.length; i += FIRESTORE_OP_LIMIT) {
      const chunk = slice.slice(i, i + FIRESTORE_OP_LIMIT);
      const batch = db.batch();
      for (const item of chunk) {
        const bothMatched = item.start.matchedSourceNodeId !== null && item.end.matchedSourceNodeId !== null;
        const noneMatched = item.start.matchedSourceNodeId === null && item.end.matchedSourceNodeId === null;
        const matchConfidence = bothMatched
          ? "matched"
          : noneMatched
          ? "unmatched_both"
          : item.start.matchedSourceNodeId === null
          ? "unmatched_start"
          : "unmatched_end";

        batch.update(db.collection("edges").doc(item.edgeId), {
          fromLogicalNodeId: item.start.logicalNodeId,
          toLogicalNodeId: item.end.logicalNodeId,
          matchConfidence,
          endpointMatches: [item.start, item.end],
        });
      }
      await batch.commit();
    }

    const newWriteOffset = writeOffset + slice.length;
    const done = newWriteOffset >= meta.totalItems;

    return NextResponse.json({
      phase: "write",
      datasetVersionId,
      totalItems: meta.totalItems,
      writeOffset,
      written: slice.length,
      newWriteOffset,
      done,
      report: done ? meta.report : null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Edge-matching mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
