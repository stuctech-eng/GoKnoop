"use client";

import { useState } from "react";

/**
 * Handmatig testformulier voor de drie nieuwe capabilities:
 * location-resolve, route/alternatives, route/loop.
 * Alleen voor eigen gebruik.
 */

type LoopSummaryItem = {
  actualDistanceM: number;
  deviationM: number;
  deviationPercent: number;
  targetDistanceM: number;
  nodeCount: number;
  edgeCount: number;
};
type RouteSummaryItem = { distanceM: number; nodeCount: number; edgeCount: number };

export default function CapabilitiesTestPage() {
  const [placeName, setPlaceName] = useState("Utrecht");
  const [loopStartId, setLoopStartId] = useState("");
  const [targetDistanceKm, setTargetDistanceKm] = useState(20);
  const [altFrom, setAltFrom] = useState("ysPQwdlis6xmkwthaZYL");
  const [altTo, setAltTo] = useState("4LfEocIOnTjfHJTWNHlj");
  const [result, setResult] = useState<string>("");
  const [summary, setSummary] = useState<string>("");
  const [loading, setLoading] = useState(false);

  function buildSummaryObject(path: string, data: Record<string, unknown>): Record<string, unknown> {
    if (path === "/api/location/resolve") {
      const candidates =
        (data.candidates as {
          logicalNodeId: string;
          displayNumber?: string;
          displayRegio?: string;
          distanceM: number;
          edgeCount?: number;
        }[]) || [];
      return {
        geocodedAs: data.geocodedAs,
        candidateCount: candidates.length,
        candidates: candidates.map((c) => ({
          logicalNodeId: c.logicalNodeId,
          displayNumber: c.displayNumber,
          displayRegio: c.displayRegio,
          distanceM: Math.round(c.distanceM),
          edgeCount: c.edgeCount,
        })),
      };
    }
    if (path === "/api/route/loop") {
      const loops =
        (data.loops as {
          actualDistanceM: number;
          deviationM: number;
          deviationPercent: number;
          targetDistanceM: number;
          route: { nodes: string[]; edges: string[] };
        }[]) || [];
      const summaryItems: LoopSummaryItem[] = loops.map((l) => ({
        actualDistanceM: Math.round(l.actualDistanceM),
        deviationM: Math.round(l.deviationM),
        deviationPercent: Math.round(l.deviationPercent * 10) / 10,
        targetDistanceM: l.targetDistanceM,
        nodeCount: l.route.nodes.length,
        edgeCount: l.route.edges.length,
      }));
      return {
        foundCount: data.foundCount,
        requestedCount: data.requestedCount,
        estimatedRadiusM: data.estimatedRadiusM ? Math.round(data.estimatedRadiusM as number) : undefined,
        diagnostics: data.diagnostics,
        loops: summaryItems,
      };
    }
    if (path === "/api/route/alternatives") {
      const routes = (data.routes as { distanceM: number; nodes: string[]; edges: string[] }[]) || [];
      const summaryItems: RouteSummaryItem[] = routes.map((r) => ({
        distanceM: Math.round(r.distanceM),
        nodeCount: r.nodes.length,
        edgeCount: r.edges.length,
      }));
      return { foundCount: data.foundCount, requestedCount: data.requestedCount, routes: summaryItems };
    }
    return data;
  }

  async function callApi(path: string, body: unknown) {
    setLoading(true);
    setResult("Bezig...");
    setSummary("");
    const t0 = Date.now();
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      const clientTimeMs = Date.now() - t0;
      setResult(JSON.stringify({ httpStatus: res.status, clientTimeMs, response: data }, null, 2));

      if (res.ok) {
        setSummary(JSON.stringify({ httpStatus: res.status, clientTimeMs, ...buildSummaryObject(path, data) }, null, 2));
      } else {
        setSummary(JSON.stringify({ httpStatus: res.status, clientTimeMs, error: data.error, details: data.details }, null, 2));
      }

      if (data?.candidates?.[0]?.logicalNodeId) {
        setLoopStartId(data.candidates[0].logicalNodeId);
      }
    } catch (err) {
      const msg = `Fout: ${err instanceof Error ? err.message : String(err)}`;
      setResult(msg);
      setSummary(msg);
    }
    setLoading(false);
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      alert("Gekopieerd naar klembord.");
    } catch {
      alert("Kopiëren mislukt — selecteer de tekst handmatig.");
    }
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
        <p style={{ fontSize: 12, color: "#666" }}>
          Het eerste gevonden knooppunt wordt automatisch ingevuld als startpunt hieronder.
        </p>
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
          onClick={() =>
            callApi("/api/route/loop", {
              startLogicalNodeId: loopStartId,
              targetDistanceM: targetDistanceKm * 1000,
              count: 4,
            })
          }
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

      <div style={{ marginTop: "1.5rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontSize: 16 }}>Samenvatting (zonder geometrie — kopieer dit)</h2>
          <button onClick={() => copyToClipboard(summary)} disabled={!summary} style={{ padding: "6px 10px", fontSize: 13 }}>
            📋 Kopieer samenvatting
          </button>
        </div>
        <pre
          style={{
            marginTop: 8,
            background: "#111",
            color: "#0f0",
            padding: 12,
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            borderRadius: 6,
            maxHeight: 350,
            overflowY: "auto",
          }}
        >
          {summary}
        </pre>
      </div>

      <div style={{ marginTop: "1.5rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontSize: 16 }}>Volledig antwoord (incl. geometrie — groot)</h2>
          <button onClick={() => copyToClipboard(result)} disabled={!result} style={{ padding: "6px 10px", fontSize: 13 }}>
            📋 Kopieer alles
          </button>
        </div>
        <pre
          style={{
            marginTop: 8,
            background: "#111",
            color: "#0f0",
            padding: 12,
            fontSize: 11,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            borderRadius: 6,
            maxHeight: 300,
            overflowY: "auto",
          }}
        >
          {result}
        </pre>
      </div>
    </main>
  );
}
