"use client";

import { useState } from "react";

// Amsterdam Centraal-omgeving als herkomst-kandidaten, Hilversum-omgeving als bestemming.
const ORIGIN_CANDIDATES = ["CJSXBPUMG49vOPmYvhJd", "MQAnNb1IMego7dnVPXpS"];
const DESTINATION_CANDIDATES = ["ZYuO6ZfzSa2iim0HcUbn"];
// Hilversum, ongeveer knooppunt 55's locatie (WGS84).
const DESTINATION_LAT = 52.2292;
const DESTINATION_LON = 5.1669;

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

export default function TestToDestinationLivePage() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  async function run() {
    setRunning(true);
    setResult(null);
    setElapsedMs(null);
    const t0 = Date.now();

    try {
      const res = await fetch("/api/route/to-destination", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originCandidateNodeIds: ORIGIN_CANDIDATES,
          destinationCandidateNodeIds: DESTINATION_CANDIDATES,
          destinationLat: DESTINATION_LAT,
          destinationLon: DESTINATION_LON,
        }),
      });
      const elapsed = Date.now() - t0;
      setElapsedMs(elapsed);
      const json = await res.json();
      setResult({ httpStatus: res.status, elapsedMs: elapsed, respons: json });
    } catch (err) {
      const elapsed = Date.now() - t0;
      setElapsedMs(elapsed);
      setResult({ elapsedMs: elapsed, fetchError: err instanceof Error ? err.message : String(err) });
    }
    setRunning(false);
  }

  const copyText = result ? JSON.stringify(result, null, 2) : "";

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Live test: /api/route/to-destination</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Roept het ECHTE productie-eindpunt aan met bekende, echte knooppunt-ID's (omzeilt adresgeocodering) -- reproduceert de fout die net in de app optrad, met de exacte foutmelding en timing.
      </p>

      <button onClick={run} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig... (kan tot 10s duren, of langer falen)" : "Test nu"}
      </button>

      {elapsedMs !== null && <p style={{ fontSize: 13, marginBottom: 8 }}>Verstreken tijd: <strong>{elapsedMs}ms</strong></p>}

      {result && (
        <>
          <CopyAllButton text={copyText} />
          <pre style={{ fontSize: 10, background: "#f5f5f0", padding: 8, borderRadius: 6, overflowX: "auto", whiteSpace: "pre-wrap" }}>{copyText}</pre>
        </>
      )}
    </div>
  );
}
