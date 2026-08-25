"use client";

import { useState, useRef } from "react";

/**
 * Admin-importpagina. Draait de import-lus in de browser (niet server-side),
 * zodat elke individuele API-aanroep klein genoeg blijft voor Vercel's
 * functietijdslimiet, terwijl de gebruiker niet handmatig hoeft te klikken
 * per pagina. Alleen voor eigen gebruik — niet gelinkt vanuit de publieke UI.
 */

type ImportKind = "nodes" | "edges";

type LogLine = { time: string; text: string; isError?: boolean };

export default function ImportAdminPage() {
  const [debugKey, setDebugKey] = useState("");
  const [datasetVersionId, setDatasetVersionId] = useState("");
  const [pageSize, setPageSize] = useState(100);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [running, setRunning] = useState<ImportKind | null>(null);
  const stopRef = useRef(false);

  function log(text: string, isError = false) {
    setLogs((prev) => [...prev, { time: new Date().toLocaleTimeString("nl-NL"), text, isError }]);
  }

  async function runImport(kind: ImportKind, startAt: number) {
    if (!debugKey) {
      log("Geef eerst de DEBUG_SECRET-sleutel op.", true);
      return;
    }
    stopRef.current = false;
    setRunning(kind);
    let currentStart = startAt;
    let currentDatasetVersionId = datasetVersionId;
    let attempt = 0;

    while (!stopRef.current) {
      const url = new URL(`/api/import/${kind}`, window.location.origin);
      url.searchParams.set("key", debugKey);
      url.searchParams.set("startIndex", String(currentStart));
      url.searchParams.set("pageSize", String(pageSize));
      if (currentDatasetVersionId) {
        url.searchParams.set("datasetVersionId", currentDatasetVersionId);
      }

      try {
        const res = await fetch(url.toString());
        const data = await res.json();

        if (!res.ok) {
          attempt++;
          log(`Fout bij startIndex=${currentStart}: ${data.error || res.status} (poging ${attempt}) — probeer opnieuw...`, true);
          if (attempt >= 5) {
            log("5 pogingen mislukt op rij, gestopt. Pas evt. de paginagrootte aan en hervat handmatig.", true);
            break;
          }
          await new Promise((r) => setTimeout(r, 2000));
          continue; // zelfde startIndex opnieuw proberen
        }

        attempt = 0;
        if (!currentDatasetVersionId && data.datasetVersionId) {
          currentDatasetVersionId = data.datasetVersionId;
          setDatasetVersionId(data.datasetVersionId);
        }

        log(
          `${kind}: ${data.newStartIndex} / ${data.numberMatched} (${((data.newStartIndex / data.numberMatched) * 100).toFixed(1)}%)`
        );

        if (data.done) {
          log(`Klaar — alle ${kind} geïmporteerd.`);
          break;
        }

        currentStart = data.newStartIndex;
      } catch (err) {
        attempt++;
        log(`Netwerkfout: ${err instanceof Error ? err.message : String(err)} (poging ${attempt})`, true);
        if (attempt >= 5) {
          log("5 pogingen mislukt op rij, gestopt.", true);
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    setRunning(null);
  }

  return (
    <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 600, margin: "0 auto" }}>
      <h1>GoKnoop — Import Admin</h1>
      <p style={{ color: "#666", fontSize: 14 }}>
        Draait de import-lus in de browser. Laat dit tabblad open staan tot &quot;Klaar&quot; verschijnt.
      </p>

      <div style={{ marginTop: "1rem" }}>
        <label style={{ display: "block", fontSize: 14, marginBottom: 4 }}>DEBUG_SECRET</label>
        <input
          type="password"
          value={debugKey}
          onChange={(e) => setDebugKey(e.target.value)}
          style={{ width: "100%", padding: 8, fontSize: 16 }}
        />
      </div>

      <div style={{ marginTop: "1rem" }}>
        <label style={{ display: "block", fontSize: 14, marginBottom: 4 }}>
          datasetVersionId (leeg = nieuwe aanmaken, alleen bij nodes-import)
        </label>
        <input
          type="text"
          value={datasetVersionId}
          onChange={(e) => setDatasetVersionId(e.target.value)}
          style={{ width: "100%", padding: 8, fontSize: 16 }}
        />
      </div>

      <div style={{ marginTop: "1rem" }}>
        <label style={{ display: "block", fontSize: 14, marginBottom: 4 }}>Paginagrootte</label>
        <input
          type="number"
          value={pageSize}
          onChange={(e) => setPageSize(parseInt(e.target.value, 10) || 100)}
          style={{ width: "100%", padding: 8, fontSize: 16 }}
        />
      </div>

      <div style={{ marginTop: "1.5rem", display: "flex", gap: 8 }}>
        <button
          disabled={running !== null}
          onClick={() => runImport("nodes", 0)}
          style={{ padding: "10px 16px", fontSize: 16 }}
        >
          Start nodes-import
        </button>
        <button
          disabled={running !== null || !datasetVersionId}
          onClick={() => runImport("edges", 0)}
          style={{ padding: "10px 16px", fontSize: 16 }}
        >
          Start edges-import
        </button>
        <button
          disabled={running === null}
          onClick={() => {
            stopRef.current = true;
          }}
          style={{ padding: "10px 16px", fontSize: 16 }}
        >
          Stop
        </button>
      </div>

      <div
        style={{
          marginTop: "1.5rem",
          background: "#111",
          color: "#0f0",
          padding: 12,
          fontFamily: "monospace",
          fontSize: 13,
          height: 400,
          overflowY: "auto",
          borderRadius: 6,
        }}
      >
        {logs.map((l, i) => (
          <div key={i} style={{ color: l.isError ? "#f66" : "#0f0" }}>
            [{l.time}] {l.text}
          </div>
        ))}
      </div>
    </main>
  );
}
