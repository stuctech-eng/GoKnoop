"use client";

import { useState } from "react";

export default function NwbGapPinpointPage() {
  const [datasetVersionId, setDatasetVersionId] = useState("uINZ3y2QsgBdEyky3duq");
  const [fromNodeId, setFromNodeId] = useState("CJSXBPUMG49vOPmYvhJd");
  const [toNodeId, setToNodeId] = useState("ZYuO6ZfzSa2iim0HcUbn");
  const [radiusM, setRadiusM] = useState("2500");
  const [status, setStatus] = useState<"idle" | "bezig" | "klaar" | "fout">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  async function run() {
    setStatus("bezig");
    setError(null);
    try {
      const key = window.localStorage.getItem("goknoop_debug_secret") || "";
      const params = new URLSearchParams({ datasetVersionId, from: fromNodeId, to: toNodeId, radiusM });
      if (key) params.set("key", key);
      const res = await fetch(`/api/debug/nwb-gap-pinpoint?${params.toString()}`, { cache: "no-store" });
      const rawText = await res.text();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(rawText);
      } catch {
        setError(`Geen geldige JSON terug (status ${res.status}): ${rawText.slice(0, 300)}`);
        setStatus("fout");
        return;
      }
      if (!res.ok) {
        setError((json.details as string) ?? (json.error as string) ?? "Onbekende fout.");
        setStatus("fout");
        return;
      }
      setResult(json);
      setStatus("klaar");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("fout");
    }
  }

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>NWB-breukpunt-test</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Vindt het punt van grootste afwijking in de bestaande GoKnoop-omweg-route, en onderzoekt daar een klein, gegarandeerd-compleet NWB-gebied.
      </p>

      <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
        <input value={datasetVersionId} onChange={(e) => setDatasetVersionId(e.target.value)} placeholder="datasetVersionId" style={{ padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8 }} />
        <input value={fromNodeId} onChange={(e) => setFromNodeId(e.target.value)} placeholder="from-knooppunt-ID" style={{ padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8 }} />
        <input value={toNodeId} onChange={(e) => setToNodeId(e.target.value)} placeholder="to-knooppunt-ID" style={{ padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8 }} />
        <input value={radiusM} onChange={(e) => setRadiusM(e.target.value)} placeholder="straal in meters" style={{ padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8 }} />
      </div>

      <button
        onClick={run}
        disabled={status === "bezig"}
        style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 16 }}
      >
        {status === "bezig" ? "Bezig..." : "Breukpunt zoeken en onderzoeken"}
      </button>

      {status === "fout" && <p style={{ color: "red" }}>⚠️ {error}</p>}

      {status === "klaar" && result && (
        <pre style={{ fontSize: 11, background: "#f5f5f0", padding: 12, borderRadius: 8, overflowX: "auto", whiteSpace: "pre-wrap" }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}
