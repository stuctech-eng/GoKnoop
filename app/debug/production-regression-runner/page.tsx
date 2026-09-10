"use client";

import { useState } from "react";

const TEST_PAIRS = [
  { naam: "Amsterdam Centraal -> Hilversum kn55 (bekende 366,9km-omweg)", from: "CJSXBPUMG49vOPmYvhJd", to: "ZYuO6ZfzSa2iim0HcUbn" },
  { naam: "Volendam kn95 -> Amsterdam Centraal (bekende gezonde route)", from: "7fmSWIHYsKu3Wb3yOtM2", to: "CJSXBPUMG49vOPmYvhJd" },
  { naam: "337km-anomalie zelf (v1: moet AFGEWEZEN worden door validatie)", from: "3Sx24AWzdYTR4Psx0JJW", to: "AG9myGNbdE6eH0W2SUmi" },
  { naam: "337km-anomalie (v7: tweede bekende geval, moet ook afgewezen)", from: "AG9myGNbdE6eH0W2SUmi", to: "nKfPyXuKA5e2SMxiKON3" },
  { naam: "Lochem l1 (normale, gezonde route)", from: "0pgYw2kgDphP2IT1RAi7", to: "61aNR7RWLxQhHTOfMHtm" },
  { naam: "Lochem l3 (normale, gezonde route)", from: "CDdOFbRpdb959FzzPLc0", to: "WDsLzusuMQzU8aBk43mq" },
];

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
    <button onClick={handleCopy} style={{ width: "100%", padding: 12, fontSize: 15, background: copied ? "#085041" : "#333", color: "white", border: "none", borderRadius: 8, marginBottom: 16 }}>
      {copied ? "Alles gekopieerd ✓" : "Kopieer ALLES (voor Claude)"}
    </button>
  );
}

export default function ProductionRegressionRunnerPage() {
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [results, setResults] = useState<Record<string, unknown> | null>(null);

  async function run() {
    setRunning(true);
    setLog([]);
    setResults(null);

    const allResults: Record<string, unknown> = {};

    for (const pair of TEST_PAIRS) {
      setLog((prev) => [...prev, `--- ${pair.naam} ---`]);
      try {
        const res = await fetch(`/api/route/combined`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fromLogicalNodeId: pair.from, toLogicalNodeId: pair.to }),
        });
        const json = await res.json();
        allResults[pair.naam] = { httpStatus: res.status, respons: json };
        if (res.ok) {
          setLog((prev) => [...prev, `✅ Route geaccepteerd: ${json.distanceM}m (deviationFactor ${json.quality?.deviationFactor}), NWB-actief: ${json.nwbActief}`]);
        } else {
          setLog((prev) => [...prev, `${json.reason === "quality_rejected" ? "🛑 AFGEWEZEN (verwacht bij anomalie)" : "⚠️"}: HTTP ${res.status} -- ${json.error}`]);
        }
      } catch (err) {
        allResults[pair.naam] = { error: err instanceof Error ? err.message : String(err) };
        setLog((prev) => [...prev, `⚠️ ${err instanceof Error ? err.message : String(err)}`]);
      }
    }

    setResults(allResults);
    setLog((prev) => [...prev, "Alle testgevallen klaar."]);
    setRunning(false);
  }

  const copyText = results ? JSON.stringify(results, null, 2) : "";

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Fase J — Productieregressies</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Draait de bekende testgevallen via het ECHTE, live /api/route/combined -- inclusief de 337km-anomalie zelf, om te bevestigen dat de validatielaag die in productie daadwerkelijk afwijst.
      </p>

      <button onClick={run} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig..." : "Start productieregressies"}
      </button>

      {log.length > 0 && (
        <div style={{ fontSize: 11, background: "#f0f0eb", padding: 10, borderRadius: 8, marginBottom: 12, maxHeight: 250, overflowY: "auto" }}>
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}

      {results && (
        <>
          <CopyAllButton text={copyText} />
          <pre style={{ fontSize: 9, background: "#f5f5f0", padding: 8, borderRadius: 6, overflowX: "auto", whiteSpace: "pre-wrap" }}>{copyText}</pre>
        </>
      )}
    </div>
  );
}
