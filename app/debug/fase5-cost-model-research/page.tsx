"use client";

import { useState } from "react";
import {
  buildValidatedCombinedGraph,
  dijkstraWithCostModel,
  makeCostFn,
  type SlimNwbSegment,
  type ValidatedConnectorInput,
  type CombinedGraph,
} from "@/lib/nwb-analysis/combined-graph";
import { generateConnectorCandidates, type GoKnoopNodeInput } from "@/lib/nwb-analysis/connector-candidates";
import type { GraphProvider, GraphNode, GraphEdge } from "@/lib/route-engine/types";

/** Zelfde client-side adapter als Fase 4. */
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
  rawCoords(id: string) {
    return this.nodeMap.get(id);
  }
}

// Breed bereik, niet alleen 1,00/1,05/1,10 -- zodat een eventueel omslagpunt
// boven het eerder onderzochte bereik (bv. bij Hilversum, waar de NWB-route
// vandaag zeer sterk domineerde) ook daadwerkelijk gevonden wordt.
const F_NWB_SWEEP = [1.0, 1.02, 1.05, 1.08, 1.1, 1.15, 1.2, 1.3, 1.5, 2.0, 3.0, 5.0, 8.0, 12.0, 20.0];
const F_CONNECTOR_VARIANTS = [0.5, 1.0, 1.5, 2.0]; // relatief t.o.v. de werkelijke connectorafstand

const REGIONS: Record<string, { label: string; pairs: { name: string; from: string; to: string }[] }> = {
  hilversum: { label: "Amsterdam <-> Hilversum", pairs: [{ name: "Amsterdam->Hilversum", from: "CJSXBPUMG49vOPmYvhJd", to: "ZYuO6ZfzSa2iim0HcUbn" }] },
  volendam: { label: "Volendam / Edam / Purmerend", pairs: [{ name: "Volendam->Amsterdam", from: "7fmSWIHYsKu3Wb3yOtM2", to: "CJSXBPUMG49vOPmYvhJd" }] },
  lochem: {
    label: "Lochem / Achterhoek (5 kandidaten, 3 representatieve paren)",
    pairs: [
      { name: "kand1->kand2", from: "9cdQ8xUK4u2DFybtRTfg", to: "bR0u430Tm1qT6yHBUU4k" },
      { name: "kand1->kand4", from: "9cdQ8xUK4u2DFybtRTfg", to: "DULwi9RMia4vV4Wbdc2a" },
      { name: "kand3->kand5", from: "CDdOFbRpdb959FzzPLc0", to: "3rnbURpA3ImMOs940vR8" },
    ],
  },
};

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

export default function Fase5CostModelResearchPage() {
  const [datasetVersionId, setDatasetVersionId] = useState("uINZ3y2QsgBdEyky3duq");
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
      setLog((prev) => [...prev, `GoKnoop-graaf: ${json.nodeCount} nodes.`]);
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ ${err instanceof Error ? err.message : String(err)}`]);
      setRunning(false);
      return;
    }

    const allResults: Record<string, unknown> = {};

    for (const [regionKey, region] of Object.entries(REGIONS)) {
      setLog((prev) => [...prev, `--- ${regionKey}: data laden + graaf bouwen ---`]);

      const segmentsById = new Map<string, SlimNwbSegment>();
      let offset = 0;
      for (;;) {
        try {
          const params = new URLSearchParams({ region: regionKey, offset: String(offset) });
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
        const params = new URLSearchParams({ region: regionKey, datasetVersionId });
        if (key) params.set("key", key);
        const res = await fetch(`/api/debug/nwb-collector-goknoop-bearings?${params.toString()}`, { cache: "no-store" });
        const json = await res.json();
        if (res.ok) goknoopBearingNodes = json.nodes;
      } catch {
        /* val terug op lege lijst -- connectorgeneratie levert dan 0 op, zichtbaar in de output */
      }

      await new Promise((r) => setTimeout(r, 20));
      const candidateResult = generateConnectorCandidates(goknoopBearingNodes, nwbSegments, 20);
      const validatedConnectors: ValidatedConnectorInput[] = candidateResult.candidates
        .filter((c) => c.confidence !== "rejected")
        .map((c) => ({ goknoopNodeId: c.goknoopNodeId, nwbSegmentId: c.nwbSegmentId, nwbEndpoint: c.nwbEndpoint, distanceM: c.distanceM, confidence: c.confidence as "high" | "lower" }));

      const combined: CombinedGraph = buildValidatedCombinedGraph(provider, nwbSegments, 20, validatedConnectors);
      setLog((prev) => [...prev, `${regionKey}: graaf klaar (${validatedConnectors.length} connectoren). F-sweep starten...`]);
      await new Promise((r) => setTimeout(r, 20));

      const regionResult: Record<string, unknown> = {};

      for (const pair of region.pairs) {
        const fromNode = provider.rawCoords(pair.from);
        const toNode = provider.rawCoords(pair.to);
        const straightLineM = fromNode && toNode ? Math.hypot(toNode.x - fromNode.x, toNode.y - fromNode.y) : null;

        // Hoofd-sweep: F_nwb varieert, F_connector vast op 1.0 (neutraal).
        const sweepResults: Record<string, unknown> = {};
        let firstGoknoopUsageF: number | null = null;
        let firstNwbZeroF: number | null = null;
        let baselineDistanceM: number | null = null;

        for (const fNwb of F_NWB_SWEEP) {
          const result = dijkstraWithCostModel(combined, pair.from, pair.to, makeCostFn(fNwb, 1.0));
          if (!result.found) {
            sweepResults[`F=${fNwb}`] = { routeFound: false };
            continue;
          }
          if (fNwb === 1.0) baselineDistanceM = result.distanceM;
          if (firstGoknoopUsageF === null && result.goknoopEdgeCount > 0) firstGoknoopUsageF = fNwb;
          if (firstNwbZeroF === null && result.nwbEdgeCount === 0) firstNwbZeroF = fNwb;

          const totalEdges = result.goknoopEdgeCount + result.nwbEdgeCount + result.connectorCount;
          sweepResults[`F=${fNwb}`] = {
            routeFound: true,
            distanceM: Math.round(result.distanceM),
            deviationFactor: straightLineM ? Math.round((result.distanceM / straightLineM) * 100) / 100 : null,
            goknoopEdgeCount: result.goknoopEdgeCount,
            nwbEdgeCount: result.nwbEdgeCount,
            connectorCount: result.connectorCount,
            goknoopAandeel: totalEdges > 0 ? Math.round((result.goknoopEdgeCount / totalEdges) * 1000) / 1000 : 0,
            nwbAandeel: totalEdges > 0 ? Math.round((result.nwbEdgeCount / totalEdges) * 1000) / 1000 : 0,
            goknoopDistanceM: Math.round(result.goknoopDistanceM),
            nwbDistanceM: Math.round(result.nwbDistanceM),
            connectorDistanceM: Math.round(result.connectorDistanceM),
            totalHops: result.goknoopEdgeCount + result.nwbEdgeCount + result.connectorCount,
            afstandVsBaselineRatio: baselineDistanceM ? Math.round((result.distanceM / baselineDistanceM) * 100) / 100 : 1,
          };
        }

        // Connector-kostenvariant, getest bij F_nwb=1.0 (baseline) en bij het eerste omslagpunt (indien gevonden).
        const connectorVariantResults: Record<string, unknown> = {};
        const connectorTestFNwb = [1.0, firstGoknoopUsageF ?? F_NWB_SWEEP[F_NWB_SWEEP.length - 1]];
        for (const fNwb of connectorTestFNwb) {
          for (const fConn of F_CONNECTOR_VARIANTS) {
            const result = dijkstraWithCostModel(combined, pair.from, pair.to, makeCostFn(fNwb, fConn));
            connectorVariantResults[`Fnwb=${fNwb}_Fconn=${fConn}`] = result.found
              ? { routeFound: true, distanceM: Math.round(result.distanceM), connectorCount: result.connectorCount, goknoopEdgeCount: result.goknoopEdgeCount, nwbEdgeCount: result.nwbEdgeCount }
              : { routeFound: false };
          }
        }

        regionResult[pair.name] = {
          straightLineM: straightLineM ? Math.round(straightLineM) : null,
          omslagpunten: {
            eersteFWaarGoKnoopWordtGebruikt: firstGoknoopUsageF,
            eersteFWaarNwbHelemaalNietMeerGebruiktWordt: firstNwbZeroF,
          },
          fNwbSweep: sweepResults,
          connectorKostenVarianten: connectorVariantResults,
        };
      }

      allResults[regionKey] = regionResult;
      setLog((prev) => [...prev, `✅ ${regionKey}: klaar.`]);
    }

    setReport(allResults);
    setLog((prev) => [...prev, "Alle regio's + F-sweeps klaar."]);
    setRunning(false);
  }

  const copyText = report ? JSON.stringify(report, null, 2) : "";

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Fase 5 — Empirisch kostenmodel-onderzoek</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Draait {F_NWB_SWEEP.length} F-waarden × {Object.values(REGIONS).reduce((n, r) => n + r.pairs.length, 0)} routeparen + connector-kostenvarianten. Geen enkele waarde vooraf gekozen als default.
      </p>

      <input value={datasetVersionId} onChange={(e) => setDatasetVersionId(e.target.value)} placeholder="datasetVersionId" style={{ width: "100%", padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12 }} />

      <button onClick={runAll} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig... (kan een minuut duren)" : "Start Fase 5-onderzoek"}
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
