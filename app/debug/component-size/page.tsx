"use client";

/**
 * Bedieningsscherm voor /api/debug/component-size (sectie 9.69, 30-8-2026).
 */

import { useState } from "react";

export default function ComponentSizePage() {
  const [nodeId, setNodeId] = useState("CJSXBPUMG49vOPmYvhJd"); // Knooppunt 5, Amsterdam Centraal
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ componentSize: number; sampleDisplayNumbers: string[]; totalNodesInGraph: number } | null>(null);

  async function test() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/debug/component-size", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Onbekende fout.");
        return;
      }
      setResult(data);
    } catch {
      setError("Er ging iets mis.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Hoe groot is het eiland?</h1>
      <p style={{ fontSize: 14, marginBottom: 16 }}>
        Telt hoeveel knooppunten daadwerkelijk bereikbaar zijn vanaf het opgegeven knooppunt, ongeacht afstand.
      </p>

      <input
        value={nodeId}
        onChange={(e) => setNodeId(e.target.value)}
        placeholder="Exact node-ID"
        style={{ width: "100%", padding: 8, fontSize: 14, fontFamily: "monospace", marginBottom: 16, boxSizing: "border-box" }}
      />

      <button onClick={test} disabled={loading} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8 }}>
        {loading ? "Bezig..." : "Test"}
      </button>

      {error && <p style={{ color: "red", marginTop: 16 }}>{error}</p>}

      {result && (
        <div style={{ marginTop: 16, padding: 14, border: "1px solid #ccc", borderRadius: 8, fontSize: 14 }}>
          <p style={{ fontWeight: 700, fontSize: 22 }}>
            {result.componentSize} van {result.totalNodesInGraph} knooppunten bereikbaar
          </p>
          <p style={{ fontSize: 13, opacity: 0.7, marginTop: 8 }}>
            ({((result.componentSize / result.totalNodesInGraph) * 100).toFixed(2)}% van het hele netwerk)
          </p>
          <p style={{ marginTop: 12, fontSize: 13 }}>Voorbeeld van bereikbare weergavenummers:</p>
          <p style={{ fontFamily: "monospace", fontSize: 13 }}>{result.sampleDisplayNumbers.join(", ")}</p>
        </div>
      )}
    </div>
  );
}
