"use client";

import { useState, useRef, useEffect } from "react";

/**
 * Admin-importpagina. Draait de import-lus in de browser (niet server-side),
 * zodat elke individuele API-aanroep klein genoeg blijft voor Vercel's
 * functietijdslimiet, terwijl de gebruiker niet handmatig hoeft te klikken
 * per pagina. Alleen voor eigen gebruik — niet gelinkt vanuit de publieke UI.
 *
 * Screen Wake Lock: voorkomt dat iOS Safari de pagina op de achtergrond zet
 * (en JS pauzeert) wanneer het scherm zou vergrendelen tijdens een lange import.
 *
 * Velden worden bewaard in localStorage (alleen op dit toestel, niet in de
 * broncode) zodat een herlading niet steeds opnieuw invullen vereist.
 */

const STORAGE_KEY = "goknoop-import-admin";

type ImportKind = "nodes" | "edges";
type RunningKind = ImportKind | "cluster";

type LogLine = { time: string; text: string; isError?: boolean };

export default function ImportAdminPage() {
  const [debugKey, setDebugKey] = useState("");
  const [datasetVersionId, setDatasetVersionId] = useState("");
  const [pageSize, setPageSize] = useState(10);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [running, setRunning] = useState<RunningKind | null>(null);
  const [progress, setProgress] = useState<Record<ImportKind, number>>({ nodes: 0, edges: 0 });
  const stopRef = useRef(false);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);

  // Bij het laden: eerder opgeslagen waarden terugzetten (alleen dit toestel).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.debugKey) setDebugKey(parsed.debugKey);
        if (parsed.datasetVersionId) setDatasetVersionId(parsed.datasetVersionId);
        if (parsed.pageSize) setPageSize(parsed.pageSize);
        if (parsed.progress) setProgress(parsed.progress);
      }
    } catch {
      // localStorage niet beschikbaar of corrupte data — gewoon leeg beginnen.
    }
  }, []);

  // Bij elke wijziging: opslaan.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ debugKey, datasetVersionId, pageSize, progress }));
    } catch {
      // storage vol of niet beschikbaar — negeren, niet kritiek.
    }
  }, [debugKey, datasetVersionId, pageSize, progress]);

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

  async function runClusterNodes() {
    if (!debugKey || !datasetVersionId) {
      log("Geef eerst de sleutel en datasetVersionId op.", true);
      return;
    }
    stopRef.current = false;
    setRunning("cluster");
    await acquireWakeLock();

    // Fase 1: compute (één keer, resultaat wordt server-side gecachet)
    log("Berekeningsfase gestart — dit kan even duren...");
    try {
      const computeUrl = new URL("/api/import/cluster-nodes", window.location.origin);
      computeUrl.searchParams.set("key", debugKey);
      computeUrl.searchParams.set("datasetVersionId", datasetVersionId);
      computeUrl.searchParams.set("phase", "compute");

      const res = await fetch(computeUrl.toString());
      const rawText = await res.text();
      let data: {
        error?: string;
        details?: string;
        totalLogicalNodes?: number;
        timingMs?: { read: number; cluster: number; cacheWrite: number; total: number };
      };
      try {
        data = JSON.parse(rawText);
      } catch {
        log(`Berekeningsfase gaf geen geldige JSON (status ${res.status}): ${rawText.slice(0, 300)}`, true);
        releaseWakeLock();
        setRunning(null);
        return;
      }

      if (!res.ok) {
        log(`Berekeningsfase mislukt: ${[data.error, data.details].filter(Boolean).join(" — ")}`, true);
        releaseWakeLock();
        setRunning(null);
        return;
      }

      log(
        `Berekening klaar: ${data.totalLogicalNodes} logical nodes bepaald (read ${data.timingMs?.read}ms, cluster ${data.timingMs?.cluster}ms, cache-write ${data.timingMs?.cacheWrite}ms, totaal ${data.timingMs?.total}ms).`
      );
    } catch (err) {
      log(`Berekeningsfase — onverwachte fout: ${err instanceof Error ? err.message : String(err)}`, true);
      releaseWakeLock();
      setRunning(null);
      return;
    }

    // Fase 2: gepagineerd wegschrijven vanuit de cache
    let writeOffset = 0;
    let attempt = 0;
    const totals = { merged: 0, single: 0, exceptionReview: 0 };

    while (!stopRef.current) {
      const url = new URL("/api/import/cluster-nodes", window.location.origin);
      url.searchParams.set("key", debugKey);
      url.searchParams.set("datasetVersionId", datasetVersionId);
      url.searchParams.set("phase", "write");
      url.searchParams.set("writeOffset", String(writeOffset));

      try {
        const res = await fetch(url.toString());
        const rawText = await res.text();
        let data: {
          error?: string;
          details?: string;
          newWriteOffset?: number;
          totalLogicalNodes?: number;
          done?: boolean;
          sliceSummary?: { merged: number; single: number; exceptionReview: number };
        };
        try {
          data = JSON.parse(rawText);
        } catch {
          attempt++;
          log(`Server gaf geen geldige JSON terug (status ${res.status}): ${rawText.slice(0, 200)} (poging ${attempt})`, true);
          if (attempt >= 10) {
            log("Gestopt na 10 mislukte pogingen. Tik nogmaals op start om te hervatten.", true);
            break;
          }
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        if (!res.ok) {
          attempt++;
          log(`Fout: ${[data.error, data.details].filter(Boolean).join(" — ")} (poging ${attempt})`, true);
          if (attempt >= 10) {
            log("Gestopt na 10 mislukte pogingen.", true);
            break;
          }
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        attempt = 0;
        if (data.sliceSummary) {
          totals.merged += data.sliceSummary.merged;
          totals.single += data.sliceSummary.single;
          totals.exceptionReview += data.sliceSummary.exceptionReview;
        }
        log(`schrijven: ${data.newWriteOffset} / ${data.totalLogicalNodes} logical nodes`);

        if (data.done) {
          log(`Klaar — samengevoegd: ${totals.merged}, los: ${totals.single}, ter review: ${totals.exceptionReview}.`);
          break;
        }

        writeOffset = data.newWriteOffset ?? writeOffset;
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        attempt++;
        log(`Onverwachte fout: ${err instanceof Error ? err.message : String(err)} (poging ${attempt})`, true);
        if (attempt >= 10) {
          log("Gestopt na 10 mislukte pogingen.", true);
          break;
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    releaseWakeLock();
    setRunning(null);
  }

  async function runMatchEdges() {
    if (!debugKey || !datasetVersionId) {
      log("Geef eerst de sleutel en datasetVersionId op.", true);
      return;
    }
    stopRef.current = false;
    setRunning("cluster"); // hergebruikt dezelfde 'bezig'-status
    await acquireWakeLock();

    log("Edge-matching: berekeningsfase gestart...");
    try {
      const computeUrl = new URL("/api/import/match-edges", window.location.origin);
      computeUrl.searchParams.set("key", debugKey);
      computeUrl.searchParams.set("datasetVersionId", datasetVersionId);
      computeUrl.searchParams.set("phase", "compute");

      const res = await fetch(computeUrl.toString());
      const rawText = await res.text();
      let data: {
        error?: string;
        details?: string;
        report?: {
          totalEdges: number;
          totalEndpoints: number;
          confidenceCounts: Record<string, number>;
          ambiguousCount: number;
          avgDistanceM: string | null;
          maxDistanceM: string | null;
        };
        timingMs?: { read: number; match: number; cacheWrite: number; total: number };
      };
      try {
        data = JSON.parse(rawText);
      } catch {
        log(`Berekeningsfase gaf geen geldige JSON (status ${res.status}): ${rawText.slice(0, 300)}`, true);
        releaseWakeLock();
        setRunning(null);
        return;
      }
      if (!res.ok) {
        log(`Berekeningsfase mislukt: ${[data.error, data.details].filter(Boolean).join(" — ")}`, true);
        releaseWakeLock();
        setRunning(null);
        return;
      }

      log(
        `Berekening klaar (read ${data.timingMs?.read}ms, match ${data.timingMs?.match}ms, cache ${data.timingMs?.cacheWrite}ms).`
      );
      if (data.report) {
        log(
          `Rapport: ${data.report.totalEdges} edges, ${data.report.totalEndpoints} endpoints. Confidence: ${JSON.stringify(data.report.confidenceCounts)}. Ambigu: ${data.report.ambiguousCount}. Gem. afstand: ${data.report.avgDistanceM}m, max: ${data.report.maxDistanceM}m.`
        );
      }
    } catch (err) {
      log(`Berekeningsfase — onverwachte fout: ${err instanceof Error ? err.message : String(err)}`, true);
      releaseWakeLock();
      setRunning(null);
      return;
    }

    let writeOffset = 0;
    let attempt = 0;

    while (!stopRef.current) {
      const url = new URL("/api/import/match-edges", window.location.origin);
      url.searchParams.set("key", debugKey);
      url.searchParams.set("datasetVersionId", datasetVersionId);
      url.searchParams.set("phase", "write");
      url.searchParams.set("writeOffset", String(writeOffset));

      try {
        const res = await fetch(url.toString());
        const rawText = await res.text();
        let data: {
          error?: string;
          details?: string;
          newWriteOffset?: number;
          totalItems?: number;
          done?: boolean;
        };
        try {
          data = JSON.parse(rawText);
        } catch {
          attempt++;
          log(`Server gaf geen geldige JSON terug (status ${res.status}): ${rawText.slice(0, 200)} (poging ${attempt})`, true);
          if (attempt >= 10) {
            log("Gestopt na 10 mislukte pogingen. Tik nogmaals op start om te hervatten.", true);
            break;
          }
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        if (!res.ok) {
          attempt++;
          log(`Fout: ${[data.error, data.details].filter(Boolean).join(" — ")} (poging ${attempt})`, true);
          if (attempt >= 10) {
            log("Gestopt na 10 mislukte pogingen.", true);
            break;
          }
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        attempt = 0;
        log(`schrijven: ${data.newWriteOffset} / ${data.totalItems} edges bijgewerkt`);

        if (data.done) {
          log("Klaar — alle edges gekoppeld aan logical nodes.");
          break;
        }
        writeOffset = data.newWriteOffset ?? writeOffset;
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        attempt++;
        log(`Onverwachte fout: ${err instanceof Error ? err.message : String(err)} (poging ${attempt})`, true);
        if (attempt >= 10) {
          log("Gestopt na 10 mislukte pogingen.", true);
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
          disabled={running !== null || !datasetVersionId}
          onClick={() => runClusterNodes()}
          style={{ padding: "10px 16px", fontSize: 16 }}
        >
          Start node-clustering
        </button>
        <button
          disabled={running !== null || !datasetVersionId}
          onClick={() => runMatchEdges()}
          style={{ padding: "10px 16px", fontSize: 16 }}
        >
          Start edge-matching
        </button>
        <button
          disabled={running !== null}
          onClick={() => setProgress({ nodes: 0, edges: 0 })}
          style={{ padding: "10px 16px", fontSize: 16 }}
        >
          Reset voortgang
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
