"use client";

/**
 * Route-geometrie-inspector (Naarden-onderzoek 29-8-2026).
 *
 * Doel: per edge in een gevonden route laten zien hoeveel geometriepunten
 * die heeft t.o.v. de lengte (distanceM) -- een edge met een groot
 * distanceM maar slechts 2 punten tekent letterlijk een rechte lijn i.p.v.
 * het daadwerkelijke, bochtige fietspad. Dat is een brondata-kenmerk, geen
 * navigatie-enginefout.
 *
 * Roept uitsluitend bestaande, al gedeployde endpoints aan
 * (/api/location/resolve, /api/route/loop) -- de benodigde data
 * (resolvedEdges met geometry per edge) zit al in de bestaande respons,
 * geen serverwijziging nodig.
 */

import { useState } from "react";

type GraphEdgeLike = {
  id: string;
  distanceM: number;
  geometry: { x: number; y: number }[];
};

type LoopCandidate = {
  route: { distanceM: number; nodes: string[]; edges: string[] };
  resolvedEdges: GraphEdgeLike[];
  nodeDisplayNumbers: string[];
};

const SUSPICIOUS_DISTANCE_M = 100; // vanaf welke lengte 2 punten verdacht is
const SUSPICIOUS_MAX_POINTS = 2;

export default function RouteGeometryInspectorPage() {
  const [placeName, setPlaceName] = useState("Naarden");
  const [km, setKm] = useState(20);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loops, setLoops] = useState<LoopCandidate[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  async function run() {
    setError(null);
    setLoops([]);
    setLoading(true);
    try {
      const resolveRes = await fetch("/api/location/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ placeName, limit: 5 }),
      });
      const resolveData = await resolveRes.json();
      if (!resolveRes.ok || !resolveData.candidates?.length) {
        setError(resolveData.error ?? "Locatie niet gevonden.");
        setLoading(false);
        return;
      }

      const loopRes = await fetch("/api/route/loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateNodeIds: resolveData.candidates.map((c: { logicalNodeId: string }) => c.logicalNodeId),
          candidateDistancesM: resolveData.candidates.map((c: { distanceM: number }) => c.distanceM),
          targetDistanceM: km * 1000,
          count: 4,
        }),
      });
      const loopData = await loopRes.json();
      if (!loopRes.ok) {
        setError(loopData.error ?? "Geen route gevonden.");
        setLoading(false);
        return;
      }

      setLoops(loopData.loops ?? []);
      setSelectedIdx(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const loop = loops[selectedIdx];

  return (
    <div style={{ padding: 16, maxWidth: 480, margin: "0 auto", fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 18 }}>Route-geometrie-inspector</h1>
      <p style={{ fontSize: 13, color: "#555" }}>
        Toont per edge het aantal geometriepunten t.o.v. de lengte -- een lange edge met maar 2
        punten tekent een rechte lijn i.p.v. het echte fietspad.
      </p>

      <input
        value={placeName}
        onChange={(e) => setPlaceName(e.target.value)}
        placeholder="Plaatsnaam"
        style={{ width: "100%", padding: 10, fontSize: 16, marginTop: 12, boxSizing: "border-box" }}
      />
      <input
        type="number"
        value={km}
        onChange={(e) => setKm(Number(e.target.value))}
        style={{ width: "100%", padding: 10, fontSize: 16, marginTop: 8, boxSizing: "border-box" }}
      />
      <button
        onClick={run}
        disabled={loading}
        style={{ width: "100%", padding: 14, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginTop: 8 }}
      >
        {loading ? "Bezig..." : "Zoek en inspecteer"}
      </button>

      {error && <p style={{ color: "#b00020", fontSize: 13, marginTop: 12 }}>{error}</p>}

      {loops.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
            {loops.map((l, i) => (
              <button
                key={i}
                onClick={() => setSelectedIdx(i)}
                style={{
                  padding: "6px 10px",
                  fontSize: 12,
                  borderRadius: 6,
                  border: i === selectedIdx ? "2px solid #085041" : "1px solid #ccc",
                  background: i === selectedIdx ? "#e8f3ee" : "white",
                }}
              >
                Route {i + 1} ({(l.route.distanceM / 1000).toFixed(1)}km)
              </button>
            ))}
          </div>

          {loop && (
            <>
              <p style={{ fontSize: 13 }}>
                <strong>Knooppunten:</strong> {loop.nodeDisplayNumbers.join(" → ")}
              </p>
              <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", fontFamily: "monospace" }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
                    <th style={{ padding: 4 }}>edge</th>
                    <th style={{ padding: 4 }}>distanceM</th>
                    <th style={{ padding: 4 }}>#punten</th>
                    <th style={{ padding: 4 }}>m/punt</th>
                    <th style={{ padding: 4 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {loop.resolvedEdges.map((edge) => {
                    const suspicious = edge.geometry.length <= SUSPICIOUS_MAX_POINTS && edge.distanceM >= SUSPICIOUS_DISTANCE_M;
                    return (
                      <tr key={edge.id} style={{ background: suspicious ? "#ffe8e8" : "transparent", borderBottom: "1px solid #eee" }}>
                        <td style={{ padding: 4 }}>{edge.id.slice(0, 10)}...</td>
                        <td style={{ padding: 4 }}>{Math.round(edge.distanceM)}m</td>
                        <td style={{ padding: 4 }}>{edge.geometry.length}</td>
                        <td style={{ padding: 4 }}>{Math.round(edge.distanceM / edge.geometry.length)}m</td>
                        <td style={{ padding: 4, color: "#b00020", fontWeight: 700 }}>{suspicious ? "⚠ VERDACHT" : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
}
