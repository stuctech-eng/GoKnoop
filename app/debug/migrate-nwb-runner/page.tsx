"use client";

import { useState } from "react";
import type { SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

const REGIONS = ["hilversum", "lochem", "volendam"];
const MIGRATE_CHUNK_SIZE = 400;

export default function MigrateNwbRunnerPage() {
  const [datasetVersionId, setDatasetVersionId] = useState("uINZ3y2QsgBdEyky3duq");
  const [nwbDatasetVersionId, setNwbDatasetVersionId] = useState(`nwb-${new Date().toISOString().slice(0, 10)}-v1`);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [migrationDone, setMigrationDone] = useState(false);

  function getKey() {
    return window.localStorage.getItem("goknoop_debug_secret") || "";
  }

  async function runMigration() {
    setRunning(true);
    setLog([]);
    setMigrationDone(false);
    const key = getKey();

    // Stap 1: alle drie regio's lezen uit de onderzoeks-collectie (nwbResearchTiles), gededupliceerd.
    const segmentsById = new Map<string, SlimNwbSegment>();
    for (const region of REGIONS) {
      setLog((prev) => [...prev, `--- ${region}: onderzoeksdata lezen ---`]);
      let offset = 0;
      for (;;) {
        try {
          const params = new URLSearchParams({ region, offset: String(offset) });
          if (key) params.set("key", key);
          const res = await fetch(`/api/debug/nwb-collector-read-tiles?${params.toString()}`, { cache: "no-store" });
          const json = await res.json();
          if (!res.ok) {
            setLog((prev) => [...prev, `⚠️ ${region}: ${json.details ?? json.error}`]);
            setRunning(false);
            return;
          }
          for (const seg of json.segments as SlimNwbSegment[]) segmentsById.set(seg.id, seg);
          if (json.done) break;
          offset += json.tilesInPage;
        } catch (err) {
          setLog((prev) => [...prev, `⚠️ ${region}: ${err instanceof Error ? err.message : String(err)}`]);
          setRunning(false);
          return;
        }
      }
      setLog((prev) => [...prev, `${region}: klaar, totaal uniek zover ${segmentsById.size}.`]);
    }

    const allSegments = Array.from(segmentsById.values());
    setLog((prev) => [...prev, `Alle regio's gelezen: ${allSegments.length} unieke segmenten totaal. Migreren naar productieschema...`]);

    // Stap 2: in chunks naar het productieschema schrijven.
    let migratedCount = 0;
    for (let i = 0; i < allSegments.length; i += MIGRATE_CHUNK_SIZE) {
      const chunk = allSegments.slice(i, i + MIGRATE_CHUNK_SIZE);
      const isFirstChunk = i === 0;
      try {
        const params = new URLSearchParams();
        if (key) params.set("key", key);
        const res = await fetch(`/api/admin/migrate-nwb-to-production?${params.toString()}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nwbDatasetVersionId,
            segments: chunk,
            isFirstChunk,
            metadata: isFirstChunk
              ? {
                  bron: "PDOK WFS, service.pdok.nl/rws/nwbwegen (via onderzoeks-collectie nwbResearchTiles gemigreerd, geen nieuwe PDOK-aanroepen)",
                  licentie: "CC0",
                  regios: REGIONS,
                  opgehaaldOp: new Date().toISOString(),
                }
              : undefined,
          }),
        });
        const json = await res.json();
        if (!res.ok) {
          setLog((prev) => [...prev, `⚠️ Chunk ${i}-${i + chunk.length}: ${json.details ?? json.error}`]);
          setRunning(false);
          return;
        }
        migratedCount += json.segmentsGeschreven;
        setLog((prev) => [...prev, `Chunk ${i}-${i + chunk.length} gemigreerd (${migratedCount}/${allSegments.length} totaal).`]);
      } catch (err) {
        setLog((prev) => [...prev, `⚠️ Chunk ${i}: ${err instanceof Error ? err.message : String(err)}`]);
        setRunning(false);
        return;
      }
    }

    setLog((prev) => [...prev, `✅ Migratie compleet: ${migratedCount} segmenten in nwbDatasetVersions/${nwbDatasetVersionId}. NOG NIET geactiveerd.`]);
    setMigrationDone(true);
    setRunning(false);
  }

  async function activate() {
    setRunning(true);
    const key = getKey();
    try {
      const params = new URLSearchParams();
      if (key) params.set("key", key);
      const res = await fetch(`/api/admin/activate-nwb-dataset?${params.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nwbDatasetVersionId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setLog((prev) => [...prev, `⚠️ Activatie: ${json.details ?? json.error}`]);
      } else {
        setLog((prev) => [...prev, `✅ GEACTIVEERD: ${json.message}`]);
      }
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ Activatie: ${err instanceof Error ? err.message : String(err)}`]);
    }
    setRunning(false);
  }

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>NWB → Productie migreren</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Fase F (technische uitvoering). Migreert de al-verzamelde onderzoeksdata (3 regio's) naar het productieschema. Geen nieuwe PDOK-aanroepen. Activeren is een aparte stap.
      </p>

      <input value={datasetVersionId} onChange={(e) => setDatasetVersionId(e.target.value)} placeholder="GoKnoop datasetVersionId" style={{ width: "100%", padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8, marginBottom: 8 }} />
      <input value={nwbDatasetVersionId} onChange={(e) => setNwbDatasetVersionId(e.target.value)} placeholder="Nieuwe nwbDatasetVersionId" style={{ width: "100%", padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12 }} />

      <button onClick={runMigration} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig..." : "1. Migreer data (nog niet live)"}
      </button>

      {migrationDone && (
        <button onClick={activate} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#c00", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
          2. ACTIVEER — zet live voor /api/route/combined
        </button>
      )}

      {log.length > 0 && (
        <div style={{ fontSize: 11, background: "#f0f0eb", padding: 10, borderRadius: 8, maxHeight: 300, overflowY: "auto" }}>
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}
