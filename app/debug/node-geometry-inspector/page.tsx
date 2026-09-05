"use client";

/**
 * UI voor /api/debug/node-geometry-inspector. Draait automatisch voor de
 * bekende probleemplekken (knooppunt 5, beide 56-kandidaten, NDSM-eiland-node)
 * en laat per plek zien of onmatched edges "net buiten tolerantie" liggen of
 * structureel ver weg -- met kopieerknop.
 */

import { useEffect, useState } from "react";

type Point = { label: string; lat: number; lon: number; radiusM?: number };

const POINTS: Point[] = [
  { label: "Knooppunt 5 (Amsterdam Centraal)", lat: 52.38055, lon: 4.8992, radiusM: 150 },
  { label: "Knooppunt 56-kandidaat A", lat: 52.34893, lon: 4.91293, radiusM: 150 },
  { label: "Knooppunt 56-kandidaat B", lat: 52.34586, lon: 4.91442, radiusM: 150 },
  { label: "NDSM-eiland-node (0 edges)", lat: 52.38462, lon: 4.88318, radiusM: 150 },
];

type Endpoint = {
  edgeId: string;
  edgeMatchConfidence: string;
  endpoint: "start" | "end";
  pointLat: number;
  pointLon: number;
  distToCenterM: number;
  matchedToSourceNodeId: string | null;
  matchedDistanceM: number | null;
};

type InspectResponse = {
  totalEndpointsFound: number;
  unmatchedEndpointCount: number;
  justOutsideToleranceCount: number;
  endpoints: Endpoint[];
};

type Run = { point: Point; status: "wachten" | "bezig" | "klaar" | "fout"; data?: InspectResponse; error?: string };

export default function NodeGeometryInspectorPage() {
  const [runs, setRuns] = useState<Run[]>(POINTS.map((point) => ({ point, status: "wachten" })));
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);

  async function runAll() {
    setRunning(true);
    setCopied(false);
    const next: Run[] = POINTS.map((point) => ({ point, status: "wachten" }));
    setRuns(next);

    for (let i = 0; i < POINTS.length; i++) {
      next[i] = { ...next[i], status: "bezig" };
      setRuns([...next]);
      try {
        const p = POINTS[i];
        const params = new URLSearchParams({ lat: String(p.lat), lon: String(p.lon), radiusM: String(p.radiusM ?? 150) });
        const res = await fetch(`/api/debug/node-geometry-inspector?${params.toString()}`);
        const data = await res.json();
        if (!res.ok) next[i] = { ...next[i], status: "fout", error: data.error ?? "Onbekende fout." };
        else next[i] = { ...next[i], status: "klaar", data };
      } catch {
        next[i] = { ...next[i], status: "fout", error: "Netwerkfout." };
      }
      setRuns([...next]);
    }
    setRunning(false);
  }

  useEffect(() => {
    runAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function buildCopyText(): string {
    const lines: string[] = [];
    lines.push(`GoKnoop node-geometry-inspector -- ${new Date().toISOString()}`);
    lines.push("");
    for (const run of runs) {
      lines.push(`## ${run.point.label} (${run.point.lat}, ${run.point.lon}), radius ${run.point.radiusM ?? 150}m`);
      if (run.status === "klaar" && run.data) {
        lines.push(
          `${run.data.totalEndpointsFound} endpoints binnen radius | ${run.data.unmatchedEndpointCount} onmatched | ${run.data.justOutsideToleranceCount} net-buiten-tolerantie (5-15m)`
        );
        for (const ep of run.data.endpoints.slice(0, 20)) {
          const status = ep.matchedToSourceNodeId ? `matched @ ${ep.matchedDistanceM?.toFixed(1)}m` : "ONMATCHED";
          lines.push(
            `  [${ep.edgeMatchConfidence}] edge ${ep.edgeId} (${ep.endpoint}) -- ${ep.distToCenterM.toFixed(0)}m van centrum -- ${status}`
          );
        }
      } else if (run.status === "fout") {
        lines.push(`FOUT -- ${run.error}`);
      } else {
        lines.push(`(nog niet uitgevoerd)`);
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

  const allDone = runs.every((r) => r.status === "klaar" || r.status === "fout");

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Node-geometrie-inspector</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Legt voor elke probleemplek de brongeometrie naast de knooppunten: net buiten tolerantie, of structureel
        ver weg? Draait automatisch voor 4 bekende plekken.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button onClick={runAll} disabled={running} style={{ flex: 1, padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8 }}>
          {running ? "Bezig..." : "Opnieuw draaien"}
        </button>
        <button onClick={copyResults} disabled={!allDone} style={{ flex: 1, padding: 12, fontSize: 16, background: allDone ? "#1a73e8" : "#ccc", color: "white", border: "none", borderRadius: 8 }}>
          {copied ? "Gekopieerd ✓" : "Kopieer alles"}
        </button>
      </div>

      {runs.map((run, i) => (
        <div key={i} style={{ marginBottom: 16, padding: 14, border: "1px solid #ddd", borderRadius: 8 }}>
          <div style={{ fontSize: 14, fontWeight: "bold", marginBottom: 8 }}>{run.point.label}</div>

          {run.status === "bezig" && <div style={{ fontSize: 13, opacity: 0.7 }}>⏳ bezig...</div>}
          {run.status === "fout" && <div style={{ color: "red", fontSize: 14 }}>⚠️ {run.error}</div>}

          {run.status === "klaar" && run.data && (
            <div style={{ fontSize: 12, fontFamily: "monospace" }}>
              <div style={{ marginBottom: 6 }}>
                {run.data.totalEndpointsFound} endpoints ·{" "}
                <span style={{ color: run.data.unmatchedEndpointCount > 0 ? "#c00" : "inherit" }}>
                  {run.data.unmatchedEndpointCount} onmatched
                </span>{" "}
                · {run.data.justOutsideToleranceCount} net-buiten-tolerantie
              </div>
              {run.data.endpoints.slice(0, 8).map((ep, j) => (
                <div key={j} style={{ borderTop: "1px solid #eee", padding: "4px 0", color: ep.matchedToSourceNodeId ? "inherit" : "#c00" }}>
                  [{ep.edgeMatchConfidence}] {ep.distToCenterM.toFixed(0)}m weg —{" "}
                  {ep.matchedToSourceNodeId ? `matched @ ${ep.matchedDistanceM?.toFixed(1)}m` : "ONMATCHED"}
                </div>
              ))}
              {run.data.endpoints.length > 8 && <div style={{ opacity: 0.5, marginTop: 4 }}>+{run.data.endpoints.length - 8} meer (zie kopieertekst)</div>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
