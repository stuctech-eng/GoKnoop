"use client";

/**
 * UI voor /api/debug/nearest-nodes. Draait automatisch twee scans: NDSM-kant en
 * Amsterdam-kant (De Ruijterkade) van het F4-pontje, en toont per kant de
 * dichtstbijzijnde knopen MET edge-count, zodat het echte, verbonden knooppunt
 * te kiezen is voor een eventuele datapatch (i.p.v. de mogelijk vervuilde
 * geïsoleerde node die /debug/network-gap-scan vond).
 */

import { useEffect, useState } from "react";

type Scan = {
  label: string;
  lat: number;
  lon: number;
};

// Ruwe schattingen (niet geverifieerd op de kaart) -- doel van deze scan is juist om
// de radius rond deze punten af te tasten op ECHTE, verbonden knopen.
const SCANS: Scan[] = [
  { label: "NDSM-kant (Ms. van Riemsdijkweg-gebied)", lat: 52.4006, lon: 4.8913 },
  { label: "Amsterdam-kant (De Ruijterkade / CS)", lat: 52.3783, lon: 4.9 },
];

type NearestNode = {
  nodeId: string;
  displayNumber: string | null;
  edgeCount: number;
  lat: number;
  lon: number;
  distanceM: number;
};

type ScanRun = {
  scan: Scan;
  status: "wachten" | "bezig" | "klaar" | "fout";
  nodes?: NearestNode[];
  error?: string;
};

export default function NearestNodesPage() {
  const [runs, setRuns] = useState<ScanRun[]>(SCANS.map((scan) => ({ scan, status: "wachten" })));
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [customLat, setCustomLat] = useState("");
  const [customLon, setCustomLon] = useState("");

  async function runOne(scan: Scan): Promise<ScanRun> {
    try {
      const res = await fetch("/api/debug/nearest-nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: scan.lat, lon: scan.lon, limit: 12 }),
      });
      const data = await res.json();
      if (!res.ok) return { scan, status: "fout", error: data.error ?? "Onbekende fout." };
      return { scan, status: "klaar", nodes: data.nodes };
    } catch {
      return { scan, status: "fout", error: "Netwerkfout." };
    }
  }

  async function runAll() {
    setRunning(true);
    setCopied(false);
    const next: ScanRun[] = SCANS.map((scan) => ({ scan, status: "bezig" }));
    setRuns(next);
    for (let i = 0; i < SCANS.length; i++) {
      const result = await runOne(SCANS[i]);
      next[i] = result;
      setRuns([...next]);
    }
    setRunning(false);
  }

  async function runCustom() {
    const lat = parseFloat(customLat);
    const lon = parseFloat(customLon);
    if (isNaN(lat) || isNaN(lon)) return;
    setRunning(true);
    setCopied(false);
    const customScan: Scan = { label: `Handmatig punt (${lat}, ${lon})`, lat, lon };
    const result = await runOne(customScan);
    setRuns((prev) => [...prev, result]);
    setRunning(false);
  }

  useEffect(() => {
    runAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function buildCopyText(): string {
    const lines: string[] = [];
    lines.push(`GoKnoop nearest-nodes-scan -- ${new Date().toISOString()}`);
    lines.push("");
    for (const run of runs) {
      lines.push(`## ${run.scan.label} (${run.scan.lat}, ${run.scan.lon})`);
      if (run.status === "klaar" && run.nodes) {
        for (const node of run.nodes) {
          const flag = node.edgeCount === 0 ? "  [EILAND]" : "";
          lines.push(
            `  Knpt ${node.displayNumber ?? "(geen)"} | ${node.edgeCount} edges | ${node.distanceM.toFixed(0)}m weg | ${node.nodeId} | (${node.lat.toFixed(5)}, ${node.lon.toFixed(5)})${flag}`
          );
        }
      } else if (run.status === "fout") {
        lines.push(`  FOUT -- ${run.error}`);
      } else {
        lines.push(`  (nog niet uitgevoerd)`);
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
    <div style={{ padding: 20, fontFamily: "sans-serif", maxWidth: 600, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Dichtstbijzijnde knopen (met edge-count)</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Toont per punt de 12 dichtstbijzijnde knopen mét hun aantal edges, zodat het échte
        verbonden knooppunt te vinden is i.p.v. een geïsoleerde/vervuilde node.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button
          onClick={runAll}
          disabled={running}
          style={{ flex: 1, padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8 }}
        >
          {running ? "Bezig..." : "Opnieuw draaien"}
        </button>
        <button
          onClick={copyResults}
          disabled={!allDone}
          style={{ flex: 1, padding: 12, fontSize: 16, background: allDone ? "#1a73e8" : "#ccc", color: "white", border: "none", borderRadius: 8 }}
        >
          {copied ? "Gekopieerd ✓" : "Kopieer alles"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input value={customLat} onChange={(e) => setCustomLat(e.target.value)} placeholder="Extra punt: lat" style={{ flex: 1, padding: 8, fontSize: 14 }} />
        <input value={customLon} onChange={(e) => setCustomLon(e.target.value)} placeholder="lon" style={{ flex: 1, padding: 8, fontSize: 14 }} />
        <button onClick={runCustom} disabled={running} style={{ padding: "8px 12px", fontSize: 14, background: "#555", color: "white", border: "none", borderRadius: 8 }}>
          Test
        </button>
      </div>

      {runs.map((run, i) => (
        <div key={i} style={{ marginBottom: 16, padding: 14, border: "1px solid #ddd", borderRadius: 8 }}>
          <div style={{ fontSize: 14, fontWeight: "bold", marginBottom: 8 }}>
            {run.scan.label} <span style={{ fontWeight: "normal", opacity: 0.5 }}>({run.scan.lat}, {run.scan.lon})</span>
          </div>

          {run.status === "bezig" && <div style={{ fontSize: 13, opacity: 0.7 }}>⏳ bezig...</div>}
          {run.status === "fout" && <div style={{ color: "red", fontSize: 14 }}>⚠️ {run.error}</div>}

          {run.status === "klaar" && run.nodes && (
            <table style={{ width: "100%", fontSize: 12, fontFamily: "monospace", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", opacity: 0.6 }}>
                  <th>Knpt</th>
                  <th>Edges</th>
                  <th>Afst.</th>
                  <th>ID</th>
                </tr>
              </thead>
              <tbody>
                {run.nodes.map((node) => (
                  <tr key={node.nodeId} style={{ borderTop: "1px solid #eee", color: node.edgeCount === 0 ? "#c00" : "inherit" }}>
                    <td>{node.displayNumber ?? "—"}</td>
                    <td>{node.edgeCount}{node.edgeCount === 0 ? " ⚠️" : ""}</td>
                    <td>{node.distanceM.toFixed(0)}m</td>
                    <td style={{ wordBreak: "break-all" }}>{node.nodeId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}
