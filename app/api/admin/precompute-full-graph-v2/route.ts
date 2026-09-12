import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { reportProgress } from "@/lib/diagnostics/report-progress";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { buildValidatedCombinedGraph, type SlimNwbSegment, type ValidatedConnectorInput, type CombinedEdge } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const CONNECTOR_SEARCH_TOLERANCE_M = 20;
const CHUNK_SIZE = 2000;
const TIME_BUDGET_MS = 9000; // veiligheidsmarge van 1s onder de harde 10s-limiet

/**
 * POST /api/admin/precompute-full-graph-v2
 * Body: { datasetVersionId, nwbDatasetVersionId }
 *
 * PRODUCTIEARCHITECTUUR-KEUZE (optie C), 12-9-2026. Bouwt de volledige,
 * samengestelde graaf (adjacency + nodePosition, na alle clustering en
 * connector-verwerking) EENMALIG en schrijft die weg als kant-en-klaar
 * artefact -- een koude start hoeft dan alleen dit artefact te lezen, geen
 * enkele reconstructie meer uit ruwe GoKnoop/NWB-brondata.
 *
 * HERVATBAAR PATROON: elke aanroep MOET de graaf opnieuw lezen+bouwen
 * (~7,6s, bewezen via /api/admin/timing-breakdown) -- er is geen manier om
 * gebouwde data tussen aparte serverless-aanroepen te bewaren. Wat WEL kan:
 * binnen het resterende tijdsbudget (~1-2s) een deel van de chunks
 * wegschrijven, de voortgang bijhouden, en bij een volgende aanroep verder
 * gaan waar het bleef. Roep dit endpoint dus HERHAALD aan tot de respons
 * `compleet: true` toont.
 */
export async function POST(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: { datasetVersionId?: string; nwbDatasetVersionId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }
  const { datasetVersionId, nwbDatasetVersionId } = body;
  if (!datasetVersionId || !nwbDatasetVersionId) {
    return NextResponse.json({ error: "datasetVersionId en nwbDatasetVersionId zijn verplicht." }, { status: 400 });
  }

  const t0 = Date.now();
  const cacheKey = `${datasetVersionId}__${nwbDatasetVersionId}`;
  reportProgress("latest", "precompute-full-graph-v2: START", { elapsedMs: 0, cacheKey });

  try {
    const db = getDb();

    // ---- Lezen + bouwen (onvermijdelijk elke aanroep, ~7,6s) ----
    const provider = new CachedGraphProvider(datasetVersionId);
    const providerLoadPromise = provider.load();

    const connectorsKey = `${nwbDatasetVersionId}_${datasetVersionId}`;
    const [batchesSnap, connectorsSnap] = await Promise.all([
      db.collection("nwbSegments").doc(nwbDatasetVersionId).collection("batches").get(),
      db.collection("nwbConnectors").doc(connectorsKey).collection("connectors").get(),
    ]);
    const nwbSegments: SlimNwbSegment[] = [];
    for (const doc of batchesSnap.docs) {
      const data = doc.data() as { segments: SlimNwbSegment[] };
      nwbSegments.push(...data.segments);
    }
    const validatedConnectors: ValidatedConnectorInput[] = connectorsSnap.docs.map((d) => d.data() as ValidatedConnectorInput);

    await providerLoadPromise;
    reportProgress("latest", "precompute-full-graph-v2: brondata gelezen", { elapsedMs: Date.now() - t0, aantalSegmenten: nwbSegments.length, aantalConnectoren: validatedConnectors.length });

    const graph = await buildValidatedCombinedGraph(provider, nwbSegments, CONNECTOR_SEARCH_TOLERANCE_M, validatedConnectors);
    reportProgress("latest", "precompute-full-graph-v2: graaf gebouwd", {
      elapsedMs: Date.now() - t0,
      adjacencySize: graph.adjacency.size,
      nodePositionSize: graph.nodePosition.size,
    });

    // ---- Chunks samenstellen ----
    const adjacencyEntries: [string, CombinedEdge[]][] = Array.from(graph.adjacency.entries());
    const nodePositionEntries: [string, { x: number; y: number; source: string }][] = Array.from(graph.nodePosition.entries());
    const adjChunks: [string, CombinedEdge[]][][] = [];
    for (let i = 0; i < adjacencyEntries.length; i += CHUNK_SIZE) adjChunks.push(adjacencyEntries.slice(i, i + CHUNK_SIZE));
    const posChunks: [string, { x: number; y: number; source: string }][][] = [];
    for (let i = 0; i < nodePositionEntries.length; i += CHUNK_SIZE) posChunks.push(nodePositionEntries.slice(i, i + CHUNK_SIZE));
    const totalChunks = adjChunks.length + posChunks.length;

    // ---- Bestaande voortgang lezen ----
    const metaRef = db.collection("precomputedCombinedGraph").doc(cacheKey);
    const metaSnap = await metaRef.get();
    let writtenAdj = 0;
    let writtenPos = 0;
    if (metaSnap.exists) {
      const m = metaSnap.data()!;
      // Alleen hervatten als het EXACT dezelfde structuur betreft (zelfde aantal chunks) --
      // anders (bijv. na een nieuwe migratie) vanaf 0 beginnen.
      if (m.adjChunkCount === adjChunks.length && m.posChunkCount === posChunks.length && m.status !== "compleet") {
        writtenAdj = m.writtenAdj ?? 0;
        writtenPos = m.writtenPos ?? 0;
      }
    }
    reportProgress("latest", "precompute-full-graph-v2: voortgang gelezen", { writtenAdj, writtenPos, totaalAdjChunks: adjChunks.length, totaalPosChunks: posChunks.length });

    // ---- Schrijven binnen het resterende tijdsbudget ----
    const chunksRef = metaRef.collection("chunks");
    let newlyWrittenAdj = 0;
    let newlyWrittenPos = 0;

    for (let i = writtenAdj; i < adjChunks.length; i++) {
      if (Date.now() - t0 > TIME_BUDGET_MS) break;
      await chunksRef.doc(`adj_${i}`).set({ type: "adjacency", entries: adjChunks[i] });
      newlyWrittenAdj++;
    }
    const adjDoneNow = writtenAdj + newlyWrittenAdj;

    for (let i = writtenPos; i < posChunks.length; i++) {
      if (Date.now() - t0 > TIME_BUDGET_MS) break;
      await chunksRef.doc(`pos_${i}`).set({ type: "nodePosition", entries: posChunks[i] });
      newlyWrittenPos++;
    }
    const posDoneNow = writtenPos + newlyWrittenPos;

    const compleet = adjDoneNow >= adjChunks.length && posDoneNow >= posChunks.length;

    await metaRef.set({
      datasetVersionId,
      nwbDatasetVersionId,
      adjChunkCount: adjChunks.length,
      posChunkCount: posChunks.length,
      writtenAdj: adjDoneNow,
      writtenPos: posDoneNow,
      totalConnectorsCreated: graph.totalConnectorsCreated,
      status: compleet ? "compleet" : "bezig",
      updatedAt: Date.now(),
    });

    reportProgress("latest", "precompute-full-graph-v2: chunks geschreven deze aanroep", {
      elapsedMs: Date.now() - t0,
      newlyWrittenAdj,
      newlyWrittenPos,
      adjDoneNow,
      posDoneNow,
      totalChunks,
      compleet,
    });

    return NextResponse.json({
      compleet,
      voortgang: { adjDoneNow, adjTotaal: adjChunks.length, posDoneNow, posTotaal: posChunks.length },
      nieuwGeschrevenDezeAanroep: { adjacency: newlyWrittenAdj, nodePosition: newlyWrittenPos },
      elapsedMs: Date.now() - t0,
      boodschap: compleet
        ? "Volledig klaar -- artefact compleet, klaar voor gebruik."
        : "Nog niet compleet -- roep dit endpoint OPNIEUW aan om verder te gaan.",
    });
  } catch (err) {
    reportProgress("latest", "precompute-full-graph-v2: EXCEPTION", { error: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - t0 });
    return NextResponse.json(
      { error: "Precompute mislukt.", details: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - t0 },
      { status: 502 }
    );
  }
}
