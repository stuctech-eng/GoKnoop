import { NextRequest, NextResponse } from "next/server";
import { getDb, getLastDbInitBreakdown } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { buildValidatedCombinedGraph, type SlimNwbSegment, type ValidatedConnectorInput } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const CONNECTOR_SEARCH_TOLERANCE_M = 20;

/**
 * GET /api/admin/timing-breakdown
 *
 * Definitieve performance-audit, 12-9-2026. Reconstrueert de VOLLEDIGE
 * combinedGraphLoad-keten (GoKnoop laden, NWB laden, clustering toepassen,
 * connectoren verwerken) met een expliciet tijdstempel op ELKE deelstap --
 * geen enkele stap blijft ongemeten. Retourneert één gestructureerde JSON-
 * respons in plaats van los log-gegraaf.
 *
 * BELANGRIJKE, EERLIJKE BEPERKING (punt 1 uit de opdracht -- "Vercel/
 * serverless cold-start overhead"): dit is van BINNENUIT de aanvraag NIET
 * direct meetbaar. Onze eigen code (en dus elke tijdmeting hier) begint pas
 * te lopen NADAT de Vercel-sandbox al is opgestart en onze module al is
 * geladen -- de tijd die dat zelf kost, valt buiten wat een request-handler
 * ooit kan waarnemen. Het dichtstbijzijnde, indirecte bewijs: het verschil
 * tussen de TOTALE tijd die de browser/Vercel-edge rapporteert (zichtbaar in
 * de 504-melding of devtools) en de som van alle hieronder gemeten stappen.
 * Als die twee dicht bij elkaar liggen, is er weinig onzichtbare overhead;
 * een groot verschil zou juist op aanzienlijke, onmeetbare cold-start-tijd
 * wijzen. We rapporteren daarom expliciet "nietDirectMeetbaar" voor dit punt
 * i.p.v. een verzonnen getal te tonen.
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

  try {
    // ---- 2. Firebase/Firestore-initialisatie ----
    const tFirebase = Date.now();
    const db = getDb();
    const dbInitBreakdown = getLastDbInitBreakdown();
    breakdown["2_firebaseInitialisatie"] = {
      totaalMs: Date.now() - tFirebase,
      ...dbInitBreakdown,
      toelichting: "initializeAppMs is 0 bij een warme herhaalaanroep binnen dezelfde instance (de Firebase-app bestond al).",
    };

    // ---- 3. GoKnoop dataset lookup ----
    const tGkLookup = Date.now();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;
    breakdown["3_goknoopDatasetLookup"] = { ms: Date.now() - tGkLookup, datasetVersionId };

    // ---- 4+5. GoKnoop nodes/edges lezen (via CachedGraphProvider -> FirestoreGraphProvider) ----
    const tGkLoad = Date.now();
    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();
    breakdown["4_5_goknoopNodesEnEdgesLezen"] = {
      totaalMs: Date.now() - tGkLoad,
      cacheHit: provider.wasCacheHit,
      copyNaarEigenMapsMs: provider.lastCopyTimingMs,
      toelichting: "Fetch+parse-detail (node vs edge apart) staat in de reportProgress-checkpoints van FirestoreGraphProvider.load() -- zie /api/admin/read-progress voor de ruwe checkpoints van DEZE aanroep.",
      nodeCount: provider.getAllNodeIds().length,
    };

    // ---- 6. NWB dataset lookup ----
    const tNwbLookup = Date.now();
    const activeNwbSnap = await db.collection("config").doc("activeNwbDataset").get();
    const nwbDatasetVersionId: string | null = activeNwbSnap.exists ? (activeNwbSnap.data()!.nwbDatasetVersionId as string) : null;
    breakdown["6_nwbDatasetLookup"] = { ms: Date.now() - tNwbLookup, nwbDatasetVersionId };

    let nwbSegments: SlimNwbSegment[] = [];
    let validatedConnectors: ValidatedConnectorInput[] = [];

    if (nwbDatasetVersionId) {
      // ---- 7+8. NWB Firestore reads + deserialisatie (apart gemeten) ----
      const tNwbFetch = Date.now();
      const batchesSnap = await db.collection("nwbSegments").doc(nwbDatasetVersionId).collection("batches").get();
      const nwbFetchMs = Date.now() - tNwbFetch;

      const tNwbParse = Date.now();
      for (const doc of batchesSnap.docs) {
        const data = doc.data() as { segments: SlimNwbSegment[] };
        nwbSegments.push(...data.segments);
      }
      const nwbParseMs = Date.now() - tNwbParse;
      breakdown["7_nwbFirestoreReads"] = { ms: nwbFetchMs, aantalBatchDocumenten: batchesSnap.docs.length };
      breakdown["8_nwbDataDeserialisatie"] = { ms: nwbParseMs, toelichting: "doc.data() + push() van alle segmenten uit de batchdocumenten." };

      // ---- 9. NWB segment parsing ----
      // (Bij deze architectuur is 'parsing' hetzelfde als de deserialisatie hierboven --
      // er is geen apart, tweede parse-station. Expliciet zo benoemd om geen fictief getal te tonen.)
      breakdown["9_nwbSegmentParsing"] = { ms: 0, toelichting: "Samengevallen met stap 8 -- geen apart parse-station in de huidige architectuur." };

      // ---- 11. connectoren lezen ----
      const connectorsKey = `${nwbDatasetVersionId}_${datasetVersionId}`;
      const tConnFetch = Date.now();
      const connectorsSnap = await db.collection("nwbConnectors").doc(connectorsKey).collection("connectors").get();
      validatedConnectors = connectorsSnap.docs.map((d) => d.data() as ValidatedConnectorInput);
      breakdown["11_connectorenLezen"] = { ms: Date.now() - tConnFetch, aantalConnectoren: validatedConnectors.length };
    } else {
      breakdown["7_nwbFirestoreReads"] = { ms: 0, toelichting: "Geen actieve NWB-dataset -- overgeslagen." };
      breakdown["8_nwbDataDeserialisatie"] = { ms: 0 };
      breakdown["9_nwbSegmentParsing"] = { ms: 0 };
      breakdown["11_connectorenLezen"] = { ms: 0 };
    }

    // ---- 10. clustering-data verwerken + 13/14/15/16. buildBaseGraph/buildValidatedCombinedGraph/adjacency/nodePosition ----
    // Deze stappen zitten intern in buildValidatedCombinedGraph -- de reportProgress-callback
    // vangt elke deelstap apart op, we tellen ze hier expliciet op tot een samenvatting.
    const buildStepTimings: { label: string; elapsedMs: number }[] = [];
    const tBuild = Date.now();
    const graph = await buildValidatedCombinedGraph(provider, nwbSegments, CONNECTOR_SEARCH_TOLERANCE_M, validatedConnectors, (label, extra) => {
      buildStepTimings.push({ label, elapsedMs: typeof extra?.elapsedMs === "number" ? extra.elapsedMs : Date.now() - tBuild });
    });
    const buildTotalMs = Date.now() - tBuild;

    const clusterStep = buildStepTimings.find((s) => s.label.includes("clusters toegepast") || s.label.includes("clustering overgeslagen") || s.label.includes("Vooraf-berekende"));
    const nwbEdgesStep = buildStepTimings.find((s) => s.label.includes("NWB-edges toegevoegd"));
    const connectorProcessStep = buildStepTimings.find((s) => s.label.includes("connectoren verwerkt"));

    breakdown["10_clusteringDataVerwerken"] = { ms: clusterStep?.elapsedMs ?? null, detail: clusterStep?.label ?? "niet gevonden in build-stappen" };
    breakdown["12_connectorenVerwerken"] = connectorProcessStep
      ? { ms: connectorProcessStep.elapsedMs, aantalConnectoren: validatedConnectors.length, toelichting: "Was tot deze audit VOLLEDIG ONGEMETEN -- nieuw toegevoegd." }
      : { ms: null, toelichting: "Geen data (waarschijnlijk 0 connectoren of functie niet bereikt)." };
    breakdown["13_buildBaseGraph"] = { totaalMs: nwbEdgesStep?.elapsedMs ?? null, toelichting: "Cumulatieve tijd tot en met 'NWB-edges toegevoegd', binnen buildBaseGraph zelf." };
    breakdown["14_buildValidatedCombinedGraph"] = { totaalMs: buildTotalMs };
    breakdown["15_adjacencyOpbouw"] = { toelichting: "Gebeurt incrementeel dwars door buildBaseGraph heen (elke addEdge-aanroep) -- geen apart, geïsoleerd tijdsblok in de huidige architectuur." };
    breakdown["16_nodePositionOpbouw"] = { toelichting: "Zelfde als adjacency -- incrementeel, geen apart tijdsblok." };
    breakdown["17_overigeVerwerking"] = { ms: Math.max(0, buildTotalMs - (nwbEdgesStep?.elapsedMs ?? 0) - (connectorProcessStep?.elapsedMs ?? 0)) };
    breakdown["alleBuildStappenRuw"] = buildStepTimings;

    // ---- 18. totale combinedGraphLoad ----
    const totalMs = Date.now() - t0;
    breakdown["18_totaleCombinedGraphLoad"] = { ms: totalMs };

    // ---- 1. Vercel/serverless cold-start overhead ----
    breakdown["1_vercelColdStartOverhead"] = {
      nietDirectMeetbaar: true,
      toelichting: "Zie module-commentaar bovenaan dit bestand. Vergelijk 'ms' bij 18_totaleCombinedGraphLoad met de TOTALE tijd die je browser/Vercel-log toont voor deze aanvraag -- het verschil is de indirecte schatting.",
    };

    return NextResponse.json({
      graphStats: { adjacencySize: graph.adjacency.size, nodePositionSize: graph.nodePosition.size, totalConnectorsCreated: graph.totalConnectorsCreated },
      breakdown,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Timing-breakdown mislukt.", details: err instanceof Error ? err.message : String(err), breakdownTotNuToe: breakdown, elapsedMsTotNuToe: Date.now() - t0 },
      { status: 502 }
    );
  }
}
