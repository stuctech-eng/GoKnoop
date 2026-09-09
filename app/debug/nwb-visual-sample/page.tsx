"use client";

import { useState } from "react";
import { generateConnectorCandidates, type GoKnoopNodeInput, type NwbSegmentInput, type CandidateGenerationResult, type ConnectorCandidate } from "@/lib/nwb-analysis/connector-candidates";
import { rdToWgs84 } from "@/lib/route-engine/coordinate-transform";

const REGIONS = [
  { key: "hilversum", label: "Amsterdam <-> Hilversum" },
  { key: "lochem", label: "Lochem / Achterhoek" },
  { key: "volendam", label: "Volendam / Edam / Purmerend" },
];

const SAMPLE_SIZES = { high: 10, lower: 5, rejected: 10 };

/**
 * Kiest `n` kandidaten, gelijkmatig verspreid door de lijst (niet gewoon de
 * eerste n) -- voorkomt dat de steekproef toevallig geclusterd is rond
 * hoe de array intern geordend is.
 */
function pickEvenlySpaced<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const picked: T[] = [];
  for (let i = 0; i < n; i++) picked.push(arr[Math.floor(i * step)]);
  return picked;
}

/**
 * Geometrisch VOOR-oordeel -- NADRUKKELIJK NIET hetzelfde als een visuele/
 * satelliet-bevestiging (die kan alleen Te zelf doen, via de kaart die
 * hieronder apart wordt aangeboden). Dit is puur wat uit hoek/afstand/
 * junction-degree is af te leiden, als startpunt voor de echte controle.
 */
function geometricPreAssessment(c: ConnectorCandidate): string {
  if (c.confidence === "rejected") {
    if (c.bearingAngleDeg !== null && c.bearingAngleDeg < 5) return "geometrisch: waarschijnlijk terecht afgewezen (correct systeemgedrag)";
    return "geometrisch: UNCERTAIN grensgeval -- hoek dicht bij de 15°-drempel, visueel controleren of dit toch een echte aansluiting is";
  }
  if (c.confidence === "lower") {
    return "geometrisch: UNCERTAIN (Set B -- fietsrijdbaarheid niet hard bevestigd, zie Fase 2-rapport, los van de geometrie hier)";
  }
  if (c.bearingAngleDeg !== null && c.bearingAngleDeg > 40 && c.nwbJunctionDegree >= 2) {
    return "geometrisch: plausibel (duidelijke hoek + echte kruising)";
  }
  return "geometrisch: UNCERTAIN (grenswaarde qua hoek en/of doodlopend eindpunt) -- visueel controleren";
}

type SampledCandidate = ConnectorCandidate & {
  region: string;
  goknoopWgs84: { lat: number; lon: number };
  nwbWgs84: { lat: number; lon: number };
  geometricAssessment: string;
};

function CopyAllButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button
      onClick={handleCopy}
      style={{ width: "100%", padding: 12, fontSize: 15, background: copied ? "#085041" : "#333", color: "white", border: "none", borderRadius: 8, marginBottom: 16 }}
    >
      {copied ? "Alles gekopieerd ✓" : "Kopieer ALLES (voor Claude)"}
    </button>
  );
}

export default function NwbVisualSamplePage() {
  const [datasetVersionId, setDatasetVersionId] = useState("uINZ3y2QsgBdEyky3duq");
  const [searchRadiusM, setSearchRadiusM] = useState("20");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [sample, setSample] = useState<SampledCandidate[]>([]);

  function getKey() {
    return window.localStorage.getItem("goknoop_debug_secret") || "";
  }

  async function runAll() {
    setRunning(true);
    setLog([]);
    setSample([]);
    const key = getKey();
    const fullSample: SampledCandidate[] = [];

    for (const region of REGIONS) {
      setLog((prev) => [...prev, `--- ${region.key}: starten ---`]);

      const segmentsById = new Map<string, NwbSegmentInput>();
      let offset = 0;
      for (;;) {
        try {
          const params = new URLSearchParams({ region: region.key, offset: String(offset) });
          if (key) params.set("key", key);
          const res = await fetch(`/api/debug/nwb-collector-read-tiles?${params.toString()}`, { cache: "no-store" });
          const json = await res.json();
          if (!res.ok) {
            setLog((prev) => [...prev, `⚠️ ${region.key}: ${json.details ?? json.error}`]);
            setRunning(false);
            return;
          }
          for (const seg of json.segments as NwbSegmentInput[]) segmentsById.set(seg.id, seg);
          if (json.done) break;
          offset += json.tilesInPage;
        } catch (err) {
          setLog((prev) => [...prev, `⚠️ ${region.key}: ${err instanceof Error ? err.message : String(err)}`]);
          setRunning(false);
          return;
        }
      }

      let goknoopNodes: GoKnoopNodeInput[] = [];
      try {
        const params = new URLSearchParams({ region: region.key, datasetVersionId });
        if (key) params.set("key", key);
        const res = await fetch(`/api/debug/nwb-collector-goknoop-bearings?${params.toString()}`, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok) {
          setLog((prev) => [...prev, `⚠️ ${region.key}: ${json.details ?? json.error}`]);
          setRunning(false);
          return;
        }
        goknoopNodes = json.nodes;
      } catch (err) {
        setLog((prev) => [...prev, `⚠️ ${region.key}: ${err instanceof Error ? err.message : String(err)}`]);
        setRunning(false);
        return;
      }

      await new Promise((r) => setTimeout(r, 30));
      const result: CandidateGenerationResult = generateConnectorCandidates(goknoopNodes, Array.from(segmentsById.values()), Number(searchRadiusM));

      const highs = pickEvenlySpaced(result.candidates.filter((c) => c.confidence === "high"), SAMPLE_SIZES.high);
      const lowers = pickEvenlySpaced(result.candidates.filter((c) => c.confidence === "lower"), SAMPLE_SIZES.lower);
      const rejecteds = pickEvenlySpaced(result.candidates.filter((c) => c.confidence === "rejected"), SAMPLE_SIZES.rejected);

      for (const c of [...highs, ...lowers, ...rejecteds]) {
        fullSample.push({
          ...c,
          region: region.key,
          goknoopWgs84: rdToWgs84(c.goknoopCoords.x, c.goknoopCoords.y),
          nwbWgs84: rdToWgs84(c.nwbCoords.x, c.nwbCoords.y),
          geometricAssessment: geometricPreAssessment(c),
        });
      }

      setLog((prev) => [...prev, `✅ ${region.key}: steekproef van ${highs.length + lowers.length + rejecteds.length} kandidaten gekozen uit ${result.summary.totalCandidates} totaal.`]);
    }

    setSample(fullSample);
    setLog((prev) => [...prev, `Klaar. ${fullSample.length} kandidaten totaal in de steekproef.`]);
    setRunning(false);
  }

  const copyText = JSON.stringify(
    sample.map((c) => ({
      region: c.region,
      confidence: c.confidence,
      goknoopNodeId: c.goknoopNodeId,
      goknoopWgs84: c.goknoopWgs84,
      nwbSegmentId: c.nwbSegmentId,
      nwbBstCode: c.nwbBstCode,
      nwbWgs84: c.nwbWgs84,
      distanceM: Math.round(c.distanceM * 10) / 10,
      bearingAngleDeg: c.bearingAngleDeg !== null ? Math.round(c.bearingAngleDeg * 10) / 10 : null,
      nwbJunctionDegree: c.nwbJunctionDegree,
      rejectionReason: c.rejectionReason,
      geometricAssessment: c.geometricAssessment,
    })),
    null,
    2
  );

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Visuele-validatiesteekproef</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        10 HIGH + 5 LOWER + 10 afgewezen per regio (30 per regio, 90 totaal), gelijkmatig verspreid uit de volledige lijst. Coördinaten in WGS84, plus een geometrisch (nog niet visueel) voor-oordeel.
      </p>

      <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
        <input value={datasetVersionId} onChange={(e) => setDatasetVersionId(e.target.value)} placeholder="datasetVersionId" style={{ padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8 }} />
        <input value={searchRadiusM} onChange={(e) => setSearchRadiusM(e.target.value)} placeholder="zoekstraal (m)" style={{ padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8 }} />
      </div>

      <button onClick={runAll} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig..." : "Genereer steekproef (alle 3 regio's)"}
      </button>

      {log.length > 0 && (
        <div style={{ fontSize: 11, background: "#f0f0eb", padding: 10, borderRadius: 8, marginBottom: 12, maxHeight: 150, overflowY: "auto" }}>
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}

      {sample.length > 0 && (
        <>
          <CopyAllButton text={copyText} />
          <pre style={{ fontSize: 9, background: "#f5f5f0", padding: 8, borderRadius: 6, overflowX: "auto", whiteSpace: "pre-wrap" }}>{copyText}</pre>
        </>
      )}
    </div>
  );
}
