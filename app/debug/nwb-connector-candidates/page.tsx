"use client";

import { useState } from "react";
import { generateConnectorCandidates, type GoKnoopNodeInput, type NwbSegmentInput, type CandidateGenerationResult } from "@/lib/nwb-analysis/connector-candidates";

const REGIONS = [
  { key: "hilversum", label: "Amsterdam <-> Hilversum" },
  { key: "lochem", label: "Lochem / Achterhoek" },
  { key: "volendam", label: "Volendam / Edam / Purmerend" },
];

/** Herbruikbare kopieerknop -- belangrijk op mobiel, waar tekst handmatig selecteren in een <pre>-blok onhandig is. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button
      onClick={handleCopy}
      style={{ fontSize: 11, padding: "4px 10px", background: copied ? "#085041" : "#ddd", color: copied ? "white" : "#333", border: "none", borderRadius: 6, marginBottom: 4 }}
    >
      {copied ? "Gekopieerd ✓" : "Kopieer"}
    </button>
  );
}

export default function NwbConnectorCandidatesPage() {
  const [datasetVersionId, setDatasetVersionId] = useState("uINZ3y2QsgBdEyky3duq");
  const [searchRadiusM, setSearchRadiusM] = useState("20");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [results, setResults] = useState<Record<string, CandidateGenerationResult>>({});

  function getKey() {
    return window.localStorage.getItem("goknoop_debug_secret") || "";
  }

  async function runRegion(regionKey: string) {
    setRunning(true);
    setLog((prev) => [...prev, `--- ${regionKey}: starten ---`]);
    const key = getKey();

    // Stap 1: alle NWB-tegels gepagineerd inlezen (zelfde bewezen patroon als eerder).
    const segmentsById = new Map<string, NwbSegmentInput>();
    let offset = 0;
    for (;;) {
      try {
        const params = new URLSearchParams({ region: regionKey, offset: String(offset) });
        if (key) params.set("key", key);
        const res = await fetch(`/api/debug/nwb-collector-read-tiles?${params.toString()}`, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok) {
          setLog((prev) => [...prev, `⚠️ ${regionKey}: tegels lezen mislukt: ${json.details ?? json.error}`]);
          setRunning(false);
          return;
        }
        for (const seg of json.segments as NwbSegmentInput[]) segmentsById.set(seg.id, seg);
        if (json.done) break;
        offset += json.tilesInPage;
      } catch (err) {
        setLog((prev) => [...prev, `⚠️ ${regionKey}: ${err instanceof Error ? err.message : String(err)}`]);
        setRunning(false);
        return;
      }
    }
    setLog((prev) => [...prev, `${regionKey}: ${segmentsById.size} NWB-segmenten gelezen.`]);

    // Stap 2: GoKnoop-knopen MET richtingsvectoren ophalen.
    let goknoopNodes: GoKnoopNodeInput[] = [];
    try {
      const params = new URLSearchParams({ region: regionKey, datasetVersionId });
      if (key) params.set("key", key);
      const res = await fetch(`/api/debug/nwb-collector-goknoop-bearings?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setLog((prev) => [...prev, `⚠️ ${regionKey}: GoKnoop-richtingen ophalen mislukt: ${json.details ?? json.error}`]);
        setRunning(false);
        return;
      }
      goknoopNodes = json.nodes;
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ ${regionKey}: ${err instanceof Error ? err.message : String(err)}`]);
      setRunning(false);
      return;
    }
    setLog((prev) => [...prev, `${regionKey}: ${goknoopNodes.length} GoKnoop-knopen met richtingen opgehaald. Kandidaten genereren...`]);

    // Stap 3: kandidaten genereren, client-side (geen serverless-tijdslimiet).
    await new Promise((r) => setTimeout(r, 30));
    const result = generateConnectorCandidates(goknoopNodes, Array.from(segmentsById.values()), Number(searchRadiusM));
    setResults((prev) => ({ ...prev, [regionKey]: result }));
    setLog((prev) => [
      ...prev,
      `✅ ${regionKey}: ${result.summary.totalCandidates} kandidaten (${result.summary.highConfidence} high, ${result.summary.lowerConfidence} lower, ${result.summary.rejected} afgewezen).`,
    ]);
    setRunning(false);
  }

  async function runAll() {
    setLog([]);
    setResults({});
    for (const r of REGIONS) {
      await runRegion(r.key);
    }
  }

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Fase 3 — Connectorkandidaten</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Tijdelijke onderzoeksinfrastructuur. Genereert connector-kandidaten uit de al-verzamelde NWB-data + echte GoKnoop-richtingen. Geen productie-integratie.
      </p>

      <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
        <input value={datasetVersionId} onChange={(e) => setDatasetVersionId(e.target.value)} placeholder="datasetVersionId" style={{ padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8 }} />
        <input value={searchRadiusM} onChange={(e) => setSearchRadiusM(e.target.value)} placeholder="zoekstraal (m) -- geen drempel, alleen zoekgebied" style={{ padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8 }} />
      </div>

      <button onClick={runAll} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 16 }}>
        {running ? "Bezig..." : "Draai alle drie regio's"}
      </button>

      {log.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <CopyButton text={log.join("\n")} />
          </div>
          <div style={{ fontSize: 11, background: "#f0f0eb", padding: 10, borderRadius: 8, maxHeight: 200, overflowY: "auto" }}>
            {log.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </div>
      )}

      {Object.entries(results).map(([regionKey, result]) => (
        <div key={regionKey} style={{ marginBottom: 20, border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <h2 style={{ fontSize: 16 }}>{regionKey}</h2>
            <CopyButton text={JSON.stringify(result, null, 2)} />
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, fontWeight: "bold" }}>Samenvatting</span>
            <CopyButton text={JSON.stringify(result.summary, null, 2)} />
          </div>
          <pre style={{ fontSize: 11, background: "#f5f5f0", padding: 8, borderRadius: 6, marginBottom: 8 }}>{JSON.stringify(result.summary, null, 2)}</pre>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, fontWeight: "bold" }}>Voorbeelden -- high confidence</span>
            <CopyButton text={JSON.stringify(result.candidates.filter((c) => c.confidence === "high").slice(0, 3), null, 2)} />
          </div>
          <pre style={{ fontSize: 10, background: "#eef7ee", padding: 8, borderRadius: 6, marginBottom: 8, overflowX: "auto" }}>
            {JSON.stringify(result.candidates.filter((c) => c.confidence === "high").slice(0, 3), null, 2)}
          </pre>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, fontWeight: "bold" }}>Voorbeelden -- afgewezen (met reden)</span>
            <CopyButton text={JSON.stringify(result.candidates.filter((c) => c.confidence === "rejected").slice(0, 3), null, 2)} />
          </div>
          <pre style={{ fontSize: 10, background: "#fdf0f0", padding: 8, borderRadius: 6, overflowX: "auto" }}>
            {JSON.stringify(result.candidates.filter((c) => c.confidence === "rejected").slice(0, 3), null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}
