"use client";

/**
 * Debug-pagina voor /api/debug/direct-route (sectie 9.52-9.58, "gat tussen Waterland en het
 * Gooi"). Vooraf ingevuld met de gerichte vervolgtest: knooppunt "60" dichtbij Amsterdam-
 * Noord/Schellingwoude (al bevestigd goed bereikbaar vanaf Volendam) -> knooppunt "36"
 * dichtbij Hilversum (al bevestigd goed lokaal netwerk) -- test de verbinding tussen deze
 * twee bevestigd-goede gebieden RECHTSTREEKS, Volendam wordt hier overgeslagen.
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
  fromDisplayNumber: string;
  fromLat: number;
  fromLon: number;
  toDisplayNumber: string;
  toLat: number;
  toLon: number;
};

export default function DirectRoutePage() {
  const [fromNodeId, setFromNodeId] = useState("");
  const [toNodeId, setToNodeId] = useState("");
  const [fromDisplay, setFromDisplay] = useState("");
  const [toDisplay, setToDisplay] = useState("");
  const [nearFromLat, setNearFromLat] = useState("52.3875"); // IJplein, noordkant IJ (F2-pontje)
  const [nearFromLon, setNearFromLon] = useState("4.9080");
  const [nearToLat, setNearToLat] = useState("52.37833"); // Amsterdam Centraal, zuidkant
  const [nearToLon, setNearToLon] = useState("4.90000");
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
      if (nearFromLat.trim() && nearFromLon.trim()) {
        body.nearFromLat = parseFloat(nearFromLat);
        body.nearFromLon = parseFloat(nearFromLon);
      }
      if (nearToLat.trim() && nearToLon.trim()) {
        body.nearToLat = parseFloat(nearToLat);
        body.nearToLon = parseFloat(nearToLon);
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
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Vooraf ingevuld: IJplein (noordkant IJ, officiële F2-pontverbinding) → Amsterdam Centraal (zuidkant). Test of ook déze pontje-oversteek ontbreekt in de data, net als Buiksloterweg.
      </p>

      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 4 }}>Van: exact ID (leeg = weergavenummer + referentiepunt eronder)</p>
      <input value={fromNodeId} onChange={(e) => setFromNodeId(e.target.value)} placeholder="Exact van-ID" style={{ width: "100%", padding: 8, fontSize: 14, fontFamily: "monospace", marginBottom: 4, boxSizing: "border-box" }} />
      <input value={fromDisplay} onChange={(e) => setFromDisplay(e.target.value)} placeholder="Van weergavenummer" style={{ width: "100%", padding: 8, fontSize: 16, marginBottom: 4, boxSizing: "border-box" }} />
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input value={nearFromLat} onChange={(e) => setNearFromLat(e.target.value)} placeholder="Herkomst-referentie lat" style={{ flex: 1, padding: 8, fontSize: 14 }} />
        <input value={nearFromLon} onChange={(e) => setNearFromLon(e.target.value)} placeholder="Herkomst-referentie lon" style={{ flex: 1, padding: 8, fontSize: 14 }} />
      </div>

      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 4 }}>Naar: exact ID (leeg = weergavenummer + referentiepunt eronder)</p>
      <input value={toNodeId} onChange={(e) => setToNodeId(e.target.value)} placeholder="Exact naar-ID" style={{ width: "100%", padding: 8, fontSize: 14, fontFamily: "monospace", marginBottom: 4, boxSizing: "border-box" }} />
      <input value={toDisplay} onChange={(e) => setToDisplay(e.target.value)} placeholder="Naar weergavenummer" style={{ width: "100%", padding: 8, fontSize: 16, marginBottom: 4, boxSizing: "border-box" }} />
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input value={nearToLat} onChange={(e) => setNearToLat(e.target.value)} placeholder="Bestemming-referentie lat" style={{ flex: 1, padding: 8, fontSize: 14 }} />
        <input value={nearToLon} onChange={(e) => setNearToLon(e.target.value)} placeholder="Bestemming-referentie lon" style={{ flex: 1, padding: 8, fontSize: 14 }} />
      </div>

      <button onClick={test} disabled={loading} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8 }}>
        {loading ? "Bezig..." : "Test"}
      </button>

      {error && <p style={{ color: "red", marginTop: 16 }}>{error}</p>}

      {result && (
        <div style={{ marginTop: 16, padding: 14, border: "1px solid #ccc", borderRadius: 8, fontSize: 14, fontFamily: "monospace" }}>
          <div style={{ wordBreak: "break-all", marginBottom: 8 }}>{result.fromNodeId} → {result.toNodeId}</div>
          <div style={{ marginBottom: 8, opacity: 0.7 }}>
            Knooppunt {result.fromDisplayNumber} → Knooppunt {result.toDisplayNumber}
            <br />
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
