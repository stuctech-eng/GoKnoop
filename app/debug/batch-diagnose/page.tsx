"use client";

/**
 * Bedieningsscherm voor /api/debug/batch-diagnose (sectie 9.67, 30-8-2026, op verzoek:
 * "kun je niet iets automatiseren"). Toont in één keer ALLE combinaties tussen kandidaten bij
 * twee punten, met anomalieën duidelijk gemarkeerd -- geen handmatig paar-voor-paar testen
 * meer nodig.
 */

import { useState } from "react";

type Pair = {
  fromDisplayNumber: string;
  toDisplayNumber: string;
  result: "ok" | "failed";
  distanceM?: number;
  hopCount?: number;
  reason?: string;
  geographicDistanceM: number;
  ratio?: number;
  anomaly: boolean;
};

export default function BatchDiagnosePage() {
  const [originLat, setOriginLat] = useState("52.37833"); // Amsterdam Centraal
  const [originLon, setOriginLon] = useState("4.90000");
  const [destLat, setDestLat] = useState("52.23159"); // Hilversum
  const [destLon, setDestLon] = useState("5.17349");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairs, setPairs] = useState<Pair[] | null>(null);
  const [summary, setSummary] = useState<{ anomalyCount: number; total: number } | null>(null);

  async function test() {
    setLoading(true);
    setError(null);
    setPairs(null);
    try {
      const res = await fetch("/api/debug/batch-diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originLat: parseFloat(originLat),
          originLon: parseFloat(originLon),
          destLat: parseFloat(destLat),
          destLon: parseFloat(destLon),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Onbekende fout.");
        return;
      }
      setPairs(data.pairs);
      setSummary({ anomalyCount: data.anomalyCount, total: data.pairs.length });
    } catch {
      setError("Er ging iets mis.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Batch-diagnose: alle kandidaten tegelijk</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Test automatisch alle combinaties tussen de dichtstbijzijnde kandidaten bij twee punten -- geen handmatig
        paar-voor-paar testen meer nodig.
      </p>

      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 4 }}>Herkomst-punt</p>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input value={originLat} onChange={(e) => setOriginLat(e.target.value)} placeholder="lat" style={{ flex: 1, padding: 8, fontSize: 14 }} />
        <input value={originLon} onChange={(e) => setOriginLon(e.target.value)} placeholder="lon" style={{ flex: 1, padding: 8, fontSize: 14 }} />
      </div>

      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 4 }}>Bestemming-punt</p>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input value={destLat} onChange={(e) => setDestLat(e.target.value)} placeholder="lat" style={{ flex: 1, padding: 8, fontSize: 14 }} />
        <input value={destLon} onChange={(e) => setDestLon(e.target.value)} placeholder="lon" style={{ flex: 1, padding: 8, fontSize: 14 }} />
      </div>

      <button onClick={test} disabled={loading} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8 }}>
        {loading ? "Bezig... (kan even duren)" : "Test alle combinaties"}
      </button>

      {error && <p style={{ color: "red", marginTop: 16 }}>{error}</p>}

      {summary && (
        <p style={{ marginTop: 16, fontSize: 14, fontWeight: 700 }}>
          {summary.anomalyCount} van {summary.total} combinaties zijn anomalieën (rood hieronder).
        </p>
      )}

      {pairs && (
        <div style={{ marginTop: 12 }}>
          {pairs.map((p, i) => (
            <div
              key={i}
              style={{
                padding: 10,
                border: `1px solid ${p.anomaly ? "#b00020" : "#ccc"}`,
                background: p.anomaly ? "#fdecec" : "white",
                borderRadius: 8,
                marginBottom: 6,
                fontSize: 13,
                fontFamily: "monospace",
              }}
            >
              <div>Kn. {p.fromDisplayNumber} → Kn. {p.toDisplayNumber}</div>
              {p.result === "ok" ? (
                <div>
                  {(p.distanceM! / 1000).toFixed(1)} km netwerk / {(p.geographicDistanceM / 1000).toFixed(1)} km hemelsbreed
                  (×{p.ratio!.toFixed(1)}) -- {p.hopCount} hops
                </div>
              ) : (
                <div style={{ color: "#b00020", fontWeight: "bold" }}>❌ {p.reason}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
