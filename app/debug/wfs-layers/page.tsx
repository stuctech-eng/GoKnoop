"use client";

import { useEffect, useState } from "react";

export default function WfsLayersPage() {
  const [status, setStatus] = useState<"bezig" | "klaar" | "fout">("bezig");
  const [error, setError] = useState<string | null>(null);
  const [layers, setLayers] = useState<string[]>([]);
  const [titles, setTitles] = useState<string[]>([]);

  async function run() {
    setStatus("bezig");
    setError(null);
    try {
      const key = window.localStorage.getItem("goknoop_debug_secret") || "";
      const params = new URLSearchParams();
      if (key) params.set("key", key);
      const res = await fetch(`/api/debug/wfs-layers?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.details ?? json.error ?? "Onbekende fout.");
        setStatus("fout");
        return;
      }
      setLayers(json.layers ?? []);
      setTitles(json.titles ?? []);
      setStatus("klaar");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("fout");
    }
  }

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Routedatabank — alle WFS-lagen</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Puur lezend, met de al-bestaande WFS-inloggegevens. Toont welke lagen de Routedatabank in totaal aanbiedt, niet alleen de twee die GoKnoop nu gebruikt (fietsknooppuntnetwerken + fietsnetwerken_vrij).
      </p>

      <button
        onClick={run}
        disabled={status === "bezig"}
        style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 16 }}
      >
        {status === "bezig" ? "Bezig..." : "Opnieuw ophalen"}
      </button>

      {status === "fout" && <p style={{ color: "red" }}>⚠️ {error}</p>}

      {status === "klaar" && (
        <>
          <p style={{ fontSize: 13, marginBottom: 12 }}>
            <b>{layers.length}</b> lagen gevonden.
          </p>
          {layers.map((name, i) => (
            <div key={i} style={{ padding: "8px 10px", marginBottom: 6, background: "#f5f5f0", borderRadius: 8, fontSize: 13 }}>
              <div style={{ fontFamily: "monospace", fontWeight: 600 }}>{name}</div>
              {titles[i] && <div style={{ fontSize: 12, opacity: 0.7 }}>{titles[i]}</div>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
