"use client";

import { useState } from "react";
import { generateConnectorCandidates, type GoKnoopNodeInput, type NwbSegmentInput } from "@/lib/nwb-analysis/connector-candidates";
import type { ValidatedConnectorInput } from "@/lib/nwb-analysis/combined-graph";

const SAVE_CHUNK_SIZE = 400;
const SEARCH_RADIUS_M = 20;

export default function GenerateNwbConnectorsRunnerPage() {
  const [datasetVersionId, setDatasetVersionId] = useState("uINZ3y2QsgBdEyky3duq");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);

  function getKey() {
    return window.localStorage.getItem("goknoop_debug_secret") || "";
  }

  async function run() {
    setRunning(true);
    setLog([]);
    setSummary(null);
    const key = getKey();

    setLog((prev) => [...prev, "Landelijke GoKnoop-richtingen ophalen..."]);
    let goknoopNodes: GoKnoopNodeInput[] = [];
    try {
      const params = new URLSearchParams({ datasetVersionId });
      if (key) params.set("key", key);
      const res = await fetch(`/api/admin/goknoop-bearings-national?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setLog((prev) => [...prev, `⚠️ ${json.details ?? json.error}`]);
        setRunning(false);
        return;
      }
      goknoopNodes = json.nodes;
      setLog((prev) => [...prev, `${goknoopNodes.length} GoKnoop-knopen geladen.`]);
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ ${err instanceof Error ? err.message : String(err)}`]);
      setRunning(false);
      return;
    }

    setLog((prev) => [...prev, "Actieve NWB-productiedata lezen..."]);
    let nwbSegments: NwbSegmentInput[] = [];
    let nwbDatasetVersionId: string | null = null;
    try {
      const params = new URLSearchParams();
      if (key) params.set("key", key);
      const res = await fetch(`/api/admin/read-active-nwb-segments?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setLog((prev) => [...prev, `⚠️ ${json.details ?? json.error}`]);
        setRunning(false);
        return;
      }
      nwbDatasetVersionId = json.nwbDatasetVersionId;
      nwbSegments = json.segments; // rechtstreeks toewijzen, GEEN spread-operator -- bij ~144k elementen overschrijdt push(...groteArray) JavaScript's eigen argumentenlimiet ("Maximum call stack size exceeded", live bevestigd 10-9-2026)
      setLog((prev) => [...prev, `${nwbSegments.length} NWB-segmenten gelezen.`]);
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ ${err instanceof Error ? err.message : String(err)}`]);
      setRunning(false);
      return;
    }
    setLog((prev) => [...prev, `Klaar: ${nwbSegments.length} NWB-segmenten totaal (versie ${nwbDatasetVersionId}).`]);

    setLog((prev) => [...prev, "Connector-kandidaten genereren..."]);
    await new Promise((r) => setTimeout(r, 30));
    const candidateResult = generateConnectorCandidates(goknoopNodes, nwbSegments, SEARCH_RADIUS_M);
    const validated: ValidatedConnectorInput[] = candidateResult.candidates
      .filter((c) => c.confidence !== "rejected")
      .map((c) => ({ goknoopNodeId: c.goknoopNodeId, nwbSegmentId: c.nwbSegmentId, nwbEndpoint: c.nwbEndpoint, distanceM: c.distanceM, confidence: c.confidence as "high" | "lower" }));
    setLog((prev) => [
      ...prev,
      `${candidateResult.summary.totalCandidates} kandidaten (${candidateResult.summary.highConfidence} high, ${candidateResult.summary.lowerConfidence} lower, ${candidateResult.summary.rejected} afgewezen -- NIET opgeslagen). ${validated.length} worden opgeslagen.`,
    ]);

    setLog((prev) => [...prev, "Opslaan..."]);
    let saved = 0;
    for (let i = 0; i < validated.length; i += SAVE_CHUNK_SIZE) {
      const chunk = validated.slice(i, i + SAVE_CHUNK_SIZE);
      try {
        const params = new URLSearchParams();
        if (key) params.set("key", key);
        const res = await fetch(`/api/admin/save-nwb-connectors?${params.toString()}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nwbDatasetVersionId, datasetVersionId, connectors: chunk }),
        });
        const json = await res.json();
        if (!res.ok) {
          setLog((prev) => [...prev, `⚠️ Chunk ${i}: ${json.details ?? json.error}`]);
          setRunning(false);
          return;
        }
        saved += json.connectorsGeschreven;
        setLog((prev) => [...prev, `Opgeslagen: ${saved}/${validated.length}`]);
      } catch (err) {
        setLog((prev) => [...prev, `⚠️ Chunk ${i}: ${err instanceof Error ? err.message : String(err)}`]);
        setRunning(false);
        return;
      }
    }

    setSummary({ nwbDatasetVersionId, datasetVersionId, ...candidateResult.summary, opgeslagen: saved });
    setLog((prev) => [...prev, "✅ Klaar. /api/route/combined gebruikt deze connectoren nu automatisch."]);
    setRunning(false);
  }

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>NWB-connectoren genereren (productie)</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Fase G. Vereist een actieve NWB-dataset (eerst migreren + activeren). Slaat alleen niet-afgewezen connectoren op.
      </p>

      <input value={datasetVersionId} onChange={(e) => setDatasetVersionId(e.target.value)} placeholder="GoKnoop datasetVersionId" style={{ width: "100%", padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12 }} />

      <button onClick={run} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig... (kan even duren, landelijke schaal)" : "Genereer + sla connectoren op"}
      </button>

      {log.length > 0 && (
        <div style={{ fontSize: 11, background: "#f0f0eb", padding: 10, borderRadius: 8, marginBottom: 12, maxHeight: 250, overflowY: "auto" }}>
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}

      {summary && <pre style={{ fontSize: 11, background: "#f5f5f0", padding: 10, borderRadius: 8, whiteSpace: "pre-wrap" }}>{JSON.stringify(summary, null, 2)}</pre>}
    </div>
  );
}
