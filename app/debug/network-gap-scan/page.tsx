"use client";

/**
 * Automatische testreeks voor het "gat tussen Waterland en het Gooi"-onderzoek
 * (sectie 9.52-9.69 in docs/GOKNOOP-MASTER.md, sessie-afsluiting 4 september 2026).
 *
 * Draait alle bekende testgevallen automatisch achter elkaar via de bestaande
 * /api/debug/direct-route-endpoint (geen nieuwe backend-logica), en biedt één
 * kopieerknop om het volledige resultaat als platte tekst te delen.
 *
 * Bekende node-ID's (uit GOKNOOP-MASTER.md, hergebruikt om niet opnieuw te hoeven
 * opzoeken):
 * - Knooppunt 5, Amsterdam Centraal:  CJSXBPUMG49vOPmYvhJd
 * - Knooppunt 61, Buiksloterweg:      bvMw2fsQTTyeJMUfX6wX
 * - Knooppunt 55, Hilversum-kandidaat: ZYuO6ZfzSa2iim0HcUbn
 */

import { useEffect, useState } from "react";

const AMSTERDAM_CENTRAAL_NODE_ID = "CJSXBPUMG49vOPmYvhJd"; // knooppunt 5
const BUIKSLOTERWEG_NODE_ID = "bvMw2fsQTTyeJMUfX6wX"; // knooppunt 61
const HILVERSUM_55_NODE_ID = "ZYuO6ZfzSa2iim0HcUbn"; // knooppunt 55

type TestCase = {
  label: string;
  toelichting: string;
  body: Record<string, unknown>;
};

const TEST_CASES: TestCase[] = [
  {
    label: "Buiksloterweg-pontje (61) → Centraal (5) [regressiecheck]",
    toelichting: "Al bevestigd goed op 30-8-2026. Moet nog steeds ~1,6 km/1 hop zijn.",
    body: { fromNodeId: BUIKSLOTERWEG_NODE_ID, toNodeId: AMSTERDAM_CENTRAAL_NODE_ID },
  },
  {
    label: "NDSM-pontje (F4) → Centraal (5)",
    toelichting: "Nieuw. Landt aan Amsterdam-kant bij De Ruijterkade, mogelijk ander knooppunt dan Buiksloterweg.",
    body: { nearFromLat: 52.4006, nearFromLon: 4.8913, toNodeId: AMSTERDAM_CENTRAAL_NODE_ID },
  },
  {
    label: "IJplein-pontje (F2) → Centraal (5)",
    toelichting: "Verifieert of dit al gedekt is door de Buiksloterweg-patch of een aparte patch nodig heeft.",
    body: { nearFromLat: 52.3875, nearFromLon: 4.908, toNodeId: AMSTERDAM_CENTRAAL_NODE_ID },
  },
  {
    label: "Centraal (5) → Hilversum (55)",
    toelichting: "Bekend node-ID, geen weergavenummer-dubbelzinnigheid.",
    body: { fromNodeId: AMSTERDAM_CENTRAAL_NODE_ID, toNodeId: HILVERSUM_55_NODE_ID },
  },
  {
    label: "Centraal (5) → Hilversum (36, via referentiepunt)",
    toelichting: "Weergavenummer 36 is niet landelijk uniek (109x gevonden) -- referentiepunt noodzakelijk.",
    body: { fromNodeId: AMSTERDAM_CENTRAAL_NODE_ID, toDisplayNumber: "36", nearToLat: 52.23159, nearToLon: 5.17349 },
  },
];

type DirectRouteResult = {
  fromNodeId: string;
  toNodeId: string;
  result: "ok" | "failed";
  distanceM?: number;
  hopCount?: number;
  reason?: string;
  geographicDistanceM: number;
  computeTimeMs: number;
  fromNodeIdsFound: number;
  toNodeIdsFound: number;
  fromDisplayNumber: string;
  fromLat: number;
  fromLon: number;
  toDisplayNumber: string;
  toLat: number;
  toLon: number;
};

type RunResult = {
  testCase: TestCase;
  status: "wachten" | "bezig" | "klaar" | "fout";
  data?: DirectRouteResult;
  error?: string;
};

export default function NetworkGapScanPage() {
  const [runs, setRuns] = useState<RunResult[]>(
    TEST_CASES.map((testCase) => ({ testCase, status: "wachten" }))
  );
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);

  async function runAll() {
    setRunning(true);
    setCopied(false);
    const next: RunResult[] = TEST_CASES.map((testCase) => ({ testCase, status: "wachten" }));
    setRuns(next);

    for (let i = 0; i < TEST_CASES.length; i++) {
      next[i] = { ...next[i], status: "bezig" };
      setRuns([...next]);

      let attempt = 0;
      const maxAttempts = 2; // 1 automatische retry bij netwerkfout (cold-start-robuustheid)
      while (attempt < maxAttempts) {
        attempt++;
        try {
          const res = await fetch("/api/debug/direct-route", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(TEST_CASES[i].body),
          });
          const data = await res.json();
          if (!res.ok) {
            next[i] = { ...next[i], status: "fout", error: data.error ?? "Onbekende fout." };
          } else {
            next[i] = { ...next[i], status: "klaar", data };
          }
          break;
        } catch {
          if (attempt >= maxAttempts) {
            next[i] = { ...next[i], status: "fout", error: `Netwerkfout tijdens test (na ${attempt} poging(en)).` };
          }
        }
      }
      setRuns([...next]);
    }

    setRunning(false);
  }

  useEffect(() => {
    runAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function buildCopyText(): string {
    const lines: string[] = [];
    lines.push(`GoKnoop netwerkgat-scan -- ${new Date().toISOString()}`);
    lines.push("");
    for (const run of runs) {
      lines.push(`## ${run.testCase.label}`);
      if (run.status === "klaar" && run.data) {
        const d = run.data;
        if (d.result === "ok") {
          lines.push(
            `OK -- ${(d.distanceM! / 1000).toFixed(1)} km netwerk, ${d.hopCount} hops, hemelsbreed ${(d.geographicDistanceM / 1000).toFixed(1)} km (ratio ${(d.distanceM! / d.geographicDistanceM).toFixed(1)}x)`
          );
        } else {
          const isolated = d.reason === "no_traversable_edges";
          lines.push(`FAILED -- ${d.reason}${isolated ? "  [EILAND-NODE: 0 bruikbare edges]" : ""}`);
        }
        lines.push(
          `Knooppunt ${d.fromDisplayNumber || "(geen)"} (${d.fromNodeIdsFound} kandidaten) -> Knooppunt ${d.toDisplayNumber || "(geen)"} (${d.toNodeIdsFound} kandidaten)`
        );
        lines.push(`Van-ID:  ${d.fromNodeId}  (${d.fromLat.toFixed(5)}, ${d.fromLon.toFixed(5)})`);
        lines.push(`Naar-ID: ${d.toNodeId}  (${d.toLat.toFixed(5)}, ${d.toLon.toFixed(5)})`);
      } else if (run.status === "fout") {
        lines.push(`FOUT -- ${run.error}`);
      } else {
        lines.push(`(nog niet uitgevoerd)`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  async function copyResults() {
    const text = buildCopyText();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const allDone = runs.every((r) => r.status === "klaar" || r.status === "fout");

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif", maxWidth: 600, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Netwerkgat-scan (Waterland ↔ Gooi)</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Draait automatisch alle bekende testgevallen uit het pontje-onderzoek. Geen invoer nodig.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          onClick={runAll}
          disabled={running}
          style={{ flex: 1, padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8 }}
        >
          {running ? "Bezig..." : "Opnieuw draaien"}
        </button>
        <button
          onClick={copyResults}
          disabled={!allDone}
          style={{ flex: 1, padding: 12, fontSize: 16, background: allDone ? "#1a73e8" : "#ccc", color: "white", border: "none", borderRadius: 8 }}
        >
          {copied ? "Gekopieerd ✓" : "Kopieer alle resultaten"}
        </button>
      </div>

      {runs.map((run, i) => (
        <div key={i} style={{ marginBottom: 12, padding: 14, border: "1px solid #ddd", borderRadius: 8 }}>
          <div style={{ fontSize: 14, fontWeight: "bold", marginBottom: 2 }}>{run.testCase.label}</div>
          <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 8 }}>{run.testCase.toelichting}</div>

          {run.status === "wachten" && <div style={{ fontSize: 13, opacity: 0.5 }}>⏳ wachten...</div>}
          {run.status === "bezig" && <div style={{ fontSize: 13, opacity: 0.7 }}>⏳ bezig...</div>}
          {run.status === "fout" && <div style={{ color: "red", fontSize: 14 }}>⚠️ {run.error}</div>}

          {run.status === "klaar" && run.data && (
            <div style={{ fontSize: 14, fontFamily: "monospace" }}>
              {run.data.result === "ok" ? (
                <div style={{ color: "green", fontWeight: "bold" }}>
                  ✅ {(run.data.distanceM! / 1000).toFixed(1)} km · {run.data.hopCount} hops · ratio{" "}
                  {(run.data.distanceM! / run.data.geographicDistanceM).toFixed(1)}x
                </div>
              ) : (
                <div style={{ color: "red", fontWeight: "bold" }}>
                  ❌ {run.data.reason}
                  {run.data.reason === "no_traversable_edges" ? " (eiland-node)" : ""}
                </div>
              )}
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
                Knpt {run.data.fromDisplayNumber || "(geen)"} → Knpt {run.data.toDisplayNumber || "(geen)"} · hemelsbreed{" "}
                {(run.data.geographicDistanceM / 1000).toFixed(1)} km
              </div>
              <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4, wordBreak: "break-all" }}>
                {run.data.fromNodeId} ({run.data.fromLat.toFixed(5)}, {run.data.fromLon.toFixed(5)})
                <br />
                {run.data.toNodeId} ({run.data.toLat.toFixed(5)}, {run.data.toLon.toFixed(5)})
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
