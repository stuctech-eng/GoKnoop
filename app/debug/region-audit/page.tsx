"use client";

/**
 * UI voor /api/debug/region-audit. Draait automatisch, toont per gebied
 * match%, edge-verdeling en 0-edge-nodes naast elkaar, met kopieerknop.
 */

import { useEffect, useState } from "react";

type RegionResult = {
  region: string;
  bboxWgs84: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  logicalNodesInRegion: number;
  edgesTouchingRegion: number;
  edgeConfidenceCounts: Record<string, number>;
  matchPercent: string;
  edgesPerNode: { zeroEdgeNodeCount: number; oneEdgeNodeCount: number; avg: string; median: number | string; max: number | string };
  zeroEdgeNodeSample: { id: string; displayNumber: string | null }[];
  endpointDistanceStatsM: { count: number; median: string; p90: string; max: string } | null;
  gapAnalysis: {
    lowDegreeNodesChecked: number;
    searchRadiusM: number;
    nearbyUnmatchedEndpointsFound: number;
    nearMissCount: number;
    structuralCount: number;
    gapDistanceStatsM: { median: string; max: string } | null;
    structuralSample: { nodeId: string; displayNumber: string | null; distanceM: number }[];
  };
};

type AuditResponse = {
  datasetVersionId: string;
  totalLogicalNodes: number;
  totalEdges: number;
  regions: RegionResult[];
};

export default function RegionAuditPage() {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [status, setStatus] = useState<"bezig" | "klaar" | "fout">("bezig");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [debugKey, setDebugKey] = useState("");

  useEffect(() => {
    const saved = window.localStorage.getItem("goknoop_debug_secret") || "";
    setDebugKey(saved);
    run(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function saveKey(value: string) {
    setDebugKey(value);
    window.localStorage.setItem("goknoop_debug_secret", value);
  }

  async function run(keyOverride?: string) {
    setStatus("bezig");
    setError(null);
    setCopied(false);
    try {
      const key = keyOverride ?? debugKey;
      const params = key ? `?key=${encodeURIComponent(key)}` : "";
      const res = await fetch(`/api/debug/region-audit${params}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Onbekende fout.");
        setStatus("fout");
        return;
      }
      setData(json);
      setStatus("klaar");
    } catch {
      setError("Netwerkfout tijdens audit.");
      setStatus("fout");
    }
  }



  function buildCopyText(): string {
    if (!data) return "";
    const lines: string[] = [];
    lines.push(`GoKnoop regio-audit -- ${new Date().toISOString()}`);
    lines.push(`Dataset: ${data.datasetVersionId} -- ${data.totalLogicalNodes} logicalNodes, ${data.totalEdges} edges totaal`);
    lines.push("");
    for (const r of data.regions) {
      lines.push(`## ${r.region}`);
      lines.push(`bbox: (${r.bboxWgs84.minLat}, ${r.bboxWgs84.minLon}) -- (${r.bboxWgs84.maxLat}, ${r.bboxWgs84.maxLon})`);
      lines.push(`logicalNodes in gebied: ${r.logicalNodesInRegion}`);
      lines.push(`edges rakend aan gebied: ${r.edgesTouchingRegion} | match% ${r.matchPercent}`);
      lines.push(`  confidence: ${JSON.stringify(r.edgeConfidenceCounts)}`);
      lines.push(
        `edges/node: avg ${r.edgesPerNode.avg}, median ${r.edgesPerNode.median}, max ${r.edgesPerNode.max}, 0-edge nodes: ${r.edgesPerNode.zeroEdgeNodeCount}, 1-edge nodes: ${r.edgesPerNode.oneEdgeNodeCount}`
      );
      if (r.endpointDistanceStatsM) {
        lines.push(
          `endpoint-afstand tot dichtstbijzijnde sourceNode: median ${r.endpointDistanceStatsM.median}m, p90 ${r.endpointDistanceStatsM.p90}m, max ${r.endpointDistanceStatsM.max}m (n=${r.endpointDistanceStatsM.count})`
        );
      }
      if (r.zeroEdgeNodeSample.length) {
        lines.push(`0-edge node-ID's (steekproef): ${r.zeroEdgeNodeSample.map((n) => `${n.id}(${n.displayNumber ?? "-"})`).join(", ")}`);
      }
      lines.push(
        `gap-analyse (${r.gapAnalysis.lowDegreeNodesChecked} laag-connectieve knopen gecheckt, radius ${r.gapAnalysis.searchRadiusM}m): ${r.gapAnalysis.nearbyUnmatchedEndpointsFound} onmatched endpoints gevonden -- ${r.gapAnalysis.nearMissCount} near-miss (<=15m), ${r.gapAnalysis.structuralCount} structureel (>15m)`
      );
      if (r.gapAnalysis.structuralSample.length) {
        lines.push(
          `  structurele gaten (steekproef): ${r.gapAnalysis.structuralSample.map((s) => `${s.displayNumber ?? s.nodeId}@${s.distanceM}m`).join(", ")}`
        );
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  async function copyResults() {
    try {
      await navigator.clipboard.writeText(buildCopyText());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Regio-audit: match% per gebied</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Vergelijkt Amsterdam-centrum, een referentiegebied (Volendam/Edam) en Amsterdam-Noord/Waterland op match%,
        edges/node en 0-edge-knopen. Draait automatisch.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          type="password"
          value={debugKey}
          onChange={(e) => saveKey(e.target.value)}
          placeholder="DEBUG_SECRET (éénmalig invullen)"
          style={{ flex: 1, padding: 10, fontSize: 14, border: "1px solid #ccc", borderRadius: 8 }}
        />
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button onClick={() => run()} disabled={status === "bezig"} style={{ flex: 1, padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8 }}>
          {status === "bezig" ? "Bezig..." : "Opnieuw draaien"}
        </button>
        <button onClick={copyResults} disabled={status !== "klaar"} style={{ flex: 1, padding: 12, fontSize: 16, background: status === "klaar" ? "#1a73e8" : "#ccc", color: "white", border: "none", borderRadius: 8 }}>
          {copied ? "Gekopieerd ✓" : "Kopieer alles"}
        </button>
      </div>

      {status === "fout" && <p style={{ color: "red" }}>⚠️ {error}</p>}

      {data &&
        data.regions.map((r, i) => (
          <div key={i} style={{ marginBottom: 16, padding: 14, border: "1px solid #ddd", borderRadius: 8 }}>
            <div style={{ fontSize: 14, fontWeight: "bold", marginBottom: 8 }}>{r.region}</div>
            <div style={{ fontSize: 13, fontFamily: "monospace", lineHeight: 1.6 }}>
              <div>Knopen in gebied: {r.logicalNodesInRegion}</div>
              <div>
                Edges rakend aan gebied: {r.edgesTouchingRegion} · match%{" "}
                <b style={{ color: parseFloat(r.matchPercent) < 50 ? "#c00" : "green" }}>{r.matchPercent}</b>
              </div>
              <div style={{ opacity: 0.7, fontSize: 12 }}>{JSON.stringify(r.edgeConfidenceCounts)}</div>
              <div style={{ marginTop: 6 }}>
                edges/node: avg {r.edgesPerNode.avg} · median {r.edgesPerNode.median} · max {r.edgesPerNode.max}
              </div>
              <div style={{ color: r.edgesPerNode.zeroEdgeNodeCount > 0 ? "#c00" : "inherit" }}>
                0-edge knopen: {r.edgesPerNode.zeroEdgeNodeCount}
                {r.edgesPerNode.zeroEdgeNodeCount > 0 ? " ⚠️" : ""} · 1-edge knopen: {r.edgesPerNode.oneEdgeNodeCount}
              </div>
              {r.endpointDistanceStatsM && (
                <div style={{ marginTop: 6, opacity: 0.8 }}>
                  afstand tot dichtstbijzijnde sourceNode: median {r.endpointDistanceStatsM.median}m · p90 {r.endpointDistanceStatsM.p90}m ·
                  max {r.endpointDistanceStatsM.max}m
                </div>
              )}
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed #ccc" }}>
                <div>
                  Gap-analyse ({r.gapAnalysis.lowDegreeNodesChecked} laag-connectieve knopen, {r.gapAnalysis.searchRadiusM}m radius):
                </div>
                <div>
                  {r.gapAnalysis.nearbyUnmatchedEndpointsFound} onmatched endpoints —{" "}
                  <span style={{ color: "#b8860b" }}>{r.gapAnalysis.nearMissCount} near-miss (≤15m)</span> ·{" "}
                  <span style={{ color: r.gapAnalysis.structuralCount > 0 ? "#c00" : "inherit" }}>
                    {r.gapAnalysis.structuralCount} structureel (&gt;15m)
                  </span>
                </div>
                {r.gapAnalysis.structuralSample.length > 0 && (
                  <div style={{ opacity: 0.7, marginTop: 2 }}>
                    bv: {r.gapAnalysis.structuralSample.map((s) => `${s.displayNumber ?? s.nodeId}@${s.distanceM}m`).join(", ")}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
    </div>
  );
}
