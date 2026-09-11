"use client";

import { useState } from "react";

export default function CompareClusteringRunnerPage() {
  const [key, setKey] = useState(() => (typeof window !== "undefined" ? window.localStorage.getItem("goknoop_debug_secret") || "" : ""));
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<Record<string, unknown> | null>(null);
  const [log, setLog] = useState<string[]>([]);

  async function run() {
    setRunning(true);
    setOutput(null);
    setLog([]);
    try {
      const params = new URLSearchParams();
      if (key) params.set("key", key);

      setLog((prev) => [...prev, "Stap 1: opgeslagen segmenten ophalen (met opgeslagen fromClusterId/toClusterId)..."]);
      const segRes = await fetch(`/api/admin/read-active-nwb-segments?${params.toString()}`, { cache: "no-store" });
      const segJson = await segRes.json();
      if (!segRes.ok) {
        setLog((prev) => [...prev, `⚠️ ${segJson.details ?? segJson.error}`]);
        setRunning(false);
        return;
      }
      setLog((prev) => [...prev, `Klaar: ${segJson.segments.length} segmenten opgehaald.`]);

      setLog((prev) => [...prev, "Stap 2: server-side vers clusteren + vergelijken (compacte respons)..."]);
      const compareRes = await fetch(`/api/admin/cluster-only?${params.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments: segJson.segments }),
      });
      const compareJson = await compareRes.json();
      if (!compareRes.ok) {
        setLog((prev) => [...prev, `⚠️ ${compareJson.details ?? compareJson.error}`]);
        setRunning(false);
        return;
      }

      setOutput(compareJson);
      setLog((prev) => [...prev, compareJson.bijectieCheck?.isEquivalent ? "✅ BEWEZEN: opgeslagen en live clustering zijn equivalent." : "⚠️ NIET EQUIVALENT: opgeslagen en live clustering groeperen anders."]);
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ ${err instanceof Error ? err.message : String(err)}`]);
    }
    setRunning(false);
  }

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Clustering vergelijken (opgeslagen vs. live)</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Fase 1+2, herzien: vergelijking gebeurt nu volledig server-side, alleen een compacte samenvatting komt terug (de volledige
        toewijzingenlijst als respons bleek zelf te traag).
      </p>

      <input
        type="text"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="DEBUG_SECRET"
        style={{ width: "100%", padding: 10, fontSize: 14, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12 }}
      />

      <button onClick={run} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig..." : "Vergelijk clustering"}
      </button>

      <pre style={{ fontSize: 11, background: "#f5f5f0", padding: 8, borderRadius: 6, marginBottom: 12, whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>

      {output && (
        <pre style={{ fontSize: 11, background: "#eef", padding: 8, borderRadius: 6, maxHeight: 500, overflowY: "auto", whiteSpace: "pre-wrap" }}>
          {JSON.stringify(output, null, 2)}
        </pre>
      )}
    </div>
  );
}
