"use client";

import { useState } from "react";
import {
  buildValidatedCombinedGraph,
  computeConnectedComponents,
  dijkstraOnCombinedGraph,
  type SlimNwbSegment,
  type ValidatedConnectorInput,
} from "@/lib/nwb-analysis/combined-graph";
import { generateConnectorCandidates, type GoKnoopNodeInput, type NwbSegmentInput } from "@/lib/nwb-analysis/connector-candidates";
import type { GraphProvider, GraphNode, GraphEdge } from "@/lib/route-engine/types";

const FASE1_BASELINE = { totalNodes: 11003, componentCount: 1111, largestComponentSize: 8372, largestComponentPercent: 76.1 };

const REGIONS: Record<string, { label: string; from?: string; to?: string; pairwise?: string[] }> = {
  hilversum: { label: "Amsterdam -> Hilversum", from: "CJSXBPUMG49vOPmYvhJd", to: "ZYuO6ZfzSa2iim0HcUbn" },
  volendam: { label: "Volendam -> Amsterdam (bekende succesroute)", from: "7fmSWIHYsKu3Wb3yOtM2", to: "CJSXBPUMG49vOPmYvhJd" },
  lochem: {
    label: "Lochem (5 kandidaat-startpunten, pairwise reachability i.p.v. letterlijke rondje-generator -- zie toelichting)",
    pairwise: ["9cdQ8xUK4u2DFybtRTfg", "bR0u430Tm1qT6yHBUU4k", "CDdOFbRpdb959FzzPLc0", "DULwi9RMia4vV4Wbdc2a", "3rnbURpA3ImMOs940vR8"],
  },
};

/** Client-side GraphProvider-adapter om de platte, landelijke JSON-graaf te laten werken met buildValidatedCombinedGraph (die de echte GraphProvider-interface verwacht). */
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

export default function Fase4CombinedTopologyPage() {
  const [datasetVersionId, setDatasetVersionId] = useState("uINZ3y2QsgBdEyky3duq");
  const [searchRadiusM] = useState(20);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);

  function getKey() {
    return window.localStorage.getItem("goknoop_debug_secret") || "";
  }

  async function runAll() {
    setRunning(true);
    setLog([]);
    setReport(null);
    const key = getKey();
    const regionReports: Record<string, unknown> = {};

    // Stap 1: volledige, landelijke GoKnoop-graaf (1x, hergebruikt voor elke regio).
    setLog((prev) => [...prev, "Volledige GoKnoop-graaf ophalen..."]);
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
      provider = new ClientGraphProvider(json.nodes, json.edges);
      setLog((prev) => [...prev, `GoKnoop-graaf: ${json.nodeCount} nodes, ${json.edgeCount} edges.`]);
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ ${err instanceof Error ? err.message : String(err)}`]);
      setRunning(false);
      return;
    }

    for (const [regionKey, region] of Object.entries(REGIONS)) {
      setLog((prev) => [...prev, `--- ${regionKey}: NWB-tegels lezen ---`]);

      const segmentsById = new Map<string, SlimNwbSegment>();
      let offset = 0;
      for (;;) {
        try {
          const params = new URLSearchParams({ region: regionKey, offset: String(offset) });
          if (key) params.set("key", key);
          const res = await fetch(`/api/debug/nwb-collector-read-tiles?${params.toString()}`, { cache: "no-store" });
          const json = await res.json();
          if (!res.ok) {
            setLog((prev) => [...prev, `⚠️ ${regionKey}: ${json.details ?? json.error}`]);
            break;
          }
          for (const seg of json.segments as SlimNwbSegment[]) segmentsById.set(seg.id, seg);
          if (json.done) break;
          offset += json.tilesInPage;
        } catch (err) {
          setLog((prev) => [...prev, `⚠️ ${regionKey}: ${err instanceof Error ? err.message : String(err)}`]);
          break;
        }
      }
      const nwbSegments: SlimNwbSegment[] = Array.from(segmentsById.values());
      setLog((prev) => [...prev, `${regionKey}: ${nwbSegments.length} NWB-segmenten.`]);

      setLog((prev) => [...prev, `${regionKey}: GoKnoop-richtingen ophalen + connectorkandidaten regenereren...`]);
      let goknoopBearingNodes: GoKnoopNodeInput[] = [];
      try {
        const params = new URLSearchParams({ region: regionKey, datasetVersionId });
        if (key) params.set("key", key);
        const res = await fetch(`/api/debug/nwb-collector-goknoop-bearings?${params.toString()}`, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok) {
          setLog((prev) => [...prev, `⚠️ ${regionKey}: ${json.details ?? json.error}`]);
          continue;
        }
        goknoopBearingNodes = json.nodes;
      } catch (err) {
        setLog((prev) => [...prev, `⚠️ ${regionKey}: ${err instanceof Error ? err.message : String(err)}`]);
        continue;
      }

      await new Promise((r) => setTimeout(r, 20));
      const candidateResult = generateConnectorCandidates(goknoopBearingNodes, nwbSegments, searchRadiusM);
      const validatedConnectors: ValidatedConnectorInput[] = candidateResult.candidates
        .filter((c) => c.confidence !== "rejected")
        .map((c) => ({
          goknoopNodeId: c.goknoopNodeId,
          nwbSegmentId: c.nwbSegmentId,
          nwbEndpoint: c.nwbEndpoint,
          distanceM: c.distanceM,
          confidence: c.confidence as "high" | "lower",
        }));
      setLog((prev) => [...prev, `${regionKey}: ${validatedConnectors.length} gevalideerde connectoren (${candidateResult.summary.highConfidence} high, ${candidateResult.summary.lowerConfidence} lower). ${candidateResult.summary.rejected} afgewezen, NIET meegenomen.`]);

      setLog((prev) => [...prev, `${regionKey}: gecombineerde graaf bouwen + topologie meten...`]);
      await new Promise((r) => setTimeout(r, 20));
      const combined = await buildValidatedCombinedGraph(provider, nwbSegments, searchRadiusM, validatedConnectors);
      const componentStats = computeConnectedComponents(combined);

      let totalEdges = 0;
      for (const edges of combined.adjacency.values()) totalEdges += edges.length;

      const regionReport: Record<string, unknown> = {
        topologie: {
          totalNodes: componentStats.totalNodes,
          totalDirectedEdgeEntries: totalEdges,
          connectors: combined.connectorsUsed,
          componentCount: componentStats.componentCount,
          largestComponentSize: componentStats.largestComponentSize,
          largestComponentPercent: Math.round(componentStats.largestComponentPercent * 10) / 10,
          vergelekenMetFase1Baseline: {
            fase1: FASE1_BASELINE,
            verschilComponentCount: componentStats.componentCount - FASE1_BASELINE.componentCount,
            verschilLargestComponentPercent: Math.round((componentStats.largestComponentPercent - FASE1_BASELINE.largestComponentPercent) * 10) / 10,
          },
        },
      };

      // Reachability-tests -- UITSLUITEND bereikbaarheid/topologie, GEEN kwaliteitsoordeel.
      if (region.from && region.to) {
        const result = dijkstraOnCombinedGraph(combined, region.from, region.to);
        regionReport.reachabilityTest = result.found
          ? {
              label: region.label,
              routeFound: true,
              distanceM: Math.round(result.distanceM),
              LET_OP: "Dit is UITSLUITEND een bereikbaarheids-/topologiemeting. Geen uitspraak over routekwaliteit -- dat is Fase 5.",
              goknoopEdgeCount: result.goknoopEdgeCount,
              nwbEdgeCount: result.nwbEdgeCount,
              connectorCount: result.connectorCount,
              totalHops: result.steps.length,
            }
          : { label: region.label, routeFound: false };
      } else if (region.pairwise) {
        const pairwiseResults: Record<string, unknown> = {};
        for (let i = 0; i < region.pairwise.length; i++) {
          for (let j = i + 1; j < region.pairwise.length; j++) {
            const a = region.pairwise[i];
            const b = region.pairwise[j];
            const result = dijkstraOnCombinedGraph(combined, a, b);
            pairwiseResults[`${a.slice(0, 6)}...->${b.slice(0, 6)}...`] = result.found ? { routeFound: true, distanceM: Math.round(result.distanceM) } : { routeFound: false };
          }
        }
        regionReport.reachabilityTest = { label: region.label, pairwiseResults };
      }

      regionReports[regionKey] = regionReport;
      setLog((prev) => [...prev, `✅ ${regionKey}: klaar.`]);
    }

    setReport(regionReports);
    setLog((prev) => [...prev, "Alle regio's klaar."]);
    setRunning(false);
  }

  const copyText = report ? JSON.stringify(report, null, 2) : "";

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Fase 4 — Gecombineerde-graaf-topologie</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Bouwt GoKnoop + NWB + gevalideerde connectoren samen, meet topologie, test bereikbaarheid. Geen kostenmodel, geen F-factor, geen routekwaliteit-oordeel.
      </p>

      <input value={datasetVersionId} onChange={(e) => setDatasetVersionId(e.target.value)} placeholder="datasetVersionId" style={{ width: "100%", padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12 }} />

      <button onClick={runAll} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig..." : "Start Fase 4-meting (alle 3 regio's)"}
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
