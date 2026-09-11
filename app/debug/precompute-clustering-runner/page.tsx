"use client";

import { useState } from "react";

const WRITE_CHUNK_SIZE = 2000; // consistent met migrate-nwb-runner.tsx -- zelfde reden

type CompactAssignment = { f: string; t: string };
type SlimNwbSegment = { id: string; [key: string]: unknown };

export default function PrecomputeClusteringRunnerPage() {
  const [nwbDatasetVersionId, setNwbDatasetVersionId] = useState("nwb-2026-09-10-v2-gebatcht");
  const [key, setKey] = useState(() => (typeof window !== "undefined" ? window.localStorage.getItem("goknoop_debug_secret") || "" : ""));
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  async function run() {
    setRunning(true);
    setLog([]);
    try {
      // STAP 1: clustering berekenen (aparte, kleine aanvraag -- alleen lezen + clusteren).
      setLog((prev) => [...prev, "Stap 1/3: clustering berekenen..."]);
      const params = new URLSearchParams();
      if (key) params.set("key", key);
      const computeRes = await fetch(`/api/admin/precompute-nwb-clustering?${params.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nwbDatasetVersionId }),
      });
      const computeJson = await computeRes.json();
      if (!computeRes.ok) {
        setLog((prev) => [...prev, `⚠️ ${computeJson.details ?? computeJson.error}`]);
        setRunning(false);
        return;
      }
      const assignments: Record<string, CompactAssignment> = computeJson.assignments;
      setLog((prev) => [...prev, `Klaar: ${computeJson.aantalClusterToewijzingen} clustertoewijzingen berekend (${computeJson.timings.clusteringKlaar ?? "?"}ms).`]);

      // STAP 2: originele segmenten ophalen (al-bestaand, bewezen snel eindpunt).
      setLog((prev) => [...prev, "Stap 2/3: originele segmenten ophalen..."]);
      const segRes = await fetch(`/api/admin/read-active-nwb-segments?${params.toString()}`, { cache: "no-store" });
      const segJson = await segRes.json();
      if (!segRes.ok) {
        setLog((prev) => [...prev, `⚠️ ${segJson.details ?? segJson.error}`]);
        setRunning(false);
        return;
      }
      const originalSegments: SlimNwbSegment[] = segJson.segments;
      setLog((prev) => [...prev, `Klaar: ${originalSegments.length} segmenten opgehaald.`]);

      // STAP 3: samenvoegen en terugschrijven via de bestaande migratie-schrijflogica.
      setLog((prev) => [...prev, "Stap 3/3: samenvoegen en terugschrijven..."]);
      const merged = originalSegments.map((s) => {
        const a = assignments[s.id];
        return a ? { ...s, fromClusterId: a.f, toClusterId: a.t } : s;
      });

      for (let i = 0; i < merged.length; i += WRITE_CHUNK_SIZE) {
        const chunk = merged.slice(i, i + WRITE_CHUNK_SIZE);
        const batchIndex = i / WRITE_CHUNK_SIZE;
        const writeRes = await fetch(`/api/admin/migrate-nwb-to-production?${params.toString()}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nwbDatasetVersionId, segments: chunk, batchIndex, isFirstChunk: false }),
        });
        const writeJson = await writeRes.json();
        if (!writeRes.ok) {
          setLog((prev) => [...prev, `⚠️ batch ${batchIndex}: ${writeJson.details ?? writeJson.error}`]);
          setRunning(false);
          return;
        }
        setLog((prev) => [...prev, `batch ${batchIndex} teruggeschreven (${chunk.length} segmenten, nu met cluster-ID's).`]);
      }

      setLog((prev) => [...prev, "✅ Volledig klaar. Een koude serverstart hoeft nu niet meer te clusteren."]);
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ ${err instanceof Error ? err.message : String(err)}`]);
    }
    setRunning(false);
  }

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>NWB-clustering vooraf berekenen</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Fase M6/M7, structurele fix. Drie stappen: (1) clustering berekenen, (2) originele segmenten ophalen, (3) samenvoegen + terugschrijven via de
        bestaande migratie-schrijflogica. Elke stap is een aparte aanvraag -- lezen + clusteren + terugschrijven paste niet in één enkele aanvraag
        (live gemeten: samen ruim boven de 10s-limiet).
      </p>

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
        {running ? "Bezig..." : "Bereken clustering vooraf"}
      </button>

      <pre style={{ fontSize: 11, background: "#f5f5f0", padding: 8, borderRadius: 6, maxHeight: 400, overflowY: "auto", whiteSpace: "pre-wrap" }}>
        {log.join("\n")}
      </pre>
    </div>
  );
}
