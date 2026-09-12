import { NextRequest, NextResponse } from "next/server";
import { getDb, getLastDbInitBreakdown } from "@/lib/firebase-admin";
import { reportProgress } from "@/lib/diagnostics/report-progress";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { buildValidatedCombinedGraph, type SlimNwbSegment, type ValidatedConnectorInput } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const CONNECTOR_SEARCH_TOLERANCE_M = 20;

/**
 * GET /api/admin/timing-breakdown
 *
 * Definitieve performance-audit, 12-9-2026, TWEEDE VERSIE. De eerste versie
 * gebruikte alleen lokale variabelen voor zijn EIGEN stappen (GoKnoop-lookup,
 * NWB-fetch) en riep `loadCachedCombinedGraph` niet aan (die wel
 * reportProgress had) -- bij de live timeout ging daardoor de VOLLEDIGE
 * breakdown verloren, ook de stappen die al voltooid waren. Elke stap heeft
 * nu ZELF ook een reportProgress-aanroep, zodat /api/admin/read-progress
 * altijd bruikbare, gedeeltelijke data teruggeeft, ongeacht of dit endpoint
 * zelf op tijd klaar is.
 *
 * BELANGRIJKE, EERLIJKE BEPERKING (punt 1 -- "Vercel/serverless cold-start
 * overhead"): van BINNENUIT de aanvraag NIET direct meetbaar. Zie de
 * toelichting bij "1_vercelColdStartOverhead" in de respons.
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const t0 = Date.now();
  const breakdown: Record<string, unknown> = {};
  function mark(key: string, data: Record<string, unknown>) {
    breakdown[key] = data;
    reportProgress("latest", `timing-breakdown: ${key}`, { elapsedMs: Date.now() - t0, ...data });
  }
  reportProgress("latest", "timing-breakdown: START", { elapsedMs: 0 });

  try {
    // ---- 2. Firebase/Firestore-initialisatie ----
    const tFirebase = Date.now();
    const db = getDb();
    const dbInitBreakdown = getLastDbInitBreakdown();
    mark("2_firebaseInitialisatie", { totaalMs: Date.now() - tFirebase, ...dbInitBreakdown });

    // ---- 3. GoKnoop dataset lookup ----
    const tGkLookup = Date.now();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;
    mark("3_goknoopDatasetLookup", { ms: Date.now() - tGkLookup, datasetVersionId });

    // ---- 4+5. GoKnoop nodes/edges lezen ----
    const tGkLoad = Date.now();
    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();
    mark("4_5_goknoopNodesEnEdgesLezen", {
      totaalMs: Date.now() - tGkLoad,
      cacheHit: provider.wasCacheHit,
      copyNaarEigenMapsMs: provider.lastCopyTimingMs,
      nodeCount: provider.getAllNodeIds().length,
    });

    // ---- 6. NWB dataset lookup ----
    const tNwbLookup = Date.now();
    const activeNwbSnap = await db.collection("config").doc("activeNwbDataset").get();
    const nwbDatasetVersionId: string | null = activeNwbSnap.exists ? (activeNwbSnap.data()!.nwbDatasetVersionId as string) : null;
    mark("6_nwbDatasetLookup", { ms: Date.now() - tNwbLookup, nwbDatasetVersionId });

    let nwbSegments: SlimNwbSegment[] = [];
    let validatedConnectors: ValidatedConnectorInput[] = [];

    if (nwbDatasetVersionId) {
      // ---- 7. NWB Firestore reads ----
      const tNwbFetch = Date.now();
      const batchesSnap = await db.collection("nwbSegments").doc(nwbDatasetVersionId).collection("batches").get();
      mark("7_nwbFirestoreReads", { ms: Date.now() - tNwbFetch, aantalBatchDocumenten: batchesSnap.docs.length });

      // ---- 8. NWB data deserialisatie ----
      const tNwbParse = Date.now();
      for (const doc of batchesSnap.docs) {
        const data = doc.data() as { segments: SlimNwbSegment[] };
        nwbSegments.push(...data.segments);
      }
      mark("8_nwbDataDeserialisatie", { ms: Date.now() - tNwbParse, aantalSegmenten: nwbSegments.length });
      mark("9_nwbSegmentParsing", { ms: 0, toelichting: "Samengevallen met stap 8 -- geen apart parse-station in de huidige architectuur." });

      // ---- 11. connectoren lezen ----
      const connectorsKey = `${nwbDatasetVersionId}_${datasetVersionId}`;
      const tConnFetch = Date.now();
      const connectorsSnap = await db.collection("nwbConnectors").doc(connectorsKey).collection("connectors").get();
      validatedConnectors = connectorsSnap.docs.map((d) => d.data() as ValidatedConnectorInput);
      mark("11_connectorenLezen", { ms: Date.now() - tConnFetch, aantalConnectoren: validatedConnectors.length });
    } else {
      mark("7_nwbFirestoreReads", { ms: 0, toelichting: "Geen actieve NWB-dataset." });
      mark("8_nwbDataDeserialisatie", { ms: 0 });
      mark("9_nwbSegmentParsing", { ms: 0 });
      mark("11_connectorenLezen", { ms: 0 });
    }

    // ---- 10+12+13+14. clustering/buildBaseGraph/connectoren verwerken/buildValidatedCombinedGraph ----
    const buildStepTimings: { label: string; elapsedMs: number }[] = [];
    const tBuild = Date.now();
    const graph = await buildValidatedCombinedGraph(provider, nwbSegments, CONNECTOR_SEARCH_TOLERANCE_M, validatedConnectors, (label, extra) => {
      const elapsedMs = typeof extra?.elapsedMs === "number" ? extra.elapsedMs : Date.now() - tBuild;
      buildStepTimings.push({ label, elapsedMs });
      reportProgress("latest", `timing-breakdown (build-stap): ${label}`, { totaalElapsedMs: Date.now() - t0, ...extra });
    });
    const buildTotalMs = Date.now() - tBuild;

    const clusterStep = buildStepTimings.find((s) => s.label.includes("clusters toegepast") || s.label.includes("clustering overgeslagen") || s.label.includes("Vooraf-berekende"));
    const nwbEdgesStep = buildStepTimings.find((s) => s.label.includes("NWB-edges toegevoegd"));
    const connectorProcessStep = buildStepTimings.find((s) => s.label.includes("connectoren verwerkt"));

    mark("10_clusteringDataVerwerken", { ms: clusterStep?.elapsedMs ?? null, detail: clusterStep?.label ?? "niet gevonden" });
    mark("12_connectorenVerwerken", connectorProcessStep ? { ms: connectorProcessStep.elapsedMs, aantalConnectoren: validatedConnectors.length } : { ms: null });
    mark("13_buildBaseGraph", { totaalMs: nwbEdgesStep?.elapsedMs ?? null });
    mark("14_buildValidatedCombinedGraph", { totaalMs: buildTotalMs });
    mark("17_overigeVerwerking", { ms: Math.max(0, buildTotalMs - (nwbEdgesStep?.elapsedMs ?? 0) - (connectorProcessStep?.elapsedMs ?? 0)) });

    const totalMs = Date.now() - t0;
    mark("18_totaleCombinedGraphLoad", { ms: totalMs });
    mark("1_vercelColdStartOverhead", {
      nietDirectMeetbaar: true,
      toelichting: "Vergelijk 18_totaleCombinedGraphLoad met de TOTALE tijd die de browser/Vercel-log toont voor deze aanvraag.",
    });

    return NextResponse.json({
      graphStats: { adjacencySize: graph.adjacency.size, nodePositionSize: graph.nodePosition.size, totalConnectorsCreated: graph.totalConnectorsCreated },
      breakdown,
      alleBuildStappenRuw: buildStepTimings,
    });
  } catch (err) {
    reportProgress("latest", "timing-breakdown: EXCEPTION", { error: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - t0 });
    return NextResponse.json(
      { error: "Timing-breakdown mislukt.", details: err instanceof Error ? err.message : String(err), breakdownTotNuToe: breakdown, elapsedMsTotNuToe: Date.now() - t0 },
      { status: 502 }
    );
  }
}
