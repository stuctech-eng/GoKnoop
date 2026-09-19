import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { loadPrecomputedOrBuildGraph } from "@/lib/route-engine/load-precomputed-graph";
import type { ValidatedConnectorInput, SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * TOEGEVOEGD 19-9-2026 (GO van Te, numerieke verificatie van de connector-
 * afstandsbron-hypothese, decisions-and-calibration.md). UITSLUITEND LEZEN --
 * geen enkele write, geen wijziging aan productiecode/-data.
 *
 * Voor elk van de twee bekende afwijkende hops (Volendam-kandidaat 0):
 * - Hop 4:  GoKnoop IzVQHoyBNiAZQ1Ss8yhQ -> cluster nwb:23832, verwachte edge-distanceM ~4,12
 * - Hop 52: GoKnoop 4TebNUQu8QVISxRNzj72 -> cluster nwb:46988, verwachte edge-distanceM ~1,40
 *
 * Zoekt in de daadwerkelijk opgeslagen `nwbConnectors` de kandidaat wiens
 * `distanceM` overeenkomt met de edge-distanceM die de graaf gebruikte (bij
 * meerdere parallelle kandidaten identificeert dit welke specifieke
 * connector-record de route daadwerkelijk gebruikte), haalt vervolgens het
 * bijbehorende ruwe NWB-segment-eindpunt op (nwbSegments/batches, exact
 * dezelfde opslagvorm als cached-nwb-provider.ts al gebruikt), en vergelijkt:
 *   1. GoKnoop-node -> oorspronkelijk NWB-eindpunt (moet ~= opgeslagen distanceM zijn)
 *   2. GoKnoop-node -> huidige clusterrepresentant (graph.nodePosition, zoals productie 'm nu gebruikt)
 *   3. verschil tussen 1 en 2 (moet overeenkomen met de eerder gemeten +25,71m / +12,65m)
 *
 * GET /api/admin/diagnose-connector-distance-origin?key=<DEBUG_SECRET>&targets=<goknoopNodeId>|<clusterNodeId>|<expectedGraphDistanceM>|<expectedDiffM>,...
 *
 * HERZIEN 19-9-2026 (GO van Te, generalisatie voor Lochem/rondje): oorspronkelijk
 * hardcoded op de 2 Volendam-hops. Nu generiek via de `targets`-queryparameter --
 * zelfde logica, dupliceert niets, alleen de hardcoded lijst vervangen door invoer.
 * Zonder `targets` valt terug op de eerder bewezen 2 Volendam-hops (ongewijzigd
 * reproduceerbaar).
 */

type Target = { label: string; goknoopNodeId: string; clusterNodeId: string; expectedGraphDistanceM: number; expectedDiffM: number };

const DEFAULT_TARGETS: Target[] = [
  { label: "volendam-hop4", goknoopNodeId: "IzVQHoyBNiAZQ1Ss8yhQ", clusterNodeId: "nwb:23832", expectedGraphDistanceM: 4.1212530379506696, expectedDiffM: 25.710674053684247 },
  { label: "volendam-hop52", goknoopNodeId: "4TebNUQu8QVISxRNzj72", clusterNodeId: "nwb:46988", expectedGraphDistanceM: 1.4030992276429382, expectedDiffM: 12.647387837443945 },
];

function parseTargets(raw: string): Target[] | null {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const targets: Target[] = [];
  for (let i = 0; i < parts.length; i++) {
    const fields = parts[i].split("|");
    if (fields.length !== 4) return null;
    const [goknoopNodeId, clusterNodeId, expectedGraphDistanceMStr, expectedDiffMStr] = fields;
    const expectedGraphDistanceM = Number(expectedGraphDistanceMStr);
    const expectedDiffM = Number(expectedDiffMStr);
    if (!goknoopNodeId || !clusterNodeId || Number.isNaN(expectedGraphDistanceM) || Number.isNaN(expectedDiffM)) return null;
    targets.push({ label: `target${i}`, goknoopNodeId, clusterNodeId, expectedGraphDistanceM, expectedDiffM });
  }
  return targets;
}

function distanceOf(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const targetsParam = req.nextUrl.searchParams.get("targets");
  let targets: Target[];
  if (targetsParam) {
    const parsed = parseTargets(targetsParam);
    if (!parsed || parsed.length === 0) {
      return NextResponse.json({ error: "Ongeldig 'targets'-formaat. Verwacht: goknoopNodeId|clusterNodeId|expectedGraphDistanceM|expectedDiffM, kommagescheiden voor meerdere." }, { status: 400 });
    }
    targets = parsed;
  } else {
    targets = DEFAULT_TARGETS;
  }

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const activeNwbSnap = await db.collection("config").doc("activeNwbDataset").get();
    const nwbDatasetVersionId: string | null = activeNwbSnap.exists ? (activeNwbSnap.data()!.nwbDatasetVersionId as string) : null;
    if (!nwbDatasetVersionId) {
      return NextResponse.json({ error: "Geen actieve NWB-dataset geconfigureerd." }, { status: 500 });
    }

    // Exact hetzelfde laadpad als /api/route/to-destination -- voor graph.nodePosition
    // (de huidige clusterrepresentant-coördinaten, zoals productie ze nu gebruikt).
    const provider = new CachedGraphProvider(datasetVersionId);
    const providerLoadPromise = provider.load();
    const graphLoadPromise = loadPrecomputedOrBuildGraph(provider, datasetVersionId, providerLoadPromise);
    await providerLoadPromise;
    const { graph } = await graphLoadPromise;

    // Alle validatedConnectors ophalen -- exact dezelfde Firestore-locatie als cached-nwb-provider.ts.
    const connectorsKey = `${nwbDatasetVersionId}_${datasetVersionId}`;
    const connectorsSnap = await db.collection("nwbConnectors").doc(connectorsKey).collection("connectors").get();
    const allConnectors = connectorsSnap.docs.map((d) => d.data() as ValidatedConnectorInput);

    // Alle NWB-segmenten ophalen (gebatchte documenten) -- alleen om de twee benodigde
    // segment-ID's erin op te zoeken, exact dezelfde opslagvorm als cached-nwb-provider.ts.
    const batchesSnap = await db.collection("nwbSegments").doc(nwbDatasetVersionId).collection("batches").get();
    const segmentsById = new Map<string, SlimNwbSegment>();
    for (const doc of batchesSnap.docs) {
      const data = doc.data() as { segments: SlimNwbSegment[] };
      for (const seg of data.segments) segmentsById.set(seg.id, seg);
    }

    const results = targets.map((target) => {
      const goknoopNode = provider.getNode(target.goknoopNodeId);
      const clusterPos = graph.nodePosition.get(target.clusterNodeId);

      // Kandidaat-connectors voor deze GoKnoop-node, gesorteerd op hoe dicht hun eigen
      // distanceM bij de daadwerkelijk door de graaf gebruikte edge-distanceM ligt --
      // de dichtstbijzijnde identificeert welke specifieke connector-record dit was.
      const candidateConnectors = allConnectors
        .filter((c) => c.goknoopNodeId === target.goknoopNodeId)
        .map((c) => ({ connector: c, deltaFromExpected: Math.abs(c.distanceM - target.expectedGraphDistanceM) }))
        .sort((a, b) => a.deltaFromExpected - b.deltaFromExpected);

      const matched = candidateConnectors[0];
      if (!goknoopNode || !clusterPos || !matched) {
        return {
          label: target.label,
          error: "Kon GoKnoop-node, clusterpositie of een matchende connector niet vinden.",
          goknoopNodeFound: !!goknoopNode,
          clusterPosFound: !!clusterPos,
          candidateConnectorCount: candidateConnectors.length,
        };
      }

      const matchedConnector = matched.connector;
      const segment = segmentsById.get(matchedConnector.nwbSegmentId);
      const originalEndpoint = segment ? (matchedConnector.nwbEndpoint === "from" ? segment.from : segment.to) : null;

      const distGoknoopToOriginalEndpoint = originalEndpoint ? distanceOf(goknoopNode, originalEndpoint) : null;
      const distGoknoopToClusterRepresentative = distanceOf(goknoopNode, clusterPos);
      const diffM = distGoknoopToOriginalEndpoint !== null ? distGoknoopToClusterRepresentative - distGoknoopToOriginalEndpoint : null;
      const storedDistanceMatchesOriginalEndpointDistance =
        distGoknoopToOriginalEndpoint !== null ? Math.abs(matchedConnector.distanceM - distGoknoopToOriginalEndpoint) < 0.01 : null;

      return {
        label: target.label,
        goknoopNodeId: target.goknoopNodeId,
        clusterNodeId: target.clusterNodeId,
        candidateConnectorCountForThisNode: candidateConnectors.length,
        matchedConnectorDeltaFromExpectedGraphDistanceM: matched.deltaFromExpected,
        matchedConnector: {
          nwbSegmentId: matchedConnector.nwbSegmentId,
          nwbEndpoint: matchedConnector.nwbEndpoint,
          storedDistanceM: matchedConnector.distanceM,
          confidence: matchedConnector.confidence,
        },
        segmentFound: !!segment,
        originalEndpoint,
        clusterRepresentativePos: clusterPos,
        distGoknoopToOriginalEndpointM: distGoknoopToOriginalEndpoint,
        distGoknoopToClusterRepresentativeM: distGoknoopToClusterRepresentative,
        storedDistanceMatchesOriginalEndpointDistance,
        computedDiffM: diffM,
        expectedGraphDistanceM: target.expectedGraphDistanceM,
        expectedDiffM: target.expectedDiffM,
        diffMatchesExpected: diffM !== null ? Math.abs(diffM - target.expectedDiffM) < 0.5 : null,
      };
    });

    return NextResponse.json({
      datasetVersionId,
      nwbDatasetVersionId,
      totalConnectorsLoaded: allConnectors.length,
      totalSegmentsLoaded: segmentsById.size,
      results,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Diagnose mislukt.", details: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
      { status: 502 }
    );
  }
}
