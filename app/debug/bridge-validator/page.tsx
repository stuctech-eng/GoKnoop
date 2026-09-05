"use client";

/**
 * UI voor /api/debug/bridge-validator. Draait automatisch voor de 4 bekende
 * structurele-gap-knopen, toont per knoop de ORS-gevalideerde kandidaten.
 */

import { useEffect, useState } from "react";

type OrsResult =
  | { validated: false; reason: string; message: string | null }
  | { validated: true; orsDistanceM: number; orsDurationS: number; ratioOrsVsGeographic: number; plausible: boolean };

type Candidate = {
  candidateNodeId: string;
  candidateDisplayNumber: string | null;
  geographicDistanceM: number;
  otherComponentSize: number;
  ors: OrsResult;
  reverse: { validated: false; reason: string; message: string | null } | { validated: true; distanceM: number; durationS: number };
  symmetric: boolean | null;
  asymmetryPercent: number | null;
};

type NodeResult = {
  nodeId: string;
  displayNumber?: string | null;
  componentSize?: number;
  candidatesFound?: number;
  candidates?: Candidate[];
  error?: string;
};

type BridgeResponse = {
  orsConfigured: boolean;
  orsUnavailableReason: string | null;
  totalLogicalNodes: number;
  results: NodeResult[];
};

export default function BridgeValidatorPage() {
  const [data, setData] = useState<BridgeResponse | null>(null);
  const [status, setStatus] = useState<"bezig" | "klaar" | "fout">("bezig");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [debugKey, setDebugKey] = useState("");

  function saveKey(value: string) {
    setDebugKey(value);
    window.localStorage.setItem("goknoop_debug_secret", value);
  }

  async function run(keyOverride?: string) {
    const key = keyOverride ?? debugKey;
    setStatus("bezig");
    setError(null);
    setCopied(false);
    try {
      const params = new URLSearchParams();
      if (key) params.set("key", key);
      params.set("_t", String(Date.now()));
      const res = await fetch(`/api/debug/bridge-validator?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Onbekende fout.");
        setStatus("fout");
        return;
      }
      setData(json);
      setStatus("klaar");
    } catch {
      setError("Netwerkfout tijdens validatie.");
      setStatus("fout");
    }
  }

  useEffect(() => {
    const saved = window.localStorage.getItem("goknoop_debug_secret") || "";
    setDebugKey(saved);
    run(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function buildCopyText(): string {
    if (!data) return "";
    const lines: string[] = [];
    lines.push(`GoKnoop bridge-validator -- ${new Date().toISOString()}`);
    lines.push(`ORS geconfigureerd: ${data.orsConfigured}${data.orsUnavailableReason ? ` (${data.orsUnavailableReason})` : ""}`);
    lines.push("");
    for (const r of data.results) {
      if (r.error) {
        lines.push(`## ${r.nodeId} -- FOUT: ${r.error}`);
        lines.push("");
        continue;
      }
      lines.push(`## Knooppunt ${r.displayNumber ?? "(geen)"} (${r.nodeId}) -- eigen component: ${r.componentSize} knopen`);
      for (const c of r.candidates ?? []) {
        const rev = c.reverse.validated ? `${c.reverse.distanceM}m (${(c.reverse.durationS / 60).toFixed(0)} min)` : `GEEN ROUTE (${c.reverse.reason})`;
        const sym = c.symmetric === null ? "n/a" : c.symmetric ? `symmetrisch (${c.asymmetryPercent}% verschil)` : `ASYMMETRISCH (${c.asymmetryPercent}% verschil)`;
        if (c.ors.validated) {
          lines.push(
            `  -> ${c.candidateDisplayNumber ?? c.candidateNodeId} (component ${c.otherComponentSize}) | geo ${c.geographicDistanceM}m | heen ${c.ors.orsDistanceM}m (${(c.ors.orsDurationS / 60).toFixed(0)} min) | terug ${rev} | ${sym} | ratio ${c.ors.ratioOrsVsGeographic}x | ${c.ors.plausible ? "PLAUSIBEL" : "twijfelachtig"}`
          );
        } else {
          lines.push(
            `  -> ${c.candidateDisplayNumber ?? c.candidateNodeId} (component ${c.otherComponentSize}) | geo ${c.geographicDistanceM}m | heen: GEEN ROUTE (${c.ors.reason}${c.ors.message ? `: ${c.ors.message}` : ""}) | terug ${rev}`
          );
        }
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  async function copyResults() {
    try {
      await navigator.clipboard.writeText(buildCopyText());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Bridge-validator (ORS)</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Zoekt per bekende gap-knoop de dichtstbijzijnde knopen in een ANDER netwerk-component, en laat ORS
        checken of daar echt een fietsroute bestaat. Draait automatisch.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          type="password"
          value={debugKey}
          onChange={(e) => saveKey(e.target.value)}
          placeholder="DEBUG_SECRET (éénmalig invullen)"
          style={{ flex: 1, padding: 10, fontSize: 14, border: "1px solid #ccc", borderRadius: 8 }}
        />
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button onClick={() => run()} disabled={status === "bezig"} style={{ flex: 1, padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8 }}>
          {status === "bezig" ? "Bezig..." : "Opnieuw draaien"}
        </button>
        <button onClick={copyResults} disabled={status !== "klaar"} style={{ flex: 1, padding: 12, fontSize: 16, background: status === "klaar" ? "#1a73e8" : "#ccc", color: "white", border: "none", borderRadius: 8 }}>
          {copied ? "Gekopieerd ✓" : "Kopieer alles"}
        </button>
      </div>

      {status === "fout" && <p style={{ color: "red" }}>⚠️ {error}</p>}

      {data && !data.orsConfigured && (
        <div style={{ padding: 12, background: "#fff3cd", border: "1px solid #ffe69c", borderRadius: 8, marginBottom: 16, fontSize: 13 }}>
          ⚠️ ORS niet geconfigureerd: <code>{data.orsUnavailableReason}</code>. Kandidaten worden getoond met geografische afstand, maar
          zonder ORS-validatie. Voeg <code>OPENROUTESERVICE_API_KEY</code> toe in Vercel om echte validatie te krijgen.
        </div>
      )}

      {data &&
        data.results.map((r, i) => (
          <div key={i} style={{ marginBottom: 16, padding: 14, border: "1px solid #ddd", borderRadius: 8 }}>
            {r.error ? (
              <div style={{ color: "red", fontSize: 14 }}>
                {r.nodeId}: {r.error}
              </div>
            ) : (
              <>
                <div style={{ fontSize: 14, fontWeight: "bold", marginBottom: 8 }}>
                  Knooppunt {r.displayNumber ?? "(geen)"}{" "}
                  <span style={{ fontWeight: "normal", opacity: 0.6 }}>
                    ({r.nodeId}) — eigen component: {r.componentSize} knopen
                  </span>
                </div>
                {(r.candidates ?? []).map((c, j) => (
                  <div key={j} style={{ fontSize: 13, fontFamily: "monospace", borderTop: "1px solid #eee", padding: "6px 0" }}>
                    <div>
                      → {c.candidateDisplayNumber ?? c.candidateNodeId} (component {c.otherComponentSize}) · geo {c.geographicDistanceM}m
                    </div>
                    {c.ors.validated ? (
                      <div style={{ color: c.ors.plausible ? "green" : "#b8860b" }}>
                        heen {c.ors.orsDistanceM}m ({(c.ors.orsDurationS / 60).toFixed(0)} min) · ratio {c.ors.ratioOrsVsGeographic}x ·{" "}
                        {c.ors.plausible ? "PLAUSIBEL ✓" : "twijfelachtig ⚠️"}
                      </div>
                    ) : (
                      <div style={{ color: "#c00" }}>
                        GEEN ROUTE — {c.ors.reason}
                        {c.ors.message ? `: ${c.ors.message}` : ""}
                      </div>
                    )}
                    <div style={{ opacity: 0.75 }}>
                      terug:{" "}
                      {c.reverse.validated ? `${c.reverse.distanceM}m (${(c.reverse.durationS / 60).toFixed(0)} min)` : `GEEN ROUTE (${c.reverse.reason})`}
                      {c.symmetric !== null && (
                        <span style={{ color: c.symmetric ? "green" : "#c00", marginLeft: 6 }}>
                          {c.symmetric ? `symmetrisch ✓` : `ASYMMETRISCH ⚠️`} ({c.asymmetryPercent}%)
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        ))}
    </div>
  );
}
