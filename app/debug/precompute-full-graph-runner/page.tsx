"use client";

import { useState } from "react";

export default function PrecomputeFullGraphRunnerPage() {
  const [datasetVersionId, setDatasetVersionId] = useState("uINZ3y2QsgBdEyky3duq");
  const [nwbDatasetVersionId, setNwbDatasetVersionId] = useState("nwb-2026-09-11-v2-gebatcht");
  const [key, setKey] = useState(() => (typeof window !== "undefined" ? window.localStorage.getItem("goknoop_debug_secret") || "" : ""));
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  async function run() {
    setRunning(true);
    setLog([]);
    try {
      const params = new URLSearchParams();
      if (key) params.set("key", key);

      let compleet = false;
      let round = 0;
      while (!compleet && round < 30) {
        round++;
        setLog((prev) => [...prev, `Ronde ${round}: aanroepen...`]);
        const res = await fetch(`/api/admin/precompute-full-graph-v2?${params.toString()}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ datasetVersionId, nwbDatasetVersionId }),
        });
        const json = await res.json();
        if (!res.ok) {
          setLog((prev) => [...prev, `⚠️ ${json.details ?? json.error}`]);
          setRunning(false);
          return;
        }
        compleet = json.compleet;
        setLog((prev) => [
          ...prev,
          `Ronde ${round}: adjacency ${json.voortgang.adjDoneNow}/${json.voortgang.adjTotaal}, nodePosition ${json.voortgang.posDoneNow}/${json.voortgang.posTotaal} (${json.elapsedMs}ms, +${json.nieuwGeschrevenDezeAanroep.adjacency + json.nieuwGeschrevenDezeAanroep.nodePosition} chunks deze ronde)`,
        ]);
      }

      if (compleet) setLog((prev) => [...prev, "✅ Volledig klaar. Het artefact is nu compleet en klaar voor gebruik."]);
      else setLog((prev) => [...prev, "⚠️ Nog niet compleet na 30 rondes -- iets loopt mogelijk vast, controleer read-progress."]);
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ ${err instanceof Error ? err.message : String(err)}`]);
    }
    setRunning(false);
  }

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Volledige graaf precomputen (optie C)</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Roept /api/admin/precompute-full-graph-v2 herhaald aan tot het artefact compleet is. Elke ronde leest en bouwt de graaf
        opnieuw (onvermijdelijk, geen geheugen tussen aparte serverless-aanroepen) maar schrijft alleen de nog ontbrekende chunks.
      </p>

      <input
        type="text"
        value={datasetVersionId}
        onChange={(e) => setDatasetVersionId(e.target.value)}
        placeholder="datasetVersionId (GoKnoop)"
        style={{ width: "100%", padding: 10, fontSize: 14, border: "1px solid #ccc", borderRadius: 8, marginBottom: 8 }}
      />
      <input
        type="text"
        value={nwbDatasetVersionId}
        onChange={(e) => setNwbDatasetVersionId(e.target.value)}
        placeholder="nwbDatasetVersionId"
        style={{ width: "100%", padding: 10, fontSize: 14, border: "1px solid #ccc", borderRadius: 8, marginBottom: 8 }}
      />
      <input
        type="text"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="DEBUG_SECRET"
        style={{ width: "100%", padding: 10, fontSize: 14, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12 }}
      />

      <button onClick={run} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig..." : "Precompute starten"}
      </button>

      <pre style={{ fontSize: 11, background: "#f5f5f0", padding: 8, borderRadius: 6, maxHeight: 500, overflowY: "auto", whiteSpace: "pre-wrap" }}>
        {log.join("\n")}
      </pre>
    </div>
  );
}
