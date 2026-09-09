"use client";

import { useState, useRef } from "react";

const REGIONS = [
  { key: "hilversum", label: "Amsterdam <-> Hilversum" },
  { key: "lochem", label: "Lochem / Achterhoek" },
  { key: "volendam", label: "Volendam / Edam / Purmerend" },
];

export default function NwbCollectorRunnerPage() {
  const [datasetVersionId, setDatasetVersionId] = useState("uINZ3y2QsgBdEyky3duq");
  const [activeRegion, setActiveRegion] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [tickCount, setTickCount] = useState(0);
  const [completeTiles, setCompleteTiles] = useState(0);
  const [splitTiles, setSplitTiles] = useState(0);
  const [finalResult, setFinalResult] = useState<Record<string, unknown> | null>(null);
  const stopRef = useRef(false);

  function getKey() {
    return window.localStorage.getItem("goknoop_debug_secret") || "";
  }

  async function runCollector(regionKey: string) {
    setActiveRegion(regionKey);
    setRunning(true);
    setLog([]);
    setFinalResult(null);
    setTickCount(0);
    setCompleteTiles(0);
    setSplitTiles(0);
    stopRef.current = false;

    const key = getKey();
    let ticks = 0;
    const MAX_TICKS = 500; // veiligheidslimiet -- voorkomt een oneindige loop bij een onverwachte fout

    while (!stopRef.current && ticks < MAX_TICKS) {
      ticks++;
      try {
        const params = new URLSearchParams({ region: regionKey });
        if (key) params.set("key", key);
        const res = await fetch(`/api/debug/nwb-collector-tick?${params.toString()}`, { method: "POST", cache: "no-store" });
        const rawText = await res.text();
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(rawText);
        } catch {
          setLog((prev) => [...prev, `⚠️ Tick ${ticks}: geen geldige JSON (status ${res.status}): ${rawText.slice(0, 200)}`]);
          break;
        }
        if (!res.ok) {
          setLog((prev) => [...prev, `⚠️ Tick ${ticks}: ${json.details ?? json.error}`]);
          break;
        }
        setTickCount(ticks);
        if (json.done) {
          setCompleteTiles(json.completeTiles as number);
          setSplitTiles(json.splitTiles as number);
          setLog((prev) => [...prev, `✅ Verzameling compleet na ${ticks} stappen. ${json.completeTiles} tegels compleet, ${json.splitTiles} gesplitst.`]);
          break;
        }
        if (json.action === "split") {
          setLog((prev) => [...prev, `Tick ${ticks}: tegel ${json.tileId} gesplitst (${json.reason}, ${json.segmentsSeen} segmenten gezien)`]);
        } else {
          setLog((prev) => [...prev, `Tick ${ticks}: tegel ${json.tileId} compleet (${json.segmentCount} segmenten)`]);
        }
      } catch (err) {
        setLog((prev) => [...prev, `⚠️ Tick ${ticks}: ${err instanceof Error ? err.message : String(err)}`]);
        break;
      }
    }
    setRunning(false);
  }

  async function finalize(regionKey: string) {
    setRunning(true);
    try {
      const key = getKey();
      const params = new URLSearchParams({ region: regionKey, datasetVersionId });
      if (key) params.set("key", key);
      const res = await fetch(`/api/debug/nwb-collector-finalize?${params.toString()}`, { cache: "no-store" });
      const rawText = await res.text();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(rawText);
      } catch {
        setLog((prev) => [...prev, `⚠️ Afronden: geen geldige JSON (status ${res.status}): ${rawText.slice(0, 300)}`]);
        setRunning(false);
        return;
      }
      if (!res.ok) {
        setLog((prev) => [...prev, `⚠️ Afronden: ${json.details ?? json.error}`]);
        setRunning(false);
        return;
      }
      setFinalResult(json);
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ Afronden: ${err instanceof Error ? err.message : String(err)}`]);
    }
    setRunning(false);
  }

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>NWB-verzamelaar (onderzoeksinfrastructuur)</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Eenmalige, tijdelijke infrastructuur -- geen productiefeature. Verzamelt systematisch, gegarandeerd-compleet NWB per regio (automatisch opsplitsen bij afkapping), dan pas de definitieve analyse.
      </p>

      <input
        value={datasetVersionId}
        onChange={(e) => setDatasetVersionId(e.target.value)}
        placeholder="datasetVersionId"
        style={{ width: "100%", padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12 }}
      />

      <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
        {REGIONS.map((r) => (
          <div key={r.key} style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => runCollector(r.key)}
              disabled={running}
              style={{ flex: 1, padding: 10, fontSize: 13, background: activeRegion === r.key ? "#085041" : "#eee", color: activeRegion === r.key ? "white" : "#333", border: "none", borderRadius: 8 }}
            >
              {running && activeRegion === r.key ? `Bezig... (${tickCount} stappen)` : `Verzamel: ${r.label}`}
            </button>
            <button
              onClick={() => finalize(r.key)}
              disabled={running}
              style={{ padding: "10px 14px", fontSize: 13, background: "#eee", color: "#333", border: "none", borderRadius: 8 }}
            >
              Afronden
            </button>
          </div>
        ))}
      </div>

      {running && (
        <button onClick={() => (stopRef.current = true)} style={{ width: "100%", padding: 10, fontSize: 13, background: "#c00", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
          Stop
        </button>
      )}

      {log.length > 0 && (
        <div style={{ fontSize: 11, background: "#f0f0eb", padding: 10, borderRadius: 8, marginBottom: 12, maxHeight: 300, overflowY: "auto" }}>
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}

      {finalResult && (
        <pre style={{ fontSize: 11, background: "#f5f5f0", padding: 12, borderRadius: 8, overflowX: "auto", whiteSpace: "pre-wrap" }}>
          {JSON.stringify(finalResult, null, 2)}
        </pre>
      )}
    </div>
  );
}
