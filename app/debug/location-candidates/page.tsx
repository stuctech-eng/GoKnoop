"use client";

/**
 * Locatie-kandidaat-diagnose (GOKNOOP-MASTER.md, Volendam-onderzoek 29-8-2026).
 *
 * Doel: voor een locatie (GPS of plaatsnaam) alle 5 kandidaat-knooppunten van
 * `/api/location/resolve` tonen, en voor elke kandidaat apart `/api/route/loop`
 * proberen -- zodat zichtbaar wordt of de app blind het VERKEERDE (dichtstbijzijnde
 * maar slecht verbonden) knooppunt kiest, terwijl een net iets verder gelegen
 * kandidaat wél bruikbare routes oplevert.
 *
 * Roept UITSLUITEND bestaande, al gedeployde endpoints aan
 * (/api/location/resolve, /api/route/loop) -- GEEN wijziging aan de
 * productie-algoritmiek (resolveNearestNodes, generateLoopRoutes). Puur
 * uitlezend/diagnostisch, zoals afgesproken.
 */

import { useState } from "react";

type LocationCandidate = {
  logicalNodeId: string;
  displayNumber?: string;
  displayRegio?: string;
  distanceM: number;
  edgeCount: number;
  x: number;
  y: number;
};

type CandidateResult = {
  candidate: LocationCandidate;
  status: "pending" | "testing" | "done" | "error";
  foundCount?: number;
  requestedCount?: number;
  diagnostics?: unknown;
  errorMessage?: string;
};

const TEST_DISTANCE_KM = 20;

export default function LocationCandidatesDiagnosticPage() {
  const [placeName, setPlaceName] = useState("Volendam");
  const [useGps, setUseGps] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<CandidateResult[]>([]);
  const [chosenIndex, setChosenIndex] = useState<number | null>(null);

  async function run() {
    setError(null);
    setResults([]);
    setLoading(true);

    try {
      let body: { lat?: number; lon?: number; placeName?: string; limit: number };

      if (useGps) {
        const position = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true });
        });
        body = { lat: position.coords.latitude, lon: position.coords.longitude, limit: 5 };
      } else {
        body = { placeName, limit: 5 };
      }

      const resolveRes = await fetch("/api/location/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const resolveData = await resolveRes.json();
      if (!resolveRes.ok) {
        setError(resolveData.error ?? "Locatie-resolutie mislukt.");
        setLoading(false);
        return;
      }

      const candidates: LocationCandidate[] = resolveData.candidates ?? [];
      if (candidates.length === 0) {
        setError("Geen kandidaat-knooppunten gevonden voor deze locatie.");
        setLoading(false);
        return;
      }
      // data.candidates[0] is exact wat de productie-app vandaag kiest (app/page.tsx) --
      // hier expliciet zichtbaar gemaakt, niet stilzwijgend aangenomen.
      setChosenIndex(0);

      const initialResults: CandidateResult[] = candidates.map((candidate) => ({ candidate, status: "pending" }));
      setResults(initialResults);

      // Elke kandidaat afzonderlijk testen, na elkaar (niet parallel) -- simpeler te
      // volgen in de UI, en voorkomt onnodige gelijktijdige belasting van dezelfde
      // GraphProvider-laadstap server-side.
      for (let i = 0; i < candidates.length; i++) {
        setResults((prev) => prev.map((r, idx) => (idx === i ? { ...r, status: "testing" } : r)));

        try {
          const loopRes = await fetch("/api/route/loop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              startLogicalNodeId: candidates[i].logicalNodeId,
              targetDistanceM: TEST_DISTANCE_KM * 1000,
              count: 4,
            }),
          });
          const loopData = await loopRes.json();

          if (!loopRes.ok) {
            setResults((prev) =>
              prev.map((r, idx) => (idx === i ? { ...r, status: "error", errorMessage: loopData.error ?? "Onbekende fout" } : r))
            );
            continue;
          }

          setResults((prev) =>
            prev.map((r, idx) =>
              idx === i
                ? {
                    ...r,
                    status: "done",
                    foundCount: loopData.foundCount,
                    requestedCount: loopData.requestedCount,
                    diagnostics: loopData.diagnostics,
                  }
                : r
            )
          );
        } catch (err) {
          setResults((prev) =>
            prev.map((r, idx) => (idx === i ? { ...r, status: "error", errorMessage: err instanceof Error ? err.message : String(err) } : r))
          );
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 480, margin: "0 auto", fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 18 }}>Locatie-kandidaat-diagnose</h1>
      <p style={{ fontSize: 13, color: "#555" }}>
        Test alle 5 kandidaat-knooppunten van een locatie apart tegen de rondje-generator ({TEST_DISTANCE_KM}km) --
        puur diagnostisch, verandert niets aan de productieapp.
      </p>

      <div style={{ margin: "12px 0" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, marginBottom: 8 }}>
          <input type="checkbox" checked={useGps} onChange={(e) => setUseGps(e.target.checked)} />
          Gebruik mijn huidige GPS-locatie in plaats van een plaatsnaam
        </label>
        {!useGps && (
          <input
            value={placeName}
            onChange={(e) => setPlaceName(e.target.value)}
            placeholder="Plaatsnaam, bijv. Volendam"
            style={{ width: "100%", padding: 10, fontSize: 16, boxSizing: "border-box" }}
          />
        )}
      </div>

      <button
        onClick={run}
        disabled={loading}
        style={{ width: "100%", padding: 14, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8 }}
      >
        {loading ? "Bezig..." : "Test alle kandidaten"}
      </button>

      {error && <p style={{ color: "#b00020", fontSize: 13, marginTop: 12 }}>{error}</p>}

      <div style={{ marginTop: 16 }}>
        {results.map((r, i) => (
          <div
            key={r.candidate.logicalNodeId}
            style={{
              border: "1px solid #ddd",
              borderLeft: i === chosenIndex ? "4px solid #085041" : "1px solid #ddd",
              borderRadius: 8,
              padding: 12,
              marginBottom: 8,
              fontSize: 13,
              fontFamily: "monospace",
            }}
          >
            <div style={{ fontWeight: 700 }}>
              #{i + 1} {i === chosenIndex && <span style={{ color: "#085041" }}>← door de app gekozen (candidates[0])</span>}
            </div>
            <div>knooppunt: {r.candidate.displayNumber ?? "(geen nummer)"} — {r.candidate.displayRegio ?? "?"}</div>
            <div>logicalNodeId: {r.candidate.logicalNodeId}</div>
            <div>afstand tot GPS-punt: {Math.round(r.candidate.distanceM)} m</div>
            <div>edgeCount: {r.candidate.edgeCount}</div>
            <div>
              status:{" "}
              {r.status === "pending" && "wachtend"}
              {r.status === "testing" && "bezig met testen..."}
              {r.status === "done" && (
                <span style={{ color: (r.foundCount ?? 0) > 0 ? "#1a7a3c" : "#b00020", fontWeight: 700 }}>
                  {r.foundCount ?? 0} / {r.requestedCount ?? 4} routes gevonden
                </span>
              )}
              {r.status === "error" && <span style={{ color: "#b00020" }}>fout: {r.errorMessage}</span>}
            </div>
            {r.diagnostics != null && (
              <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", marginTop: 4, opacity: 0.7 }}>
                {JSON.stringify(r.diagnostics, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
