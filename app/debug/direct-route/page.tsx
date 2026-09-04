"use client";

/**
 * Debug-pagina voor /api/debug/direct-route (sectie 9.52, "Hilversum doet een omweg").
 * Puur diagnostisch, roept alleen het nieuwe debug-endpoint aan.
 */

import { useState } from "react";

type Attempt = { fromNodeId: string; toNodeId: string; result: "ok" | "failed"; distanceM?: number; reason?: string };

export default function DirectRoutePage() {
  const [from, setFrom] = useState("60");
  const [to, setTo] = useState("36");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<Attempt[] | null>(null);
  const [counts, setCounts] = useState<{ fromNodeIdsFound: number; toNodeIdsFound: number } | null>(null);

  async function test() {
    setLoading(true);
    setError(null);
    setAttempts(null);
    try {
      const res = await fetch("/api/debug/direct-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromDisplayNumber: from, toDisplayNumber: to }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Onbekende fout.");
        return;
      }
      setAttempts(data.attempts);
      setCounts({ fromNodeIdsFound: data.fromNodeIdsFound, toNodeIdsFound: data.toNodeIdsFound });
    } catch {
      setError("Er ging iets mis.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Directe node-naar-node-test</h1>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Van knooppunt" style={{ flex: 1, padding: 8, fontSize: 16 }} />
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Naar knooppunt" style={{ flex: 1, padding: 8, fontSize: 16 }} />
      </div>
      <button onClick={test} disabled={loading} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8 }}>
        {loading ? "Bezig..." : "Test"}
      </button>

      {error && <p style={{ color: "red", marginTop: 16 }}>{error}</p>}

      {counts && (
        <p style={{ marginTop: 16, fontSize: 14 }}>
          {counts.fromNodeIdsFound} knooppunt(en) gevonden met nummer &quot;{from}&quot;, {counts.toNodeIdsFound} met nummer &quot;{to}&quot;.
        </p>
      )}

      {attempts && (
        <div style={{ marginTop: 16 }}>
          {attempts.map((a, i) => (
            <div key={i} style={{ padding: 10, border: "1px solid #ccc", borderRadius: 8, marginBottom: 8, fontSize: 14, fontFamily: "monospace" }}>
              <div>{a.fromNodeId} → {a.toNodeId}</div>
              {a.result === "ok" ? (
                <div style={{ color: "green", fontWeight: "bold" }}>✅ {(a.distanceM! / 1000).toFixed(1)} km</div>
              ) : (
                <div style={{ color: "red", fontWeight: "bold" }}>❌ {a.reason}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
