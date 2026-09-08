"use client";

import { useState } from "react";

type NwbSegment = {
  id: string;
  bstCode: string | null;
  wegnummer: string | null;
  straatnaam: string | null;
  wegbeheerder: string | null;
  coordinates: { x: number; y: number }[];
};

export default function NwbCombinedRouteTestPage() {
  const [datasetVersionId, setDatasetVersionId] = useState("uINZ3y2QsgBdEyky3duq");
  const [fromNodeId, setFromNodeId] = useState("CJSXBPUMG49vOPmYvhJd");
  const [toNodeId, setToNodeId] = useState("ZYuO6ZfzSa2iim0HcUbn");
  const [totalTiles, setTotalTiles] = useState("6");
  const [radiusM, setRadiusM] = useState("3000");
  const [status, setStatus] = useState<"idle" | "tegels" | "route" | "klaar" | "fout">("idle");
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  function getKey() {
    return window.localStorage.getItem("goknoop_debug_secret") || "";
  }

  async function run() {
    setStatus("tegels");
    setError(null);
    setLog([]);
    setResult(null);
    try {
      const key = getKey();
      const n = Number(totalTiles);
      const segmentsById = new Map<string, NwbSegment>();
      let anyTruncated = false;

      for (let i = 0; i < n; i++) {
        const params = new URLSearchParams({
          datasetVersionId,
          from: fromNodeId,
          to: toNodeId,
          tileIndex: String(i),
          totalTiles: String(n),
          radiusM,
        });
        if (key) params.set("key", key);
        const res = await fetch(`/api/debug/nwb-corridor-tile?${params.toString()}`, { cache: "no-store" });
        const rawText = await res.text();
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(rawText);
        } catch {
          throw new Error(`Tegel ${i}: geen geldige JSON terug (status ${res.status}): ${rawText.slice(0, 300)}`);
        }
        if (!res.ok) throw new Error(`Tegel ${i}: ${json.details ?? json.error ?? "onbekende fout"}`);
        for (const seg of json.segments as NwbSegment[]) {
          segmentsById.set(seg.id, seg); // dedupliceren op ID -- overlappende tegels tellen niet dubbel
        }
        if (json.truncated) anyTruncated = true;
        setLog((prev) => [...prev, `Tegel ${i + 1}/${n}: ${(json.segments as NwbSegment[]).length} segmenten (${json.pagesRetrieved} pagina's, ${json.truncated ? "AFGEKAPT" : "compleet"}). Totaal uniek zover: ${segmentsById.size}`]);
      }

      setLog((prev) => [...prev, `Alle tegels opgehaald. ${segmentsById.size} unieke NWB-segmenten totaal. ${anyTruncated ? "⚠️ Minstens 1 tegel was afgekapt." : "Alle tegels compleet."}`]);
      setStatus("route");

      const nwbSegments = Array.from(segmentsById.values());
      const resultatenPerTolerantie: Record<string, unknown> = {};
      for (const tol of [2, 5, 10]) {
        setLog((prev) => [...prev, `Gecombineerde graaf bouwen en Dijkstra draaien (${tol}m)...`]);
        const routeRes = await fetch(`/api/debug/nwb-combined-route-test${key ? `?key=${encodeURIComponent(key)}` : ""}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            datasetVersionId,
            from: fromNodeId,
            to: toNodeId,
            nwbSegments,
            toleranceM: tol,
          }),
        });
        const rawText = await routeRes.text();
        let routeJson: Record<string, unknown>;
        try {
          routeJson = JSON.parse(rawText);
        } catch {
          throw new Error(`Tolerantie ${tol}m: geen geldige JSON terug (status ${routeRes.status}): ${rawText.slice(0, 300)}`);
        }
        if (!routeRes.ok) throw new Error(`Tolerantie ${tol}m: ${routeJson.details ?? routeJson.error ?? "onbekende fout"}`);
        resultatenPerTolerantie[`${tol}m`] = routeJson;
        setLog((prev) => [...prev, `${tol}m klaar: ${routeJson.routeFound ? `route gevonden, ${routeJson.distanceMeters}m` : "geen route gevonden"}`]);
      }
      const routeJson = { resultatenPerTolerantie };

      setResult(routeJson);
      setStatus("klaar");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("fout");
    }
  }

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Beslissende gecombineerde routetest</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Verzamelt de volledige corridor in tegels, bouwt een tijdelijke GoKnoop+NWB-graaf, en test of Dijkstra een realistische route vindt. Puur lezend, niets opgeslagen.
      </p>

      <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
        <input value={datasetVersionId} onChange={(e) => setDatasetVersionId(e.target.value)} placeholder="datasetVersionId" style={{ padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8 }} />
        <input value={fromNodeId} onChange={(e) => setFromNodeId(e.target.value)} placeholder="from" style={{ padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8 }} />
        <input value={toNodeId} onChange={(e) => setToNodeId(e.target.value)} placeholder="to" style={{ padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8 }} />
        <div style={{ display: "flex", gap: 8 }}>
          <input value={totalTiles} onChange={(e) => setTotalTiles(e.target.value)} placeholder="aantal tegels" style={{ flex: 1, padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8 }} />
          <input value={radiusM} onChange={(e) => setRadiusM(e.target.value)} placeholder="straal per tegel (m)" style={{ flex: 1, padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8 }} />
        </div>
      </div>

      <button
        onClick={run}
        disabled={status === "tegels" || status === "route"}
        style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 16 }}
      >
        {status === "tegels" ? "Tegels ophalen..." : status === "route" ? "Route berekenen..." : "Start beslissende test"}
      </button>

      {log.length > 0 && (
        <div style={{ fontSize: 11, background: "#f0f0eb", padding: 10, borderRadius: 8, marginBottom: 12 }}>
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}

      {status === "fout" && <p style={{ color: "red" }}>⚠️ {error}</p>}

      {status === "klaar" && result && (
        <pre style={{ fontSize: 11, background: "#f5f5f0", padding: 12, borderRadius: 8, overflowX: "auto", whiteSpace: "pre-wrap" }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}
