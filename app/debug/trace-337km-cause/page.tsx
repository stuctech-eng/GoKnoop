"use client";

import { useState } from "react";
import { buildValidatedCombinedGraph, dijkstraOnCombinedGraph, type SlimNwbSegment, type ValidatedConnectorInput } from "@/lib/nwb-analysis/combined-graph";
import { wgs84ToRd, rdToWgs84 } from "@/lib/route-engine/coordinate-transform";
import type { GraphProvider, GraphNode, GraphEdge } from "@/lib/route-engine/types";

// Exacte oude Volendam-onderzoeksgrens (lib/nwb-analysis/collector-regions.ts, 9-9-2026 eerder vandaag).
const OLD_VOLENDAM_BBOX_WGS84 = { latMin: 52.38, latMax: 52.58, lonMin: 4.85, lonMax: 5.2 };

const TRACE_PAIRS = [
  { naam: "v1", from: "3Sx24AWzdYTR4Psx0JJW", to: "AG9myGNbdE6eH0W2SUmi" },
  { naam: "v7", from: "AG9myGNbdE6eH0W2SUmi", to: "nKfPyXuKA5e2SMxiKON3" },
];

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

export default function Trace337kmCausePage() {
  const [datasetVersionId, setDatasetVersionId] = useState("uINZ3y2QsgBdEyky3duq");
  const [nwbDatasetVersionId, setNwbDatasetVersionId] = useState("nwb-2026-09-10-v1");
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

    // Oude Volendam-bbox in RD (zelfde berekening als regionRootBbox destijds).
    const corners = [
      wgs84ToRd(OLD_VOLENDAM_BBOX_WGS84.latMin, OLD_VOLENDAM_BBOX_WGS84.lonMin),
      wgs84ToRd(OLD_VOLENDAM_BBOX_WGS84.latMin, OLD_VOLENDAM_BBOX_WGS84.lonMax),
      wgs84ToRd(OLD_VOLENDAM_BBOX_WGS84.latMax, OLD_VOLENDAM_BBOX_WGS84.lonMin),
      wgs84ToRd(OLD_VOLENDAM_BBOX_WGS84.latMax, OLD_VOLENDAM_BBOX_WGS84.lonMax),
    ];
    const oldBbox = {
      minX: Math.min(...corners.map((c) => c.x)),
      maxX: Math.max(...corners.map((c) => c.x)),
      minY: Math.min(...corners.map((c) => c.y)),
      maxY: Math.max(...corners.map((c) => c.y)),
    };

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
      setLog((prev) => [...prev, `${json.nodeCount} GoKnoop-nodes geladen.`]);
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ ${err instanceof Error ? err.message : String(err)}`]);
      setRunning(false);
      return;
    }

    setLog((prev) => [...prev, "Actieve NWB-productiedata lezen..."]);
    let nwbSegments: SlimNwbSegment[] = [];
    try {
      const params = new URLSearchParams();
      if (key) params.set("key", key);
      const res = await fetch(`/api/admin/read-active-nwb-segments?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setLog((prev) => [...prev, `⚠️ ${json.details ?? json.error}`]);
        setRunning(false);
        return;
      }
      nwbSegments = json.segments; // rechtstreeks toewijzen, GEEN spread-operator (stack-overflow-risico bij ~144k elementen)
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ ${err instanceof Error ? err.message : String(err)}`]);
      setRunning(false);
      return;
    }
    setLog((prev) => [...prev, `${nwbSegments.length} NWB-segmenten geladen.`]);

    setLog((prev) => [...prev, "Daadwerkelijk OPGESLAGEN productie-connectoren lezen (niet opnieuw genereren)..."]);
    let validatedConnectors: ValidatedConnectorInput[] = [];
    try {
      const params = new URLSearchParams({ nwbDatasetVersionId, datasetVersionId });
      if (key) params.set("key", key);
      const res = await fetch(`/api/admin/read-nwb-connectors?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setLog((prev) => [...prev, `⚠️ ${json.details ?? json.error}`]);
        setRunning(false);
        return;
      }
      validatedConnectors = json.connectors;
      setLog((prev) => [...prev, `${validatedConnectors.length} echte productie-connectoren geladen.`]);
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ ${err instanceof Error ? err.message : String(err)}`]);
      setRunning(false);
      return;
    }

    const combined = await buildValidatedCombinedGraph(provider, nwbSegments, 20, validatedConnectors);

    const traceResults: Record<string, unknown> = {};
    for (const pair of TRACE_PAIRS) {
      const result = dijkstraOnCombinedGraph(combined, pair.from, pair.to);
      if (!result.found) {
        traceResults[pair.naam] = { routeFound: false };
        continue;
      }

      const connectorSteps = result.steps.filter((s) => s.edgeSource === "connector");
      const connectorDetails = connectorSteps.map((s) => {
        // Bepaal welke kant (GoKnoop of NWB) dit knooppunt is.
        const isGoknoopSide = !s.nodeId.startsWith("nwb:");
        if (!isGoknoopSide) return { nodeId: s.nodeId, kant: "nwb" as const };
        const rawNode = provider.rawCoords(s.nodeId);
        if (!rawNode) return { nodeId: s.nodeId, kant: "goknoop" as const, gevonden: false };
        const buitenOudeBbox = rawNode.x < oldBbox.minX || rawNode.x > oldBbox.maxX || rawNode.y < oldBbox.minY || rawNode.y > oldBbox.maxY;
        return {
          nodeId: s.nodeId,
          kant: "goknoop" as const,
          rd: { x: rawNode.x, y: rawNode.y },
          wgs84: rdToWgs84(rawNode.x, rawNode.y),
          BUITEN_OUDE_VOLENDAM_ONDERZOEKSGRENS: buitenOudeBbox,
        };
      });

      traceResults[pair.naam] = {
        routeFound: true,
        totaleAfstandM: Math.round(result.distanceM),
        goknoopEdgeCount: result.goknoopEdgeCount,
        nwbEdgeCount: result.nwbEdgeCount,
        connectorCount: result.connectorCount,
        gebruikteConnectorKnopen: connectorDetails,
      };
    }

    setReport({
      oudeVolendamBboxRD: oldBbox,
      trace: traceResults,
    });
    setLog((prev) => [...prev, "Trace klaar."]);
    setRunning(false);
  }

  const copyText = report ? JSON.stringify(report, null, 2) : "";

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Gerichte trace: waarom reproduceerde 337km niet?</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Traceert het echte productiepad voor v1/v7 met de daadwerkelijk opgeslagen connectoren, en checkt of de gebruikte GoKnoop-knoop buiten de oude Volendam-onderzoeksgrens ligt.
      </p>

      <input value={datasetVersionId} onChange={(e) => setDatasetVersionId(e.target.value)} placeholder="GoKnoop datasetVersionId" style={{ width: "100%", padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8, marginBottom: 8 }} />
      <input value={nwbDatasetVersionId} onChange={(e) => setNwbDatasetVersionId(e.target.value)} placeholder="nwbDatasetVersionId" style={{ width: "100%", padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12 }} />

      <button onClick={run} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig..." : "Start trace"}
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
