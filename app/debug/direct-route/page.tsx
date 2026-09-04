"use client";

/**
 * Debug-pagina voor /api/debug/direct-route (sectie 9.52/9.55/9.56, "Hilversum doet een
 * omweg"). BIJGESTELD: "nearLat"/"nearLon" -- als een weergavenummer meerdere treffers heeft
 * (de norm, niet de uitzondering), kies het treffer dat het dichtst bij dit referentiepunt
 * ligt. Vooraf ingevuld met de bekende situatie: Volendam-kant (exact ID, uit de eerdere
 * diagnose) -> knooppunt "36" dichtbij Hilversum (geocodede coördinaten, ook al bekend).
 */

import { useState } from "react";

type DirectRouteResult = {
  fromNodeId: string;
  toNodeId: string;
  result: "ok" | "failed";
  distanceM?: number;
  hopCount?: number;
  reason?: string;
  geographicDistanceM: number;
  computeTimeMs: number;
  fromNodeIdsFound: number;
  toNodeIdsFound: number;
};

export default function DirectRoutePage() {
  const [fromNodeId, setFromNodeId] = useState("7fmSWIHYsKu3Wb3yOtM2"); // Volendam-kant, uit de eerdere diagnose
  const [toNodeId, setToNodeId] = useState("");
  const [fromDisplay, setFromDisplay] = useState("");
  const [toDisplay, setToDisplay] = useState("36");
  const [nearLat, setNearLat] = useState("52.23159");
  const [nearLon, setNearLon] = useState("5.17349");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DirectRouteResult | null>(null);

  async function test() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const body: Record<string, unknown> = {};
      if (fromNodeId.trim()) body.fromNodeId = fromNodeId.trim();
      else if (fromDisplay.trim()) body.fromDisplayNumber = fromDisplay.trim();
      if (toNodeId.trim()) body.toNodeId = toNodeId.trim();
      else if (toDisplay.trim()) body.toDisplayNumber = toDisplay.trim();
      if (nearLat.trim() && nearLon.trim()) {
        body.nearLat = parseFloat(nearLat);
        body.nearLon = parseFloat(nearLon);
      }

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
      setResult(data);
    } catch {
      setError("Er ging iets mis.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Directe node-naar-node-test</h1>

      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 8 }}>Van: exact ID (leeg = gebruik weergavenummer eronder)</p>
      <input value={fromNodeId} onChange={(e) => setFromNodeId(e.target.value)} placeholder="Exact van-ID" style={{ width: "100%", padding: 8, fontSize: 14, fontFamily: "monospace", marginBottom: 8, boxSizing: "border-box" }} />
      <input value={fromDisplay} onChange={(e) => setFromDisplay(e.target.value)} placeholder="Of: van weergavenummer" style={{ width: "100%", padding: 8, fontSize: 16, marginBottom: 16, boxSizing: "border-box" }} />

      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 8 }}>Naar: exact ID (leeg = gebruik weergavenummer eronder)</p>
      <input value={toNodeId} onChange={(e) => setToNodeId(e.target.value)} placeholder="Exact naar-ID" style={{ width: "100%", padding: 8, fontSize: 14, fontFamily: "monospace", marginBottom: 8, boxSizing: "border-box" }} />
      <input value={toDisplay} onChange={(e) => setToDisplay(e.target.value)} placeholder="Of: naar weergavenummer" style={{ width: "100%", padding: 8, fontSize: 16, marginBottom: 16, boxSizing: "border-box" }} />

      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 8 }}>
        Bij een weergavenummer: kies het treffer dichtst bij dit punt (leeg = eerste treffer, willekeurig)
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input value={nearLat} onChange={(e) => setNearLat(e.target.value)} placeholder="Referentie-lat" style={{ flex: 1, padding: 8, fontSize: 16 }} />
        <input value={nearLon} onChange={(e) => setNearLon(e.target.value)} placeholder="Referentie-lon" style={{ flex: 1, padding: 8, fontSize: 16 }} />
      </div>

      <button onClick={test} disabled={loading} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8 }}>
        {loading ? "Bezig..." : "Test"}
      </button>

      {error && <p style={{ color: "red", marginTop: 16 }}>{error}</p>}

      {result && (
        <div style={{ marginTop: 16, padding: 14, border: "1px solid #ccc", borderRadius: 8, fontSize: 14, fontFamily: "monospace" }}>
          <div style={{ wordBreak: "break-all", marginBottom: 8 }}>{result.fromNodeId} → {result.toNodeId}</div>
          <div style={{ marginBottom: 8, opacity: 0.7 }}>
            ({result.fromNodeIdsFound} kandidaat/kandidaten voor herkomst, {result.toNodeIdsFound} voor bestemming)
          </div>
          {result.result === "ok" ? (
            <>
              <div style={{ color: "green", fontWeight: "bold", fontSize: 18 }}>✅ {(result.distanceM! / 1000).toFixed(1)} km netwerk-route</div>
              <div>{result.hopCount} hops</div>
            </>
          ) : (
            <div style={{ color: "red", fontWeight: "bold" }}>❌ {result.reason}</div>
          )}
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #eee" }}>
            Hemelsbrede afstand: {(result.geographicDistanceM / 1000).toFixed(1)} km
            <br />
            Rekentijd: {result.computeTimeMs}ms
          </div>
        </div>
      )}
    </div>
  );
}
