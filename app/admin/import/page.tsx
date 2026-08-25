"use client";

import { useState, useRef } from "react";

/**
 * Admin-importpagina. Draait de import-lus in de browser (niet server-side),
 * zodat elke individuele API-aanroep klein genoeg blijft voor Vercel's
 * functietijdslimiet, terwijl de gebruiker niet handmatig hoeft te klikken
 * per pagina. Alleen voor eigen gebruik — niet gelinkt vanuit de publieke UI.
 *
 * Screen Wake Lock: voorkomt dat iOS Safari de pagina op de achtergrond zet
 * (en JS pauzeert) wanneer het scherm zou vergrendelen tijdens een lange import.
 */

type ImportKind = "nodes" | "edges";

type LogLine = { time: string; text: string; isError?: boolean };

export default function ImportAdminPage() {
  const [debugKey, setDebugKey] = useState("");
  const [datasetVersionId, setDatasetVersionId] = useState("");
  const [pageSize, setPageSize] = useState(10);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [running, setRunning] = useState<ImportKind | null>(null);
  const [progress, setProgress] = useState<Record<ImportKind, number>>({ nodes: 0, edges: 0 });
  const stopRef = useRef(false);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);

  function log(text: string, isError = false) {
    setLogs((prev) => [...prev, { time: new Date().toLocaleTimeString("nl-NL"), text, isError }]);
  }

  async function acquireWakeLock() {
    try {
      if ("wakeLock" in navigator) {
        wakeLockRef.current = await (navigator as unknown as {
          wakeLock: { request: (type: "screen") => Promise<WakeLockSentinel> };
        }).wakeLock.request("screen");
        log("Scherm-wakelock actief — telefoon vergrendelt niet vanzelf tijdens de import.");
      } else {
        log("Wake Lock API niet ondersteund in deze browser — houd het scherm handmatig actief (niet vergrendelen).", true);
      }
    } catch (err) {
      log(
        `Kon wake lock niet activeren: ${err instanceof Error ? err.message : String(err)} — houd het scherm handmatig actief.`,
        true
      );
    }
  }

  function releaseWakeLock() {
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
  }

  async function runImport(kind: ImportKind, startAt: number) {
    if (!debugKey) {
      log("Geef eerst de DEBUG_SECRET-sleutel op.", true);
      return;
    }
    stopRef.current = false;
    setRunning(kind);
    await acquireWakeLock();

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
        const rawText = await res.text();

        let data: {
          error?: string;
          datasetVersionId?: string;
          newStartIndex?: number;
          numberMatched?: number;
          done?: boolean;
        };
        try {
          data = JSON.parse(rawText);
        } catch {
          attempt++;
          log(
            `Server gaf geen geldige JSON terug (status ${res.status}): ${rawText.slice(0, 200)} (poging ${attempt})`,
            true
          );
          if (attempt >= 10) {
            log("5 pogingen mislukt op rij, gestopt. Tik nogmaals op start om te hervatten vanaf het laatste punt.", true);
            break;
          }
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        if (!res.ok) {
          attempt++;
          const errorDetail = [data.error, (data as { details?: string }).details].filter(Boolean).join(" — ");
          log(`Fout bij startIndex=${currentStart}: ${errorDetail || res.status} (poging ${attempt}) — probeer opnieuw...`, true);
          if (attempt >= 10) {
            log("5 pogingen mislukt op rij, gestopt. Pas evt. de paginagrootte aan en tik nogmaals op start om te hervatten.", true);
            break;
          }
          await new Promise((r) => setTimeout(r, 5000));
          continue; // zelfde startIndex opnieuw proberen
        }

        attempt = 0;
        if (!currentDatasetVersionId && data.datasetVersionId) {
          currentDatasetVersionId = data.datasetVersionId;
          setDatasetVersionId(data.datasetVersionId);
        }

        log(
          `${kind}: ${data.newStartIndex} / ${data.numberMatched} (${(((data.newStartIndex ?? 0) / (data.numberMatched ?? 1)) * 100).toFixed(1)}%)`
        );

        if (typeof data.newStartIndex === "number") {
          setProgress((prev) => ({ ...prev, [kind]: data.newStartIndex as number }));
        }

        if (data.done) {
          log(`Klaar — alle ${kind} geïmporteerd.`);
          break;
        }

        currentStart = data.newStartIndex ?? currentStart;
        await new Promise((r) => setTimeout(r, 400)); // korte pauze tussen pagina's, uit respect voor Routedatabank
      } catch (err) {
        attempt++;
        log(`Onverwachte fout: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)} (poging ${attempt})`, true);
        if (attempt >= 10) {
          log("5 pogingen mislukt op rij, gestopt. Tik nogmaals op start om te hervatten vanaf het laatste punt.", true);
          break;
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    releaseWakeLock();
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
          onClick={() => runImport("nodes", progress.nodes)}
          style={{ padding: "10px 16px", fontSize: 16 }}
        >
          {progress.nodes > 0 ? `Hervat nodes (vanaf ${progress.nodes})` : "Start nodes-import"}
        </button>
        <button
          disabled={running !== null || !datasetVersionId}
          onClick={() => runImport("edges", progress.edges)}
          style={{ padding: "10px 16px", fontSize: 16 }}
        >
          {progress.edges > 0 ? `Hervat edges (vanaf ${progress.edges})` : "Start edges-import"}
        </button>
        <button
          disabled={running === null}
          onClick={() => {
            stopRef.current = true;
            releaseWakeLock();
          }}
          style={{ padding: "10px 16px", fontSize: 16 }}
        >
          Stop
        </button>
      </div>

      <p style={{ fontSize: 13, color: "#666", marginTop: 8 }}>
        Belangrijk: laat het scherm actief (niet vergrendelen, niet van app wisselen) — de wake lock helpt, maar is geen garantie op elk toestel.
      </p>

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
