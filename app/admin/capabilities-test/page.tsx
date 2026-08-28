"use client";

import { useState } from "react";

/**
 * Handmatig testformulier voor de drie nieuwe capabilities:
 * location-resolve, route/alternatives, route/loop.
 * Alleen voor eigen gebruik.
 */
export default function CapabilitiesTestPage() {
  const [placeName, setPlaceName] = useState("Utrecht");
  const [loopStartId, setLoopStartId] = useState("");
  const [targetDistanceKm, setTargetDistanceKm] = useState(20);
  const [altFrom, setAltFrom] = useState("ysPQwdlis6xmkwthaZYL");
  const [altTo, setAltTo] = useState("4LfEocIOnTjfHJTWNHlj");
  const [result, setResult] = useState<string>("");
  const [loading, setLoading] = useState(false);

  async function callApi(path: string, body: unknown) {
    setLoading(true);
    setResult("Bezig...");
    const t0 = Date.now();
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setResult(JSON.stringify({ httpStatus: res.status, clientTimeMs: Date.now() - t0, response: data }, null, 2));
      if (data?.candidates?.[0]?.logicalNodeId) {
        setLoopStartId(data.candidates[0].logicalNodeId);
      }
    } catch (err) {
      setResult(`Fout: ${err instanceof Error ? err.message : String(err)}`);
    }
    setLoading(false);
  }

  return (
    <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 600, margin: "0 auto" }}>
      <h1>GoKnoop — Capabilities Test</h1>

      <section style={{ marginTop: "1.5rem", padding: "1rem", border: "1px solid #ddd", borderRadius: 8 }}>
        <h2 style={{ fontSize: 18 }}>1. Location Resolver</h2>
        <label style={{ display: "block", fontSize: 14, marginTop: 8 }}>Plaatsnaam</label>
        <input
          value={placeName}
          onChange={(e) => setPlaceName(e.target.value)}
          style={{ width: "100%", padding: 8, fontSize: 16 }}
        />
        <button
          disabled={loading}
          onClick={() => callApi("/api/location/resolve", { placeName })}
          style={{ marginTop: 8, padding: "8px 14px" }}
        >
          Zoek dichtstbijzijnde knooppunten
        </button>
        <p style={{ fontSize: 12, color: "#666" }}>Het eerste gevonden knooppunt wordt automatisch ingevuld als startpunt hieronder.</p>
      </section>

      <section style={{ marginTop: "1.5rem", padding: "1rem", border: "1px solid #ddd", borderRadius: 8 }}>
        <h2 style={{ fontSize: 18 }}>2. Rondje-generator (loop)</h2>
        <label style={{ display: "block", fontSize: 14, marginTop: 8 }}>startLogicalNodeId</label>
        <input
          value={loopStartId}
          onChange={(e) => setLoopStartId(e.target.value)}
          style={{ width: "100%", padding: 8, fontSize: 16 }}
        />
        <label style={{ display: "block", fontSize: 14, marginTop: 8 }}>Gewenste afstand (km)</label>
        <input
          type="number"
          value={targetDistanceKm}
          onChange={(e) => setTargetDistanceKm(parseFloat(e.target.value))}
          style={{ width: "100%", padding: 8, fontSize: 16 }}
        />
        <button
          disabled={loading || !loopStartId}
          onClick={() => callApi("/api/route/loop", { startLogicalNodeId: loopStartId, targetDistanceM: targetDistanceKm * 1000, count: 4 })}
          style={{ marginTop: 8, padding: "8px 14px" }}
        >
          Genereer 4 rondjes
        </button>
      </section>

      <section style={{ marginTop: "1.5rem", padding: "1rem", border: "1px solid #ddd", borderRadius: 8 }}>
        <h2 style={{ fontSize: 18 }}>3. Route-alternatieven (A→B)</h2>
        <label style={{ display: "block", fontSize: 14, marginTop: 8 }}>fromLogicalNodeId</label>
        <input
          value={altFrom}
          onChange={(e) => setAltFrom(e.target.value)}
          style={{ width: "100%", padding: 8, fontSize: 16 }}
        />
        <label style={{ display: "block", fontSize: 14, marginTop: 8 }}>toLogicalNodeId</label>
        <input
          value={altTo}
          onChange={(e) => setAltTo(e.target.value)}
          style={{ width: "100%", padding: 8, fontSize: 16 }}
        />
        <button
          disabled={loading}
          onClick={() => callApi("/api/route/alternatives", { fromLogicalNodeId: altFrom, toLogicalNodeId: altTo, count: 4 })}
          style={{ marginTop: 8, padding: "8px 14px" }}
        >
          Genereer 4 alternatieven
        </button>
      </section>

      <pre
        style={{
          marginTop: "1.5rem",
          background: "#111",
          color: "#0f0",
          padding: 12,
          fontSize: 11,
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
