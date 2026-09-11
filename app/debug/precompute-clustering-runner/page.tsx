"use client";

import { useState } from "react";

export default function PrecomputeClusteringRunnerPage() {
  const [nwbDatasetVersionId, setNwbDatasetVersionId] = useState("nwb-2026-09-10-v2-gebatcht");
  const [key, setKey] = useState(() => (typeof window !== "undefined" ? window.localStorage.getItem("goknoop_debug_secret") || "" : ""));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  async function run() {
    setRunning(true);
    setResult(null);
    setElapsedMs(null);
    const t0 = Date.now();
    try {
      const params = new URLSearchParams();
      if (key) params.set("key", key);
      const res = await fetch(`/api/admin/precompute-nwb-clustering?${params.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nwbDatasetVersionId }),
      });
      const elapsed = Date.now() - t0;
      setElapsedMs(elapsed);
      const json = await res.json();
      setResult({ httpStatus: res.status, elapsedMs: elapsed, respons: json });
    } catch (err) {
      setElapsedMs(Date.now() - t0);
      setResult({ fetchError: err instanceof Error ? err.message : String(err) });
    }
    setRunning(false);
  }

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>NWB-clustering vooraf berekenen</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Fase M6/M7, structurele fix. Berekent de union-find-clustering ÉÉN KEER en slaat het resultaat (fromClusterId/toClusterId) direct in de
        bestaande, gebatchte segmentdocumenten op -- daarna hoeft een koude serverstart nooit meer te clusteren.
      </p>

      <input
        type="text"
        value={nwbDatasetVersionId}
        onChange={(e) => setNwbDatasetVersionId(e.target.value)}
        placeholder="nwbDatasetVersionId"
        style={{ width: "100%", padding: 10, fontSize: 14, border: "1px solid #ccc", borderRadius: 8, marginBottom: 8 }}
      />
      <input
        type="text"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="DEBUG_SECRET"
        style={{ width: "100%", padding: 10, fontSize: 14, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12 }}
      />

      <button onClick={run} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig... (kan tot 10s duren, of falen)" : "Bereken clustering vooraf"}
      </button>

      {elapsedMs !== null && <p style={{ fontSize: 13, marginBottom: 8 }}>Verstreken tijd: <strong>{elapsedMs}ms</strong></p>}

      {result && (
        <pre style={{ fontSize: 11, background: "#f5f5f0", padding: 8, borderRadius: 6, overflowX: "auto", whiteSpace: "pre-wrap" }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}
