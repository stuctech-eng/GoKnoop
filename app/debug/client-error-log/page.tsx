"use client";

import { useEffect, useState } from "react";

type ClientErrorLog = {
  id: string;
  message: string;
  stack: string | null;
  context: Record<string, unknown> | null;
  userAgent: string | null;
  createdAt: string;
};

export default function ClientErrorLogPage() {
  const [logs, setLogs] = useState<ClientErrorLog[]>([]);
  const [status, setStatus] = useState<"bezig" | "klaar" | "fout">("bezig");
  const [error, setError] = useState<string | null>(null);
  const [debugKey, setDebugKey] = useState("");
  const [copied, setCopied] = useState(false);

  function saveKey(value: string) {
    setDebugKey(value);
    window.localStorage.setItem("goknoop_debug_secret", value);
  }

  async function run(keyOverride?: string) {
    const key = keyOverride ?? debugKey;
    setStatus("bezig");
    setError(null);
    try {
      const params = new URLSearchParams();
      if (key) params.set("key", key);
      params.set("_t", String(Date.now()));
      const res = await fetch(`/api/debug/list-client-errors?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Onbekende fout.");
        setStatus("fout");
        return;
      }
      setLogs(json.logs);
      setStatus("klaar");
    } catch {
      setError("Netwerkfout.");
      setStatus("fout");
    }
  }

  useEffect(() => {
    const saved = window.localStorage.getItem("goknoop_debug_secret") || "";
    setDebugKey(saved);
    run(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function copyAll() {
    const text = logs
      .map((l) => `[${l.createdAt}] ${l.message}\ncontext: ${JSON.stringify(l.context)}\nstack: ${l.stack ?? "-"}\n`)
      .join("\n---\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Client error-log (kaart)</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Kaartfouten met context (centrum, zoom, stijl) die de live app zelf heeft vastgelegd.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          type="password"
          value={debugKey}
          onChange={(e) => saveKey(e.target.value)}
          placeholder="DEBUG_SECRET"
          style={{ flex: 1, padding: 10, fontSize: 14, border: "1px solid #ccc", borderRadius: 8 }}
        />
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button onClick={() => run()} disabled={status === "bezig"} style={{ flex: 1, padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8 }}>
          {status === "bezig" ? "Bezig..." : "Vernieuwen"}
        </button>
        <button onClick={copyAll} disabled={logs.length === 0} style={{ flex: 1, padding: 12, fontSize: 16, background: logs.length > 0 ? "#1a73e8" : "#ccc", color: "white", border: "none", borderRadius: 8 }}>
          {copied ? "Gekopieerd ✓" : "Kopieer alles"}
        </button>
      </div>

      {status === "fout" && <p style={{ color: "red" }}>⚠️ {error}</p>}
      {status === "klaar" && logs.length === 0 && <p style={{ opacity: 0.6 }}>Nog geen fouten gelogd.</p>}

      {logs.map((l) => (
        <div key={l.id} style={{ marginBottom: 12, padding: 12, border: "1px solid #ddd", borderRadius: 8, fontSize: 13 }}>
          <div style={{ fontWeight: "bold", color: "#c00" }}>{l.message}</div>
          <div style={{ opacity: 0.6, fontSize: 12 }}>{l.createdAt}</div>
          {l.context && <pre style={{ fontSize: 11, background: "#f7f7f7", padding: 8, borderRadius: 6, overflowX: "auto", marginTop: 6 }}>{JSON.stringify(l.context, null, 2)}</pre>}
          {l.userAgent && <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4 }}>{l.userAgent}</div>}
        </div>
      ))}
    </div>
  );
}
