"use client";

/**
 * Runt phase=prepare/status -> herhaald compute-batch -> (optioneel) write voor
 * /api/import/generate-bridges, zonder dat de gebruiker per batch een URL met
 * secret hoeft te bouwen. Hergebruikt exact dezelfde API-route (geen eigen
 * ORS-logica hier) -- deze pagina is puur een client-side orkestrator.
 */

import { useEffect, useRef, useState } from "react";

type Scope = "strong" | "weak";

type BatchResult = {
  batchOffset: number;
  batchProcessed: number;
  stoppedEarly: string | null;
  batchValidCount: number;
  batchRejectedBreakdown: {
    rejected_no_route: number;
    rejected_distance: number;
    rejected_circuity: number;
    rejected_provider_error: number;
  };
  processedCount: number;
  totalDirectionalItems: number;
  status: string;
};

class ApiCallError extends Error {
  data: Record<string, unknown>;
  constructor(message: string, data: Record<string, unknown>) {
    super(message);
    this.data = data;
  }
}

export default function GenerateBridgesRunnerPage() {
  const [debugKey, setDebugKey] = useState("");
  const [datasetVersionId, setDatasetVersionId] = useState("uINZ3y2QsgBdEyky3duq");
  const [scope, setScope] = useState<Scope>("strong");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<BatchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "running" | "complete" | "written" | "error">("idle");
  const [writeResult, setWriteResult] = useState<{ written: number; validCount: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const runningRef = useRef(false); // synchrone guard tegen dubbeltik/race -- state alleen sluit het tijdvenster niet snel genoeg

  useEffect(() => {
    const saved = window.localStorage.getItem("goknoop_debug_secret") || "";
    setDebugKey(saved);
  }, []);

  function saveKey(value: string) {
    setDebugKey(value);
    window.localStorage.setItem("goknoop_debug_secret", value);
  }

  async function call(params: Record<string, string>) {
    const qs = new URLSearchParams({ datasetVersionId, key: debugKey, _t: String(Date.now()), ...params }).toString();
    const res = await fetch(`/api/import/generate-bridges?${qs}`, { cache: "no-store" });
    const json = await res.json();
    if (!res.ok) throw new ApiCallError(json.error || "Onbekende fout.", json);
    return json;
  }

  async function run() {
    if (runningRef.current) return; // synchrone dubbeltik-blokkade, vóór enige state/async
    runningRef.current = true;
    setRunning(true);
    setError(null);
    setLog([]);
    setStatus("running");
    setWriteResult(null);

    try {
      // 1. Status opvragen -- NOOIT blind prepare aanroepen (dat zou voortgang resetten).
      const statusResp = await call({ phase: "status", scope });
      let processedCount = 0;
      let totalDirectionalItems = 0;

      if (!statusResp.prepared) {
        const prep = await call({ phase: "prepare", scope });
        totalDirectionalItems = prep.totalDirectionalItems;
        processedCount = 0;
        if (totalDirectionalItems === 0) {
          setStatus("complete");
          return;
        }
      } else {
        processedCount = statusResp.processedCount;
        totalDirectionalItems = statusResp.totalDirectionalItems;
        if (statusResp.status === "complete" || statusResp.status === "written") {
          setStatus(statusResp.status === "written" ? "written" : "complete");
          return;
        }
      }

      // 2. Herhaald compute-batch, hervat automatisch vanaf processedCount.
      //    Zelfherstellend (toegevoegd 5-9-2026, n.a.v. een batchOffset-mismatch
      //    door een dubbeltik): bij een 409 met expectedBatchOffset past de loop
      //    zichzelf aan i.p.v. hard te stoppen -- de server weet het beter dan
      //    de lokale teller.
      while (processedCount < totalDirectionalItems) {
        try {
          const batch: BatchResult = await call({ phase: "compute-batch", scope, batchOffset: String(processedCount) });
          setLog((prev) => [...prev, batch]);
          processedCount = batch.processedCount;
          if (batch.status === "complete") {
            setStatus("complete");
            break;
          }
        } catch (err) {
          if (err instanceof ApiCallError && typeof err.data.expectedBatchOffset === "number") {
            processedCount = err.data.expectedBatchOffset as number;
            continue; // opnieuw proberen met de door de server aangegeven juiste offset
          }
          throw err;
        }
      }
      if (processedCount >= totalDirectionalItems) setStatus("complete");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    } finally {
      setRunning(false);
      runningRef.current = false;
    }
  }

  async function doWrite() {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);
    try {
      const result = await call({ phase: "write", scope });
      setWriteResult({ written: result.written, validCount: result.validCount });
      setStatus("written");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      runningRef.current = false;
    }
  }

  const totalProcessed = log.length > 0 ? log[log.length - 1].processedCount : 0;
  const totalItems = log.length > 0 ? log[log.length - 1].totalDirectionalItems : 0;
  const cumulativeValid = log.reduce((sum, b) => sum + b.batchValidCount, 0);
  const cumulativeRejected = log.reduce(
    (sum, b) =>
      sum +
      b.batchRejectedBreakdown.rejected_no_route +
      b.batchRejectedBreakdown.rejected_distance +
      b.batchRejectedBreakdown.rejected_circuity +
      b.batchRejectedBreakdown.rejected_provider_error,
    0
  );

  function buildCopyText(): string {
    const lines: string[] = [];
    lines.push(`generate-bridges runner -- scope=${scope} -- ${new Date().toISOString()}`);
    lines.push(`status: ${status}`);
    if (totalItems > 0) lines.push(`voortgang: ${totalProcessed}/${totalItems}`);
    lines.push(`cumulatief: ${cumulativeValid} valid, ${cumulativeRejected} rejected`);
    if (writeResult) lines.push(`write: ${writeResult.written} geschreven, waarvan ${writeResult.validCount} valid`);
    if (error) lines.push(`FOUT: ${error}`);
    return lines.join("\n");
  }

  async function copySummary() {
    try {
      await navigator.clipboard.writeText(buildCopyText());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif", maxWidth: 600, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Generate-bridges runner</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Vult automatisch alle compute-batches af (secret één keer invullen). Hervat veilig vanaf de laatste
        voortgang als je de pagina opnieuw opent.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        <input
          type="password"
          value={debugKey}
          onChange={(e) => saveKey(e.target.value)}
          placeholder="DEBUG_SECRET"
          style={{ padding: 10, fontSize: 14, border: "1px solid #ccc", borderRadius: 8 }}
        />
        <input
          value={datasetVersionId}
          onChange={(e) => setDatasetVersionId(e.target.value)}
          placeholder="datasetVersionId"
          style={{ padding: 10, fontSize: 14, border: "1px solid #ccc", borderRadius: 8 }}
        />
        <select value={scope} onChange={(e) => setScope(e.target.value as Scope)} style={{ padding: 10, fontSize: 14, border: "1px solid #ccc", borderRadius: 8 }}>
          <option value="strong">strong (edgeCount === 0)</option>
          <option value="weak">weak (edgeCount === 1 + kleine component)</option>
        </select>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button
          onClick={run}
          disabled={running || !debugKey}
          style={{ flex: 1, padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8 }}
        >
          {running ? "Bezig..." : "Start / hervat batches"}
        </button>
        <button onClick={copySummary} disabled={log.length === 0} style={{ flex: 1, padding: 12, fontSize: 16, background: log.length > 0 ? "#1a73e8" : "#ccc", color: "white", border: "none", borderRadius: 8 }}>
          {copied ? "Gekopieerd ✓" : "Kopieer samenvatting"}
        </button>
      </div>

      {error && (
        <div style={{ padding: 12, background: "#fee", border: "1px solid #fbb", borderRadius: 8, marginBottom: 16, color: "#c00" }}>
          ⚠️ {error}
        </div>
      )}

      {totalItems > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ height: 10, background: "#eee", borderRadius: 5, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${(totalProcessed / totalItems) * 100}%`, background: "#085041" }} />
          </div>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            {totalProcessed}/{totalItems} verwerkt · {cumulativeValid} valid · {cumulativeRejected} rejected
          </div>
        </div>
      )}

      {status === "complete" && !writeResult && (
        <button
          onClick={doWrite}
          disabled={running}
          style={{ width: "100%", padding: 12, fontSize: 16, background: "#a83232", color: "white", border: "none", borderRadius: 8, marginBottom: 16 }}
        >
          Alles compleet — schrijf naar networkBridges
        </button>
      )}

      {writeResult && (
        <div style={{ padding: 12, background: "#e6f4ea", border: "1px solid #b7dfc0", borderRadius: 8, marginBottom: 16 }}>
          ✅ Geschreven: {writeResult.written} bridges ({writeResult.validCount} valid).
        </div>
      )}

      {log.map((b, i) => (
        <div key={i} style={{ fontSize: 12, fontFamily: "monospace", padding: "4px 0", borderTop: "1px solid #eee" }}>
          batch @{b.batchOffset}: {b.batchProcessed} verwerkt, {b.batchValidCount} valid, {b.batchRejectedBreakdown.rejected_no_route}/
          {b.batchRejectedBreakdown.rejected_distance}/{b.batchRejectedBreakdown.rejected_circuity}/{b.batchRejectedBreakdown.rejected_provider_error} rejected
          (no_route/distance/circuity/provider_error) — totaal {b.processedCount}/{b.totalDirectionalItems}
          {b.stoppedEarly && <div style={{ color: "#b8860b" }}>⏸️ {b.stoppedEarly}</div>}
        </div>
      ))}
    </div>
  );
}
