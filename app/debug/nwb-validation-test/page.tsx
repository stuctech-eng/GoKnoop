"use client";

import { useState } from "react";

const REGIONS = [
  { key: "hilversum", label: "Amsterdam -> Hilversum" },
  { key: "lochem", label: "Lochem / Achterhoek" },
  { key: "volendam", label: "Volendam / Edam / Purmerend" },
];

export default function NwbValidationTestPage() {
  const [datasetVersionId, setDatasetVersionId] = useState("uINZ3y2QsgBdEyky3duq");
  const [status, setStatus] = useState<"idle" | "bezig" | "klaar" | "fout">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [activeRegion, setActiveRegion] = useState<string | null>(null);

  async function run(regionKey: string) {
    setActiveRegion(regionKey);
    setStatus("bezig");
    setError(null);
    try {
      const key = window.localStorage.getItem("goknoop_debug_secret") || "";
      const params = new URLSearchParams({ region: regionKey, datasetVersionId });
      if (key) params.set("key", key);
      const res = await fetch(`/api/debug/nwb-validation-test?${params.toString()}`, { cache: "no-store" });
      const rawText = await res.text();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(rawText);
      } catch {
        setError(`Geen geldige JSON terug (status ${res.status}): ${rawText.slice(0, 300)}`);
        setStatus("fout");
        return;
      }
      if (!res.ok) {
        setError((json.details as string) ?? (json.error as string) ?? "Onbekende fout.");
        setStatus("fout");
        return;
      }
      setResult(json);
      setStatus("klaar");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("fout");
    }
  }

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>NWB ruimtelijke validatietest</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Puur lezend. Geen productiecode gewijzigd, geen Bridge Layer geactiveerd. Test per regio of het Nationaal Wegenbestand bruikbare, verbindende fietsinfrastructuur bevat.
      </p>

      <input
        value={datasetVersionId}
        onChange={(e) => setDatasetVersionId(e.target.value)}
        placeholder="datasetVersionId"
        style={{ width: "100%", padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12 }}
      />

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {REGIONS.map((r) => (
          <button
            key={r.key}
            onClick={() => run(r.key)}
            disabled={status === "bezig"}
            style={{
              flex: 1,
              padding: "10px 8px",
              fontSize: 12,
              background: activeRegion === r.key ? "#085041" : "#eee",
              color: activeRegion === r.key ? "white" : "#333",
              border: "none",
              borderRadius: 8,
            }}
          >
            {status === "bezig" && activeRegion === r.key ? "Bezig..." : r.label}
          </button>
        ))}
      </div>

      {status === "fout" && <p style={{ color: "red" }}>⚠️ {error}</p>}

      {status === "klaar" && result && (
        <pre style={{ fontSize: 11, background: "#f5f5f0", padding: 12, borderRadius: 8, overflowX: "auto", whiteSpace: "pre-wrap" }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}
