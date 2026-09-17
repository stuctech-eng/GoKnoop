"use client";

/**
 * TOEGEVOEGD 17-9-2026 -- puur diagnostisch, geen productiecode aangeraakt.
 *
 * Aanleiding: Volendam -> Hoorn gaf in de echte app een 504-timeout, ook na de
 * geometrie-projectie-fix in cached-nwb-provider.ts. `test-to-destination-live`
 * omzeilt bewust adresgeocodering (vaste knooppunt-ID's) en kon dit dus niet
 * reproduceren. Deze pagina doorloopt EXACT dezelfde drie stappen als
 * `app/page.tsx`'s "route naar adres"-flow:
 *   1. POST /api/location/resolve  (herkomst, via placeName i.p.v. GPS --
 *      makkelijker herhaalbaar te testen dan een live locatiefix)
 *   2. POST /api/location/resolve  (bestemming, via placeName)
 *   3. POST /api/route/to-destination
 * met een eigen tijdmeting per stap, zodat zichtbaar wordt WELKE stap de tijd
 * kost of vastloopt -- in plaats van alleen de totale 504 te zien.
 */

import { useState } from "react";

function CopyAllButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button onClick={handleCopy} style={{ width: "100%", padding: 12, fontSize: 15, background: copied ? "#085041" : "#333", color: "white", border: "none", borderRadius: 8, marginBottom: 16 }}>
      {copied ? "Alles gekopieerd ✓" : "Kopieer ALLES (voor Claude)"}
    </button>
  );
}

// Veilige JSON-afhandeling (zelfde, al eerder in dit project doorgronde les: een rauwe
// Vercel-10s-timeoutpagina i.p.v. JSON laat res.json() cryptisch crashen op Safari met
// "The string did not match the expected pattern").
async function safeJson(res: Response): Promise<{ json: unknown; rawTextIfInvalid: string | null }> {
  const rawText = await res.text();
  try {
    return { json: JSON.parse(rawText), rawTextIfInvalid: null };
  } catch {
    return { json: null, rawTextIfInvalid: rawText.slice(0, 500) };
  }
}

export default function TestToDestinationAddressFlowPage() {
  const [originPlaceName, setOriginPlaceName] = useState("Volendam");
  const [destinationPlaceName, setDestinationPlaceName] = useState("Hoorn");
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<{ naam: string; elapsedMs: number; httpStatus?: number; ok: boolean; details: unknown }[]>([]);
  const [totalElapsedMs, setTotalElapsedMs] = useState<number | null>(null);

  async function run() {
    setRunning(true);
    setSteps([]);
    setTotalElapsedMs(null);
    const tStart = Date.now();
    const collectedSteps: typeof steps = [];

    // Stap 1: herkomst
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let originData: any = null;
    {
      const t0 = Date.now();
      try {
        const res = await fetch("/api/location/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ placeName: originPlaceName, limit: 5 }),
        });
        const { json, rawTextIfInvalid } = await safeJson(res);
        const elapsedMs = Date.now() - t0;
        if (rawTextIfInvalid !== null) {
          collectedSteps.push({ naam: "1. herkomst resolven", elapsedMs, httpStatus: res.status, ok: false, details: { fout: "geen geldige JSON", rawTextIfInvalid } });
          setSteps([...collectedSteps]);
          setTotalElapsedMs(Date.now() - tStart);
          setRunning(false);
          return;
        }
        originData = json;
        collectedSteps.push({ naam: "1. herkomst resolven", elapsedMs, httpStatus: res.status, ok: res.ok, details: json });
        setSteps([...collectedSteps]);
      } catch (err) {
        collectedSteps.push({ naam: "1. herkomst resolven", elapsedMs: Date.now() - t0, ok: false, details: { fetchError: err instanceof Error ? err.message : String(err) } });
        setSteps([...collectedSteps]);
        setTotalElapsedMs(Date.now() - tStart);
        setRunning(false);
        return;
      }
    }
    if (!originData?.candidates?.length) {
      setTotalElapsedMs(Date.now() - tStart);
      setRunning(false);
      return;
    }

    // Stap 2: bestemming
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let destData: any = null;
    {
      const t0 = Date.now();
      try {
        const res = await fetch("/api/location/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ placeName: destinationPlaceName, limit: 5 }),
        });
        const { json, rawTextIfInvalid } = await safeJson(res);
        const elapsedMs = Date.now() - t0;
        if (rawTextIfInvalid !== null) {
          collectedSteps.push({ naam: "2. bestemming geocoden", elapsedMs, httpStatus: res.status, ok: false, details: { fout: "geen geldige JSON", rawTextIfInvalid } });
          setSteps([...collectedSteps]);
          setTotalElapsedMs(Date.now() - tStart);
          setRunning(false);
          return;
        }
        destData = json;
        collectedSteps.push({ naam: "2. bestemming geocoden", elapsedMs, httpStatus: res.status, ok: res.ok, details: json });
        setSteps([...collectedSteps]);
      } catch (err) {
        collectedSteps.push({ naam: "2. bestemming geocoden", elapsedMs: Date.now() - t0, ok: false, details: { fetchError: err instanceof Error ? err.message : String(err) } });
        setSteps([...collectedSteps]);
        setTotalElapsedMs(Date.now() - tStart);
        setRunning(false);
        return;
      }
    }
    if (!destData?.candidates?.length || destData.geocodedLat == null) {
      setTotalElapsedMs(Date.now() - tStart);
      setRunning(false);
      return;
    }

    // Stap 3: route berekenen -- dit is de stap die in de app zelf 504 gaf.
    {
      const t0 = Date.now();
      try {
        const res = await fetch("/api/route/to-destination", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            originCandidateNodeIds: originData.candidates.map((c: { logicalNodeId: string }) => c.logicalNodeId),
            originCandidateDistancesM: originData.candidates.map((c: { distanceM: number }) => c.distanceM),
            destinationCandidateNodeIds: destData.candidates.map((c: { logicalNodeId: string }) => c.logicalNodeId),
            destinationCandidateDistancesM: destData.candidates.map((c: { distanceM: number }) => c.distanceM),
            destinationLat: destData.geocodedLat,
            destinationLon: destData.geocodedLon,
          }),
        });
        const { json, rawTextIfInvalid } = await safeJson(res);
        const elapsedMs = Date.now() - t0;
        collectedSteps.push({
          naam: "3. route berekenen (/api/route/to-destination)",
          elapsedMs,
          httpStatus: res.status,
          ok: res.ok && rawTextIfInvalid === null,
          details: rawTextIfInvalid !== null ? { fout: "geen geldige JSON -- vrijwel zeker een Vercel-timeout", rawTextIfInvalid } : json,
        });
        setSteps([...collectedSteps]);
      } catch (err) {
        collectedSteps.push({ naam: "3. route berekenen (/api/route/to-destination)", elapsedMs: Date.now() - t0, ok: false, details: { fetchError: err instanceof Error ? err.message : String(err) } });
        setSteps([...collectedSteps]);
      }
    }

    setTotalElapsedMs(Date.now() - tStart);
    setRunning(false);
  }

  const copyText = steps.length > 0 ? JSON.stringify({ originPlaceName, destinationPlaceName, totalElapsedMs, steps }, null, 2) : "";

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Adres-flow met tijdmeting per stap</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Doorloopt exact dezelfde 3 stappen als de app (locatie zoeken -&gt; bestemming geocoden -&gt; route berekenen), met een tijdmeting per stap. Puur diagnostisch, wijzigt niets.
      </p>

      <input
        value={originPlaceName}
        onChange={(e) => setOriginPlaceName(e.target.value)}
        placeholder="herkomst (bv. Volendam)"
        style={{ width: "100%", padding: 10, fontSize: 14, border: "1px solid #ccc", borderRadius: 8, marginBottom: 8, boxSizing: "border-box" }}
      />
      <input
        value={destinationPlaceName}
        onChange={(e) => setDestinationPlaceName(e.target.value)}
        placeholder="bestemming (bv. Hoorn)"
        style={{ width: "100%", padding: 10, fontSize: 14, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12, boxSizing: "border-box" }}
      />

      <button onClick={run} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig..." : "Test nu"}
      </button>

      {totalElapsedMs !== null && (
        <p style={{ fontSize: 13, marginBottom: 8 }}>
          Totale tijd: <strong>{totalElapsedMs}ms</strong>
        </p>
      )}

      {steps.length > 0 && (
        <div style={{ fontSize: 12, marginBottom: 12 }}>
          {steps.map((s, i) => (
            <div key={i} style={{ padding: "6px 0", borderTop: "1px solid #eee" }}>
              {s.ok ? "✅" : "⚠️"} {s.naam}: <strong>{s.elapsedMs}ms</strong> {s.httpStatus ? `(HTTP ${s.httpStatus})` : ""}
            </div>
          ))}
        </div>
      )}

      {steps.length > 0 && (
        <>
          <CopyAllButton text={copyText} />
          <pre style={{ fontSize: 10, background: "#f5f5f0", padding: 8, borderRadius: 6, overflowX: "auto", whiteSpace: "pre-wrap" }}>{copyText}</pre>
        </>
      )}
    </div>
  );
}
