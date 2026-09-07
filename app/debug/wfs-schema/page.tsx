"use client";

import { useState } from "react";

const SUGGESTED_LAYERS = [
  "routedatabank:fietsnetwerken_nlfietsland",
  "routedatabank:fietsknooppunten_vrij",
  "routedatabank:fietsnetwerken_meld",
  "routedatabank:fietsknooppunten_meld",
  "routedatabank:fietsnetwerken_vrij",
  "routedatabank:fietsknooppuntnetwerken",
];

export default function WfsSchemaPage() {
  const [typeName, setTypeName] = useState(SUGGESTED_LAYERS[0]);
  const [status, setStatus] = useState<"idle" | "bezig" | "klaar" | "fout">("idle");
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<{ name: string; type: string }[]>([]);

  async function run(name?: string) {
    const target = name ?? typeName;
    setTypeName(target);
    setStatus("bezig");
    setError(null);
    try {
      const key = window.localStorage.getItem("goknoop_debug_secret") || "";
      const params = new URLSearchParams({ typeName: target });
      if (key) params.set("key", key);
      const res = await fetch(`/api/debug/wfs-schema?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.details ?? json.error ?? "Onbekende fout.");
        setStatus("fout");
        return;
      }
      setFields(json.fields ?? []);
      setStatus("klaar");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("fout");
    }
  }

  const nodeRefLikely = fields.some((f) =>
    /^(from|to|van|naar|begin|eind|start|jn_?1|jn_?2|knp|node)/i.test(f.name)
  );

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>WFS-laagschema bekijken</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>Checkt of een laag directe knooppunt-verwijzingen bevat, die fietsnetwerken_vrij (nu in gebruik) niet heeft.</p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {SUGGESTED_LAYERS.map((l) => (
          <button
            key={l}
            onClick={() => run(l)}
            style={{ padding: "6px 10px", fontSize: 11, background: typeName === l ? "#085041" : "#eee", color: typeName === l ? "white" : "#333", border: "none", borderRadius: 6 }}
          >
            {l.replace("routedatabank:", "")}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input value={typeName} onChange={(e) => setTypeName(e.target.value)} style={{ flex: 1, padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8 }} />
        <button onClick={() => run()} disabled={status === "bezig"} style={{ padding: "10px 16px", fontSize: 14, background: "#085041", color: "white", border: "none", borderRadius: 8 }}>
          {status === "bezig" ? "..." : "Ophalen"}
        </button>
      </div>

      {status === "fout" && <p style={{ color: "red" }}>⚠️ {error}</p>}

      {status === "klaar" && (
        <>
          <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, background: nodeRefLikely ? "#e8f5e9" : "#fee", fontSize: 13 }}>
            {nodeRefLikely ? "✅ Deze laag heeft velden die op knooppunt-verwijzingen lijken." : "❌ Geen velden gevonden die op knooppunt-verwijzingen lijken."}
          </div>
          {fields.map((f, i) => (
            <div key={i} style={{ padding: "6px 10px", marginBottom: 4, background: "#f5f5f0", borderRadius: 6, fontSize: 12, fontFamily: "monospace" }}>
              {f.name} <span style={{ opacity: 0.6 }}>({f.type})</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
