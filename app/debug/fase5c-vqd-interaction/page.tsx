"use client";

import { useState } from "react";
import { buildValidatedCombinedGraph, computeConnectedComponents, dijkstraOnCombinedGraph, type SlimNwbSegment, type ValidatedConnectorInput } from "@/lib/nwb-analysis/combined-graph";
import { generateConnectorCandidates, type GoKnoopNodeInput } from "@/lib/nwb-analysis/connector-candidates";
import type { GraphProvider, GraphNode, GraphEdge } from "@/lib/route-engine/types";

const REGION = "volendam";
const SUSPECT_NODE_ID = "VQdRuD4Ms8f0sigZTCWP"; // het "diepste punt", tweemaal aangetroffen
const ROUTE_V1_FROM = "3Sx24AWzdYTR4Psx0JJW";
const ROUTE_V1_TO = "AG9myGNbdE6eH0W2SUmi";
const NORMAL_ROUTE_FROM = "KYgN1n5FB93kHhu0D2MU"; // v2 uit Fase 5B, een "normale" Volendam-route ter vergelijking
const NORMAL_ROUTE_TO = "Sxnbzx2IVYDbopuJM7u9";
const CLUSTER_TOLERANCE_M = 20; // zelfde tolerantie als bij het bouwen van de gecombineerde graaf

class ClientGraphProvider implements GraphProvider {
  private nodeMap = new Map<string, { id: string; x: number; y: number; displayNumber: string | null }>();
  private edgesByNode = new Map<string, GraphEdge[]>();
  constructor(nodes: { id: string; x: number; y: number; displayNumber: string | null }[], edges: { id: string; from: string; to: string; distanceM: number }[]) {
    for (const n of nodes) this.nodeMap.set(n.id, n);
    for (const e of edges) {
      const edge: GraphEdge = { id: e.id, fromLogicalNodeId: e.from, toLogicalNodeId: e.to, distanceM: e.distanceM, directionality: "unknown", geometry: [] };
      if (!this.edgesByNode.has(e.from)) this.edgesByNode.set(e.from, []);
      this.edgesByNode.get(e.from)!.push(edge);
      if (!this.edgesByNode.has(e.to)) this.edgesByNode.set(e.to, []);
      this.edgesByNode.get(e.to)!.push(edge);
    }
  }
  async load() {}
  getNode(id: string): GraphNode | undefined {
    const n = this.nodeMap.get(id);
    return n ? ({ id: n.id, x: n.x, y: n.y, displayNumber: n.displayNumber ?? undefined } as GraphNode) : undefined;
  }
  getAllNodeIds(): string[] {
    return Array.from(this.nodeMap.keys());
  }
  getEdgesFrom(id: string): GraphEdge[] {
    return this.edgesByNode.get(id) || [];
  }
}

function CopyAllButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button onClick={handleCopy} style={{ width: "100%", padding: 12, fontSize: 15, background: copied ? "#085041" : "#333", color: "white", border: "none", borderRadius: 8, marginBottom: 16 }}>
      {copied ? "Alles gekopieerd ✓" : "Kopieer ALLES (voor Claude)"}
    </button>
  );
}

/** Ontleedt een NWB-cluster-node-ID ("nwb:<segmentId>:<from|to>") terug naar zijn onderdelen. */
function parseNwbNodeId(nodeId: string): { segmentId: string; end: "from" | "to" } | null {
  if (!nodeId.startsWith("nwb:")) return null;
  const rest = nodeId.slice(4);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon === -1) return null;
  const end = rest.slice(lastColon + 1);
  if (end !== "from" && end !== "to") return null;
  return { segmentId: rest.slice(0, lastColon), end };
}

export default function Fase5cVqdInteractionPage() {
  const [datasetVersionId, setDatasetVersionId] = useState("uINZ3y2QsgBdEyky3duq");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);

  function getKey() {
    return window.localStorage.getItem("goknoop_debug_secret") || "";
  }

  async function run() {
    setRunning(true);
    setLog([]);
    setReport(null);
    const key = getKey();

    setLog((prev) => [...prev, "Volledige GoKnoop-graaf ophalen..."]);
    let rawNodes: { id: string; x: number; y: number; displayNumber: string | null }[] = [];
    let rawEdges: { id: string; from: string; to: string; distanceM: number }[] = [];
    let provider: ClientGraphProvider;
    try {
      const params = new URLSearchParams({ datasetVersionId });
      if (key) params.set("key", key);
      const res = await fetch(`/api/debug/fase4-goknoop-full-graph?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setLog((prev) => [...prev, `⚠️ ${json.details ?? json.error}`]);
        setRunning(false);
        return;
      }
      rawNodes = json.nodes;
      rawEdges = json.edges;
      provider = new ClientGraphProvider(rawNodes, rawEdges);
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ ${err instanceof Error ? err.message : String(err)}`]);
      setRunning(false);
      return;
    }

    // --- Punt 1: component van VQd... in de PURE GoKnoop-graaf. ---
    const goknoopOnlyGraph = buildValidatedCombinedGraph(provider, [], 20, []);
    const goknoopOnlyComponents = computeConnectedComponents(goknoopOnlyGraph);
    const suspectRoot = goknoopOnlyComponents.componentOfNode.get(SUSPECT_NODE_ID);
    let suspectComponentSize = 0;
    for (const root of goknoopOnlyComponents.componentOfNode.values()) if (root === suspectRoot) suspectComponentSize++;
    const suspectNode = provider.getNode(SUSPECT_NODE_ID);
    const suspectDegree = provider.getEdgesFrom(SUSPECT_NODE_ID).length;

    setLog((prev) => [...prev, `VQd... zit in component van ${suspectComponentSize} nodes (van ${goknoopOnlyComponents.componentCount} totaal), graad ${suspectDegree}.`]);

    // --- NWB-data voor Volendam laden (zelfde als eerder). ---
    setLog((prev) => [...prev, "Volendam NWB-tegels lezen..."]);
    const segmentsById = new Map<string, SlimNwbSegment>();
    let offset = 0;
    for (;;) {
      try {
        const params = new URLSearchParams({ region: REGION, offset: String(offset) });
        if (key) params.set("key", key);
        const res = await fetch(`/api/debug/nwb-collector-read-tiles?${params.toString()}`, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok) break;
        for (const seg of json.segments as SlimNwbSegment[]) segmentsById.set(seg.id, seg);
        if (json.done) break;
        offset += json.tilesInPage;
      } catch {
        break;
      }
    }
    const nwbSegments = Array.from(segmentsById.values());

    let goknoopBearingNodes: GoKnoopNodeInput[] = [];
    try {
      const params = new URLSearchParams({ region: REGION, datasetVersionId });
      if (key) params.set("key", key);
      const res = await fetch(`/api/debug/nwb-collector-goknoop-bearings?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (res.ok) goknoopBearingNodes = json.nodes;
    } catch {
      /* leeg */
    }

    await new Promise((r) => setTimeout(r, 20));
    const candidateResult = generateConnectorCandidates(goknoopBearingNodes, nwbSegments, 20);
    const validatedConnectors: ValidatedConnectorInput[] = candidateResult.candidates
      .filter((c) => c.confidence !== "rejected")
      .map((c) => ({ goknoopNodeId: c.goknoopNodeId, nwbSegmentId: c.nwbSegmentId, nwbEndpoint: c.nwbEndpoint, distanceM: c.distanceM, confidence: c.confidence as "high" | "lower" }));

    // --- Punt 2: heeft VQd... zelf een connector in dit gebied? (verwachting: nee, ligt buiten Volendam-bbox). ---
    const connectorsAtSuspectNode = validatedConnectors.filter((c) => c.goknoopNodeId === SUSPECT_NODE_ID);
    let nearestNwbSegmentToSuspect: { segmentId: string; distanceM: number } | null = null;
    if (suspectNode) {
      let minDist = Infinity;
      let minSegId = "";
      for (const seg of nwbSegments) {
        const dFrom = Math.hypot(seg.from.x - suspectNode.x, seg.from.y - suspectNode.y);
        const dTo = Math.hypot(seg.to.x - suspectNode.x, seg.to.y - suspectNode.y);
        const d = Math.min(dFrom, dTo);
        if (d < minDist) {
          minDist = d;
          minSegId = seg.id;
        }
      }
      if (minSegId) nearestNwbSegmentToSuspect = { segmentId: minSegId, distanceM: Math.round(minDist) };
    }

    const combined = buildValidatedCombinedGraph(provider, nwbSegments, 20, validatedConnectors);

    // --- Punt 3: volledige padtrace v1, met expliciete lijst van connector-overgangen. ---
    setLog((prev) => [...prev, "Route v1 natrekken..."]);
    const routeV1 = dijkstraOnCombinedGraph(combined, ROUTE_V1_FROM, ROUTE_V1_TO);

    function analyzeRoute(result: ReturnType<typeof dijkstraOnCombinedGraph>) {
      if (!result.found) return { routeFound: false };
      const connectorTransitions = result.steps
        .map((s, i) => ({ index: i, nodeId: s.nodeId, bron: s.edgeSource, cumulatieveAfstandM: Math.round(s.distanceM) }))
        .filter((s) => s.bron === "connector");

      // --- Punt 5: voor elke gebruikte connector, de geografische spreiding van de NWB-cluster aan de andere kant checken. ---
      const clusterSpreadChecks = connectorTransitions.map((ct) => {
        const parsed = parseNwbNodeId(ct.nodeId);
        if (!parsed) return { ...ct, clusterCheck: "GoKnoop-kant van de connector, geen NWB-cluster hier" };
        const anchorSeg = nwbSegments.find((s) => s.id === parsed.segmentId);
        if (!anchorSeg) return { ...ct, clusterCheck: "NWB-segment niet gevonden" };
        const anchorPoint = parsed.end === "from" ? anchorSeg.from : anchorSeg.to;

        // Alle NWB-eindpunten die binnen CLUSTER_TOLERANCE_M van dit anker-punt liggen (= dezelfde cluster).
        const clusterMembers: { segmentId: string; end: string; x: number; y: number }[] = [];
        for (const seg of nwbSegments) {
          const dFrom = Math.hypot(seg.from.x - anchorPoint.x, seg.from.y - anchorPoint.y);
          const dTo = Math.hypot(seg.to.x - anchorPoint.x, seg.to.y - anchorPoint.y);
          if (dFrom <= CLUSTER_TOLERANCE_M) clusterMembers.push({ segmentId: seg.id, end: "from", x: seg.from.x, y: seg.from.y });
          if (dTo <= CLUSTER_TOLERANCE_M) clusterMembers.push({ segmentId: seg.id, end: "to", x: seg.to.x, y: seg.to.y });
        }
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const m of clusterMembers) {
          if (m.x < minX) minX = m.x;
          if (m.x > maxX) maxX = m.x;
          if (m.y < minY) minY = m.y;
          if (m.y > maxY) maxY = m.y;
        }
        const spreadM = minX !== Infinity ? Math.hypot(maxX - minX, maxY - minY) : 0;
        return {
          ...ct,
          nwbSegmentId: parsed.segmentId,
          clusterLedenAantal: clusterMembers.length,
          clusterSpreidingM: Math.round(spreadM),
          VERDACHT: spreadM > 500 ? `JA -- cluster spreidt ${Math.round(spreadM)}m, veel groter dan de ${CLUSTER_TOLERANCE_M}m-tolerantie zou moeten toestaan` : "nee",
        };
      });

      return {
        routeFound: true,
        totaleAfstandM: Math.round(result.distanceM),
        totalHops: result.steps.length,
        goknoopEdgeCount: result.goknoopEdgeCount,
        nwbEdgeCount: result.nwbEdgeCount,
        connectorCount: result.connectorCount,
        eersteTwintigStappen: result.steps.slice(0, 20).map((s) => ({ nodeId: s.nodeId, bron: s.edgeSource, cumulatieveAfstandM: Math.round(s.distanceM) })),
        laatsteTwintigStappen: result.steps.slice(-20).map((s) => ({ nodeId: s.nodeId, bron: s.edgeSource, cumulatieveAfstandM: Math.round(s.distanceM) })),
        alleConnectorOvergangenMetClusterCheck: clusterSpreadChecks,
      };
    }

    const routeV1Analysis = analyzeRoute(routeV1);

    // --- Punt 4: vergelijking met een normale route. ---
    setLog((prev) => [...prev, "Normale referentieroute natrekken..."]);
    const normalRoute = dijkstraOnCombinedGraph(combined, NORMAL_ROUTE_FROM, NORMAL_ROUTE_TO);
    const normalRouteAnalysis = analyzeRoute(normalRoute);

    setReport({
      punt1_componentPureGoKnoop: {
        nodeId: SUSPECT_NODE_ID,
        componentId: suspectRoot,
        aantalNodesInComponent: suspectComponentSize,
        graadVanDezeNode: suspectDegree,
        grootsteComponentTerVergelijking: goknoopOnlyComponents.largestComponentSize,
        zitInGrootsteComponent: suspectComponentSize === goknoopOnlyComponents.largestComponentSize,
      },
      punt2_nwbBijVQd: {
        connectorsDirectOpVQd: connectorsAtSuspectNode.length,
        dichtstbijzijndeNwbSegmentTotVQd: nearestNwbSegmentToSuspect,
        VERWACHTING: "VQd ligt buiten alle drie de verzamelde NWB-regio's (Hilversum/Lochem/Volendam) -- verwacht GEEN NWB-data in de buurt.",
      },
      punt3en5_routeV1_3SxNaarAG9: routeV1Analysis,
      punt4_normaleReferentieroute_KYgNaarSxn: normalRouteAnalysis,
    });
    setLog((prev) => [...prev, "Analyse klaar."]);
    setRunning(false);
  }

  const copyText = report ? JSON.stringify(report, null, 2) : "";

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Fase 5C — GoKnoop↔NWB-interactie bij VQd...</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Component-analyse, volledige padtrace met connector-overgangen, cluster-spreidingscheck per connector, vergelijking met een normale route. Geen reparatie.
      </p>

      <input value={datasetVersionId} onChange={(e) => setDatasetVersionId(e.target.value)} placeholder="datasetVersionId" style={{ width: "100%", padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12 }} />

      <button onClick={run} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig..." : "Start analyse"}
      </button>

      {log.length > 0 && (
        <div style={{ fontSize: 11, background: "#f0f0eb", padding: 10, borderRadius: 8, marginBottom: 12, maxHeight: 200, overflowY: "auto" }}>
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}

      {report && (
        <>
          <CopyAllButton text={copyText} />
          <pre style={{ fontSize: 9, background: "#f5f5f0", padding: 8, borderRadius: 6, overflowX: "auto", whiteSpace: "pre-wrap" }}>{copyText}</pre>
        </>
      )}
    </div>
  );
}
