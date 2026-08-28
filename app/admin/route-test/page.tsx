"use client";

import { useState } from "react";

/**
 * Handmatig testformulier voor de echte productie-API (POST /api/route).
 * Alleen voor eigen gebruik, niet gelinkt vanuit de publieke UI.
 */
export default function RouteTestPage() {
  const [fromId, setFromId] = useState("ysPQwdlis6xmkwthaZYL");
  const [toId, setToId] = useState("4LfEocIOnTjfHJTWNHlj");
  const [result, setResult] = useState<string>("");
  const [loading, setLoading] = useState(false);

  async function runTest() {
    setLoading(true);
    setResult("Bezig...");
    const t0 = Date.now();
    try {
      const res = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromLogicalNodeId: fromId, toLogicalNodeId: toId }),
      });
      const data = await res.json();
      const clientTimeMs = Date.now() - t0;
      setResult(JSON.stringify({ httpStatus: res.status, clientTimeMs, response: data }, null, 2));
    } catch (err) {
      setResult(`Fout: ${err instanceof Error ? err.message : String(err)}`);
    }
    setLoading(false);
  }

  return (
    <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 600, margin: "0 auto" }}>
      <h1>GoKnoop — Route API Test</h1>
      <p style={{ color: "#666", fontSize: 14 }}>Test de echte POST /api/route-endpoint.</p>

      <div style={{ marginTop: "1rem" }}>
        <label style={{ display: "block", fontSize: 14, marginBottom: 4 }}>fromLogicalNodeId</label>
        <input
          type="text"
          value={fromId}
          onChange={(e) => setFromId(e.target.value)}
          style={{ width: "100%", padding: 8, fontSize: 16 }}
        />
      </div>

      <div style={{ marginTop: "1rem" }}>
        <label style={{ display: "block", fontSize: 14, marginBottom: 4 }}>toLogicalNodeId</label>
        <input
          type="text"
          value={toId}
          onChange={(e) => setToId(e.target.value)}
          style={{ width: "100%", padding: 8, fontSize: 16 }}
        />
      </div>

      <button
        disabled={loading}
        onClick={runTest}
        style={{ marginTop: "1rem", padding: "10px 16px", fontSize: 16 }}
      >
        {loading ? "Bezig..." : "Test route-berekening"}
      </button>

      <pre
        style={{
          marginTop: "1.5rem",
          background: "#111",
          color: "#0f0",
          padding: 12,
          fontSize: 12,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          borderRadius: 6,
          maxHeight: 500,
          overflowY: "auto",
        }}
      >
        {result}
      </pre>
    </main>
  );
}
