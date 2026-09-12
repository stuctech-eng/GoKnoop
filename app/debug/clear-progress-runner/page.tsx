"use client";

import { useState } from "react";

export default function ClearProgressRunnerPage() {
  const [key, setKey] = useState(() => (typeof window !== "undefined" ? window.localStorage.getItem("goknoop_debug_secret") || "" : ""));
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  async function run() {
    setRunning(true);
    setLog([]);
    try {
      const params = new URLSearchParams();
      if (key) params.set("key", key);

      let mogelijkMeerOver = true;
      let ronde = 0;
      let totaalVerwijderd = 0;
      while (mogelijkMeerOver && ronde < 20) {
        ronde++;
        const res = await fetch(`/api/admin/clear-progress?${params.toString()}`, { method: "POST" });
        const json = await res.json();
        if (!res.ok) {
          setLog((prev) => [...prev, `⚠️ ${json.details ?? json.error}`]);
          setRunning(false);
          return;
        }
        totaalVerwijderd += json.verwijderd;
        mogelijkMeerOver = json.mogelijkMeerOver;
        setLog((prev) => [...prev, `Ronde ${ronde}: ${json.verwijderd} verwijderd (totaal: ${totaalVerwijderd})`]);
      }

      setLog((prev) => [...prev, "✅ Klaar -- log opgeruimd."]);
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ ${err instanceof Error ? err.message : String(err)}`]);
    }
    setRunning(false);
  }

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Voortgangslog opruimen</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Ruimt de opgehoopte diagnostische checkpoints op (roept /api/admin/clear-progress herhaald aan tot leeg).
      </p>

      <input
        type="text"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="DEBUG_SECRET"
        style={{ width: "100%", padding: 10, fontSize: 14, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12 }}
      />

      <button onClick={run} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig..." : "Opruimen starten"}
      </button>

      <pre style={{ fontSize: 11, background: "#f5f5f0", padding: 8, borderRadius: 6, maxHeight: 400, overflowY: "auto", whiteSpace: "pre-wrap" }}>
        {log.join("\n")}
      </pre>
    </div>
  );
}
