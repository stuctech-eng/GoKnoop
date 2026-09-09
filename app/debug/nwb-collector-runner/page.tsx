"use client";

import { useState, useRef } from "react";
import { analyzeSlimNwbGraph, countPointsNearAnyOther } from "@/lib/nwb-analysis/graph-analysis";
import { classifySegment } from "@/lib/nwb-analysis/classify";
import type { SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

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

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Eén tick-aanroep, zonder te gooien -- retourneert altijd een resultaat, zodat de aanroeper zelf over retries kan beslissen. */
  async function fetchTickOnce(regionKey: string, key: string): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; errorMsg: string }> {
    try {
      const params = new URLSearchParams({ region: regionKey });
      if (key) params.set("key", key);
      const res = await fetch(`/api/debug/nwb-collector-tick?${params.toString()}`, { method: "POST", cache: "no-store" });
      const rawText = await res.text();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(rawText);
      } catch {
        return { ok: false, errorMsg: `geen geldige JSON (status ${res.status}): ${rawText.slice(0, 200)}` };
      }
      if (!res.ok) {
        return { ok: false, errorMsg: String(json.details ?? json.error ?? "onbekende fout") };
      }
      return { ok: true, json };
    } catch (err) {
      return { ok: false, errorMsg: err instanceof Error ? err.message : String(err) };
    }
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
    const MAX_RETRIES_PER_TICK = 3;
    const RETRY_DELAYS_MS = [1000, 2000, 4000];

    while (!stopRef.current && ticks < MAX_TICKS) {
      ticks++;

      let attempt = 0;
      let result = await fetchTickOnce(regionKey, key);
      while (!result.ok && attempt < MAX_RETRIES_PER_TICK) {
        setLog((prev) => [...prev, `⚠️ Tick ${ticks}, poging ${attempt + 1} mislukt (${result.ok ? "" : result.errorMsg}) -- opnieuw proberen...`]);
        await sleep(RETRY_DELAYS_MS[attempt] ?? 4000);
        result = await fetchTickOnce(regionKey, key);
        attempt++;
      }

      if (!result.ok) {
        setLog((prev) => [...prev, `⚠️ Tick ${ticks}: definitief mislukt na ${MAX_RETRIES_PER_TICK} nieuwe pogingen: ${result.ok ? "" : result.errorMsg}. Gestopt.`]);
        break;
      }

      const json = result.json;
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
    }
    setRunning(false);
  }

  async function finalize(regionKey: string) {
    setRunning(true);
    setFinalResult(null);
    setLog([]);
    const key = getKey();

    // Stap 1: alle tegels gepagineerd inlezen (klein en snel per aanroep,
    // vermijdt de 504 die ontstond door 100+ tegels in één keer te lezen).
    const segmentsById = new Map<string, SlimNwbSegment>();
    let offset = 0;
    let totalTiles = 0;
    for (;;) {
      try {
        const params = new URLSearchParams({ region: regionKey, offset: String(offset) });
        if (key) params.set("key", key);
        const res = await fetch(`/api/debug/nwb-collector-read-tiles?${params.toString()}`, { cache: "no-store" });
        const rawText = await res.text();
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(rawText);
        } catch {
          setLog((prev) => [...prev, `⚠️ Tegels lezen (offset ${offset}): geen geldige JSON (status ${res.status}): ${rawText.slice(0, 300)}`]);
          setRunning(false);
          return;
        }
        if (!res.ok) {
          setLog((prev) => [...prev, `⚠️ Tegels lezen (offset ${offset}): ${json.details ?? json.error}`]);
          setRunning(false);
          return;
        }
        totalTiles = json.totalTiles as number;
        for (const seg of json.segments as SlimNwbSegment[]) {
          segmentsById.set(seg.id, seg);
        }
        setLog((prev) => [...prev, `Tegels ${offset + 1}-${offset + (json.tilesInPage as number)} van ${totalTiles} gelezen. Totaal uniek zover: ${segmentsById.size}`]);
        if (json.done) break;
        offset += json.tilesInPage as number;
      } catch (err) {
        setLog((prev) => [...prev, `⚠️ Tegels lezen (offset ${offset}): ${err instanceof Error ? err.message : String(err)}`]);
        setRunning(false);
        return;
      }
    }

    // Stap 2: GoKnoop-knopen voor deze regio ophalen (klein, snel).
    setLog((prev) => [...prev, "Alle tegels gelezen -- GoKnoop-knopen ophalen..."]);
    let goknoopNodes: { x: number; y: number }[] = [];
    let routingTestBeschikbaar = false;
    try {
      const params = new URLSearchParams({ region: regionKey, datasetVersionId });
      if (key) params.set("key", key);
      const res = await fetch(`/api/debug/nwb-collector-goknoop-nodes?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setLog((prev) => [...prev, `⚠️ GoKnoop-knopen: ${json.details ?? json.error}`]);
        setRunning(false);
        return;
      }
      goknoopNodes = json.nodes;
      routingTestBeschikbaar = json.routingTestBeschikbaar;
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ GoKnoop-knopen: ${err instanceof Error ? err.message : String(err)}`]);
      setRunning(false);
      return;
    }

    // Stap 3: berekening CLIENT-SIDE (de browser heeft geen 10s-tijdslimiet).
    setLog((prev) => [...prev, "Berekening starten (kan even duren bij grote regio's)..."]);
    await sleep(50); // laat de UI de logregel nog tonen vóór de (synchrone) berekening start
    const allSegments = Array.from(segmentsById.values());
    const bstCodeDistribution: Record<string, number> = {};
    for (const s of allSegments) {
      const code = s.bstCode ?? "(leeg)";
      bstCodeDistribution[code] = (bstCodeDistribution[code] || 0) + 1;
    }
    const setASegments = allSegments.filter((s) => classifySegment(s.bstCode, s.wegnummer) === "setA");
    const setBSegments = allSegments.filter((s) => classifySegment(s.bstCode, s.wegnummer) !== "excluded");
    const componentAnalyse = {
      setA: Object.fromEntries([5, 10, 20].map((t) => [`${t}m`, analyzeSlimNwbGraph(setASegments, t)])),
      setB: Object.fromEntries([5, 10, 20].map((t) => [`${t}m`, analyzeSlimNwbGraph(setBSegments, t)])),
    };
    const nwbEndpoints = setBSegments.flatMap((s) => [s.from, s.to]);
    const proximity: Record<string, number> = {};
    for (const tol of [10, 20, 50]) {
      proximity[`${tol}m`] = countPointsNearAnyOther(goknoopNodes, nwbEndpoints, tol);
    }

    const componentsResult = {
      region: regionKey,
      tegelsCompleet: totalTiles,
      uniekeSegmenten: allSegments.length,
      bstCodeVerdeling: bstCodeDistribution,
      setASegmentCount: setASegments.length,
      setBSegmentCount: setBSegments.length,
      componentAnalyse,
      goknoop: { knopenInRegio: goknoopNodes.length, proximityTotNwbSetB: proximity },
    };

    // Stap 4: routetest, alleen indien van toepassing (server-side, apart eindpunt).
    let routingJson: Record<string, unknown> | null = null;
    if (routingTestBeschikbaar) {
      setLog((prev) => [...prev, "Componenten klaar -- routetest starten (kan een paar seconden duren)..."]);
      try {
        const params = new URLSearchParams({ region: regionKey, datasetVersionId, toleranceM: "10" });
        if (key) params.set("key", key);
        const res = await fetch(`/api/debug/nwb-collector-finalize-routing?${params.toString()}`, { cache: "no-store" });
        const rawText = await res.text();
        try {
          routingJson = JSON.parse(rawText);
        } catch {
          setLog((prev) => [...prev, `⚠️ Afronden (routetest): geen geldige JSON (status ${res.status}): ${rawText.slice(0, 300)}`]);
        }
        if (routingJson && !res.ok) {
          setLog((prev) => [...prev, `⚠️ Afronden (routetest): ${routingJson?.details ?? routingJson?.error}`]);
          routingJson = { error: routingJson.error, details: routingJson.details };
        }
      } catch (err) {
        setLog((prev) => [...prev, `⚠️ Afronden (routetest): ${err instanceof Error ? err.message : String(err)}`]);
      }
    }

    setFinalResult({ ...componentsResult, routingTest: routingJson ?? "niet van toepassing voor deze regio (connectiviteit-only)" });
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
