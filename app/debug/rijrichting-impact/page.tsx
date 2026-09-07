"use client";

import { useEffect, useState } from "react";

export default function RijrichtingImpactPage() {
  const [status, setStatus] = useState<"bezig" | "klaar" | "fout">("bezig");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [debugKey, setDebugKey] = useState("");

  async function run(key?: string) {
    setStatus("bezig");
    setError(null);
    try {
      const params = new URLSearchParams();
      const k = key ?? debugKey;
      if (k) params.set("key", k);
      const res = await fetch(`/api/debug/rijrichting-impact-analysis?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.details ?? json.error ?? "Onbekende fout.");
        setStatus("fout");
        return;
      }
      setData(json);
      setStatus("klaar");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("fout");
    }
  }

  useEffect(() => {
    const saved = window.localStorage.getItem("goknoop_debug_secret") || "";
    setDebugKey(saved);
    run(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Rijrichting — impactanalyse</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Puur analytisch. Geen wijziging aan isTraversable(), geen Bridge Layer, geen productiecode aangepast.
      </p>

      <button
        onClick={() => run()}
        disabled={status === "bezig"}
        style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 16 }}
      >
        {status === "bezig" ? "Bezig (kan tot ~10s duren)..." : "Analyse herhalen"}
      </button>

      {status === "fout" && <p style={{ color: "red" }}>⚠️ {error}</p>}

      {data && (
        <pre style={{ fontSize: 11, background: "#f5f5f0", padding: 12, borderRadius: 8, overflowX: "auto", whiteSpace: "pre-wrap" }}>
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}
