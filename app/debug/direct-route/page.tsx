"use client";

/**
 * Debug-pagina voor /api/debug/direct-route (sectie 9.52/9.55, "Hilversum doet een omweg").
 * Puur diagnostisch. BIJGESTELD: exacte node-ID's zijn nu de aanbevolen invoer -- weerge-
 * numbers bleken NIET landelijk uniek (106x "60", 109x "36" in de hele dataset), dus zoeken
 * op weergavenummer kan een willekeurig, ongerelateerd knooppunt ergens anders in Nederland
 * treffen. Kopieer de exacte ID's rechtstreeks uit de diagnose-melding van
 * "route naar een adres" (die toont ze nu ook).
 */

import { useState } from "react";

type Attempt = { fromNodeId: string; toNodeId: string; result: "ok" | "failed"; distanceM?: number; reason?: string };

export default function DirectRoutePage() {
  const [fromNodeId, setFromNodeId] = useState("");
  const [toNodeId, setToNodeId] = useState("");
  const [fromDisplay, setFromDisplay] = useState("60");
  const [toDisplay, setToDisplay] = useState("36");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<Attempt[] | null>(null);
  const [counts, setCounts] = useState<{ fromNodeIdsFound: number; toNodeIdsFound: number; computeTimeMs: number } | null>(null);

  async function test() {
    setLoading(true);
    setError(null);
    setAttempts(null);
    try {
      const body =
        fromNodeId.trim() && toNodeId.trim()
          ? { fromNodeId: fromNodeId.trim(), toNodeId: toNodeId.trim() }
          : { fromDisplayNumber: fromDisplay, toDisplayNumber: toDisplay };
      const res = await fetch("/api/debug/direct-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Onbekende fout.");
        return;
      }
      setAttempts(data.attempts);
      setCounts({ fromNodeIdsFound: data.fromNodeIdsFound, toNodeIdsFound: data.toNodeIdsFound, computeTimeMs: data.computeTimeMs });
    } catch {
      setError("Er ging iets mis.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Directe node-naar-node-test</h1>

      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 8 }}>
        Aanbevolen: exacte node-ID&apos;s (uit de diagnose-melding van &quot;route naar een adres&quot;)
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
        <input value={fromNodeId} onChange={(e) => setFromNodeId(e.target.value)} placeholder="Exact van-ID (bijv. 0IqTE7...)" style={{ padding: 8, fontSize: 14, fontFamily: "monospace" }} />
        <input value={toNodeId} onChange={(e) => setToNodeId(e.target.value)} placeholder="Exact naar-ID" style={{ padding: 8, fontSize: 14, fontFamily: "monospace" }} />
      </div>

      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 8 }}>
        Of terugval op weergavenummer (LET OP: kan een willekeurig knooppunt met dat nummer ergens anders in Nederland treffen)
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input value={fromDisplay} onChange={(e) => setFromDisplay(e.target.value)} placeholder="Van weergavenummer" style={{ flex: 1, padding: 8, fontSize: 16 }} />
        <input value={toDisplay} onChange={(e) => setToDisplay(e.target.value)} placeholder="Naar weergavenummer" style={{ flex: 1, padding: 8, fontSize: 16 }} />
      </div>

      <button onClick={test} disabled={loading} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8 }}>
        {loading ? "Bezig..." : "Test"}
      </button>

      {error && <p style={{ color: "red", marginTop: 16 }}>{error}</p>}

      {counts && (
        <p style={{ marginTop: 16, fontSize: 14 }}>
          {counts.fromNodeIdsFound} knooppunt(en) gevonden voor de herkomst, {counts.toNodeIdsFound} voor de bestemming.
          <br />
          Rekentijd: {counts.computeTimeMs}ms
        </p>
      )}

      {attempts && (
        <div style={{ marginTop: 16 }}>
          {attempts.map((a, i) => (
            <div key={i} style={{ padding: 10, border: "1px solid #ccc", borderRadius: 8, marginBottom: 8, fontSize: 14, fontFamily: "monospace" }}>
              <div style={{ wordBreak: "break-all" }}>{a.fromNodeId} → {a.toNodeId}</div>
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
