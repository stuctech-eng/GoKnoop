import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Optie C (ontwerp sectie 4, benchmark 26-8-2026): berekent de graph één keer
 * vooraf en slaat 'm compact op -- minder, grotere documenten in plaats van
 * 11.003 + 16.345 losse documenten met each hun eigen leesoverhead.
 *
 * Structuur: precomputedGraph/{datasetVersionId}_meta + genummerde chunks
 * met platte arrays (niet Firestore-document-per-node/edge).
 */

const NODE_CHUNK_SIZE = 5000; // nodes zijn klein (geen geometrie), grotere chunks zijn veilig
const EDGE_CHUNK_SIZE = 200; // edges bevatten volledige lijngeometrie, veel groter per item

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

  try {
    const db = getDb();
    const t0 = Date.now();

    const [nodesSnap, edgesSnap] = await Promise.all([
      db.collection("logicalNodes").where("datasetVersionId", "==", datasetVersionId).get(),
      db
        .collection("edges")
        .where("datasetVersionId", "==", datasetVersionId)
        .where("matchConfidence", "==", "matched")
        .get(),
    ]);

    const nodes = nodesSnap.docs.map((doc) => {
      const d = doc.data();
      return { id: doc.id, x: d.x, y: d.y, displayNumber: d.displayNumber, displayRegio: d.displayRegio };
    });
    const edges = edgesSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        fromLogicalNodeId: d.fromLogicalNodeId,
        toLogicalNodeId: d.toLogicalNodeId,
        distanceM: d.distanceM,
        directionality: d.directionality || "unknown",
        geometry: d.coords || [],
      };
    });

    const nodeChunks: (typeof nodes)[] = [];
    for (let i = 0; i < nodes.length; i += NODE_CHUNK_SIZE) nodeChunks.push(nodes.slice(i, i + NODE_CHUNK_SIZE));
    const edgeChunks: (typeof edges)[] = [];
    for (let i = 0; i < edges.length; i += EDGE_CHUNK_SIZE) edgeChunks.push(edges.slice(i, i + EDGE_CHUNK_SIZE));

    const CHUNKS_PER_COMMIT = 1; // conservatief -- edges kunnen groot zijn, één chunk-document per commit

    const nodeCommitPromises = [];
    for (let i = 0; i < nodeChunks.length; i += CHUNKS_PER_COMMIT) {
      const batch = db.batch();
      nodeChunks.slice(i, i + CHUNKS_PER_COMMIT).forEach((chunk, j) => {
        const idx = i + j;
        batch.set(db.collection("precomputedGraph").doc(`${datasetVersionId}_nodes_${idx}`), {
          datasetVersionId,
          type: "nodes",
          chunkIndex: idx,
          items: chunk,
        });
      });
      nodeCommitPromises.push(batch.commit());
    }
    await Promise.all(nodeCommitPromises);

    const edgeCommitPromises = [];
    for (let i = 0; i < edgeChunks.length; i += CHUNKS_PER_COMMIT) {
      const batch = db.batch();
      edgeChunks.slice(i, i + CHUNKS_PER_COMMIT).forEach((chunk, j) => {
        const idx = i + j;
        batch.set(db.collection("precomputedGraph").doc(`${datasetVersionId}_edges_${idx}`), {
          datasetVersionId,
          type: "edges",
          chunkIndex: idx,
          items: chunk,
        });
      });
      edgeCommitPromises.push(batch.commit());
    }
    await Promise.all(edgeCommitPromises);

    await db.collection("precomputedGraph").doc(`${datasetVersionId}_meta`).set({
      datasetVersionId,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodeChunkCount: nodeChunks.length,
      edgeChunkCount: edgeChunks.length,
      precomputedAt: new Date().toISOString(),
    });

    return NextResponse.json({
      datasetVersionId,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodeChunkCount: nodeChunks.length,
      edgeChunkCount: edgeChunks.length,
      precomputeTimeMs: Date.now() - t0,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Precompute mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
