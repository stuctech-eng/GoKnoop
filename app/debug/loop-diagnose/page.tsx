"use client";

/**
 * Loop-route-diagnose (7-9-2026): onderzoekt het openstaande probleem van
 * vandaag ("1 rondje bij Lochem, kreeg 80km i.p.v. 20km"). Doorloopt exact
 * dezelfde twee stappen als de echte app (locatie -> kandidaat-knooppunten ->
 * /api/route/loop), maar toont ALLE diagnostiek die de generator al intern
 * bijhoudt (candidatesFound/outboundFailed/inboundFailed/duplicateRejected/
 * historyRejected, plus de score per kandidaat) -- geen gok, de generator
 * registreert dit al, alleen de UI liet het nooit zien.
 */

import { useState, Component, type ReactNode } from "react";

const LOCHEM_LAT = 52.157814726340035;
const LOCHEM_LON = 6.422090574730873;
const LOOP_REQUEST_TIMEOUT_MS = 20000; // ruim boven de 10s-Vercel-limiet van het endpoint zelf -- als WIJ eerder aborten dan de server, weten we zeker dat het serverzijdig vastliep, niet aan onze eigen client lag.

type LocationCandidate = { logicalNodeId: string; displayNumber: string; displayRegio: string; distanceM: number };

/** Vangt renderfouten op deze pagina op (7-9-2026, n.a.v. een onverklaarde "Application error"),
 *  logt ze naar dezelfde bestaande debug-endpoint i.p.v. een wit scherm zonder details. */
class DiagnosePageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    fetch("/api/debug/log-client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `loop-diagnose renderfout: ${error.message}`,
        stack: error.stack ?? null,
        context: { screen: "loop-diagnose", componentStack: info.componentStack ?? null, timestamp: new Date().toISOString() },
      }),
    }).catch(() => {});
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 16, background: "#fee", border: "1px solid #fbb", borderRadius: 8, margin: 16 }}>
          <div style={{ fontWeight: 600, color: "#c00", marginBottom: 6 }}>Renderfout opgevangen (i.p.v. een wit scherm)</div>
          <div style={{ fontSize: 12, fontFamily: "monospace" }}>{this.state.error.message}</div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>Gelogd naar Kaartfout-log -- ververs de pagina om opnieuw te proberen.</div>
        </div>
      );
    }
    return this.props.children;
  }
}

function LoopDiagnoseContent() {
  const [lat, setLat] = useState(String(LOCHEM_LAT));
  const [lon, setLon] = useState(String(LOCHEM_LON));
  const [targetKm, setTargetKm] = useState("20");
  const [status, setStatus] = useState<"idle" | "bezig" | "klaar" | "fout">("idle");
  const [error, setError] = useState<string | null>(null);
  const [locationCandidates, setLocationCandidates] = useState<LocationCandidate[] | null>(null);
  const [loopResult, setLoopResult] = useState<Record<string, unknown> | null>(null);
  const [copied, setCopied] = useState(false);
  const [elapsedS, setElapsedS] = useState<number | null>(null);

  async function run() {
    setStatus("bezig");
    setError(null);
    setLocationCandidates(null);
    setLoopResult(null);

    try {
      // Stap 1: exact zoals de echte app -- locatie -> kandidaat-knooppunten.
      const resolveRes = await fetch("/api/location/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: Number(lat), lon: Number(lon), limit: 5 }),
      });
      const resolveData = await resolveRes.json();
      if (!resolveRes.ok) {
        setError(`location/resolve: ${resolveData.error ?? "onbekende fout"}`);
        setStatus("fout");
        return;
      }
      const candidates: LocationCandidate[] = resolveData.candidates;
      setLocationCandidates(candidates);

      if (!candidates || candidates.length === 0) {
        setError("Geen kandidaat-knooppunten gevonden bij deze locatie.");
        setStatus("fout");
        return;
      }

      // Stap 2: exact zoals de echte app -- kandidaten -> /api/route/loop.
      // AbortController met een RUIMERE timeout dan het endpoint zelf (10s, Vercel
      // Hobby-limiet): als WIJ eerder aborten dan de server vanzelf klaar is, weten
      // we zeker dat het serverzijdig vastliep -- niet gegokt, maar aantoonbaar.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), LOOP_REQUEST_TIMEOUT_MS);
      const startTime = Date.now();
      const tickInterval = setInterval(() => setElapsedS((Date.now() - startTime) / 1000), 200);

      let loopRes: Response;
      try {
        loopRes = await fetch("/api/route/loop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            candidateNodeIds: candidates.map((c) => c.logicalNodeId),
            candidateDistancesM: candidates.map((c) => c.distanceM),
            targetDistanceM: Number(targetKm) * 1000,
            count: 4,
          }),
          signal: controller.signal,
        });
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        clearInterval(tickInterval);
        if (fetchErr instanceof Error && fetchErr.name === "AbortError") {
          setError(
            `Geen antwoord binnen ${LOOP_REQUEST_TIMEOUT_MS / 1000}s -- dat is RUIMER dan het endpoint se eigen 10s-limiet, dus dit wijst op een serverzijdige vastloper (bv. de Vercel Hobby-harde-afkap), niet op een trage verbinding.`
          );
        } else {
          setError(fetchErr instanceof Error ? fetchErr.message : String(fetchErr));
        }
        setStatus("fout");
        return;
      }
      clearTimeout(timeoutId);
      clearInterval(tickInterval);

      // Veilige JSON-parsing: een Vercel-timeout/gateway-fout geeft soms een RUWE
      // HTML-foutpagina terug i.p.v. JSON -- dat mag deze pagina niet laten crashen.
      const rawText = await loopRes.text();
      let loopData: Record<string, unknown>;
      try {
        loopData = JSON.parse(rawText);
      } catch {
        setError(`Antwoord was geen geldige JSON (status ${loopRes.status}) -- eerste 200 tekens: ${rawText.slice(0, 200)}`);
        setStatus("fout");
        return;
      }
      setLoopResult(loopData);
      setStatus("klaar");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("fout");
    }
  }

  async function copyResult() {
    const text = JSON.stringify({ locationCandidates, loopResult }, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const loops = (loopResult?.loops as unknown[] | undefined) ?? [];
  const diagnostics = loopResult?.diagnostics as Record<string, number> | undefined;
  const candidateScores = loopResult?.candidateScores as Record<string, unknown>[] | undefined;

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Loop-route-diagnose</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Doorloopt exact dezelfde stappen als de app zelf (locatie → kandidaat-knooppunten → rondje-generatie), met alle interne diagnostiek zichtbaar.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="lat" style={{ flex: 1, padding: 8, fontSize: 13, border: "1px solid #ccc", borderRadius: 8 }} />
        <input value={lon} onChange={(e) => setLon(e.target.value)} placeholder="lon" style={{ flex: 1, padding: 8, fontSize: 13, border: "1px solid #ccc", borderRadius: 8 }} />
        <input value={targetKm} onChange={(e) => setTargetKm(e.target.value)} placeholder="km" style={{ width: 60, padding: 8, fontSize: 13, border: "1px solid #ccc", borderRadius: 8 }} />
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button onClick={run} disabled={status === "bezig"} style={{ flex: 1, padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8 }}>
          {status === "bezig" ? `Bezig${elapsedS !== null ? ` (${elapsedS.toFixed(1)}s)` : "..."}` : "Draai diagnose"}
        </button>
        <button onClick={copyResult} disabled={status !== "klaar"} style={{ flex: 1, padding: 12, fontSize: 16, background: status === "klaar" ? "#1a73e8" : "#ccc", color: "white", border: "none", borderRadius: 8 }}>
          {copied ? "Gekopieerd ✓" : "Kopieer alles"}
        </button>
      </div>

      {status === "fout" && <p style={{ color: "red" }}>⚠️ {error}</p>}

      {locationCandidates && (
        <div style={{ marginBottom: 16, padding: 12, background: "#f5f5f0", borderRadius: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Stap 1: kandidaat-knooppunten bij deze locatie</div>
          {locationCandidates.map((c, i) => (
            <div key={i} style={{ fontSize: 12, fontFamily: "monospace" }}>
              Knpt {c.displayNumber} ({c.displayRegio}) — {Math.round(c.distanceM)}m — {c.logicalNodeId}
            </div>
          ))}
        </div>
      )}

      {loopResult && (
        <>
          <div style={{ marginBottom: 16, padding: 12, background: diagnostics ? "#f5f5f0" : "#fee", borderRadius: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Stap 2: rondje-generatie</div>
            {diagnostics ? (
              <>
                <div style={{ fontSize: 13 }}>
                  Gevraagd: {String(loopResult.requestedCount)} · Gevonden: <b style={{ color: (loopResult.foundCount as number) < (loopResult.requestedCount as number) ? "#c00" : "green" }}>{String(loopResult.foundCount)}</b>
                </div>
                <div style={{ fontSize: 12, fontFamily: "monospace", marginTop: 6, opacity: 0.85 }}>
                  candidatesFound: {diagnostics.candidatesFound}
                  <br />
                  outboundFailed: <span style={{ color: diagnostics.outboundFailed > 0 ? "#c00" : "inherit" }}>{diagnostics.outboundFailed}</span>
                  <br />
                  inboundFailed: <span style={{ color: diagnostics.inboundFailed > 0 ? "#c00" : "inherit" }}>{diagnostics.inboundFailed}</span>
                  <br />
                  duplicateRejected: <span style={{ color: diagnostics.duplicateRejected > 0 ? "#b8860b" : "inherit" }}>{diagnostics.duplicateRejected}</span>
                  <br />
                  historyRejected: {diagnostics.historyRejected}
                  <br />
                  succeeded: {diagnostics.succeeded}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: "#c00" }}>Geen bruikbare kandidaat — reden: {String(loopResult.reason ?? loopResult.error)}</div>
            )}
          </div>

          {candidateScores && (
            <div style={{ marginBottom: 16, padding: 12, background: "#f5f5f0", borderRadius: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Score per kandidaat-startpunt</div>
              {candidateScores.map((c, i) => (
                <div key={i} style={{ fontSize: 12, fontFamily: "monospace" }}>
                  {String(c.logicalNodeId)} — afstand {typeof c.distanceM === "number" ? Math.round(c.distanceM) : "?"}m — {String(c.foundCount)} routes — beste afwijking{" "}
                  {c.bestDeviationPercent !== null ? `${(c.bestDeviationPercent as number).toFixed(1)}%` : "n.v.t."} — score{" "}
                  {c.score === Infinity || c.score === null || typeof c.score !== "number" ? "∞ (onbruikbaar)" : c.score.toFixed(0)}
                </div>
              ))}
            </div>
          )}

          {loops.length > 0 && (
            <div style={{ marginBottom: 16, padding: 12, background: "#f5f5f0", borderRadius: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Gevonden route(s)</div>
              {(loops as Record<string, unknown>[]).map((l, i) => (
                <div key={i} style={{ fontSize: 12, fontFamily: "monospace" }}>
                  #{i + 1}: {typeof l.totalDistanceM === "number" ? (l.totalDistanceM / 1000).toFixed(1) : "?"}km (afwijking{" "}
                  {typeof l.deviationPercent === "number" ? l.deviationPercent.toFixed(1) : "?"}%)
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function LoopDiagnosePage() {
  return (
    <DiagnosePageErrorBoundary>
      <LoopDiagnoseContent />
    </DiagnosePageErrorBoundary>
  );
}
