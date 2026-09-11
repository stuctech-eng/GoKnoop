"use client";

import { useState } from "react";

type StoredSegment = { id: string; fromClusterId?: string; toClusterId?: string; [key: string]: unknown };
type ComputedAssignment = { f: string; t: string };

export default function CompareClusteringRunnerPage() {
  const [key, setKey] = useState(() => (typeof window !== "undefined" ? window.localStorage.getItem("goknoop_debug_secret") || "" : ""));
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<Record<string, unknown> | null>(null);
  const [log, setLog] = useState<string[]>([]);

  async function run() {
    setRunning(true);
    setOutput(null);
    setLog([]);
    try {
      const params = new URLSearchParams();
      if (key) params.set("key", key);

      setLog((prev) => [...prev, "Stap 1: opgeslagen segmenten ophalen (met opgeslagen fromClusterId/toClusterId)..."]);
      const segRes = await fetch(`/api/admin/read-active-nwb-segments?${params.toString()}`, { cache: "no-store" });
      const segJson = await segRes.json();
      if (!segRes.ok) {
        setLog((prev) => [...prev, `⚠️ ${segJson.details ?? segJson.error}`]);
        setRunning(false);
        return;
      }
      const storedSegments: StoredSegment[] = segJson.segments;
      setLog((prev) => [...prev, `Klaar: ${storedSegments.length} segmenten opgehaald.`]);

      setLog((prev) => [...prev, "Stap 2: live herclusteren (los eindpunt, geen Firestore-lezen daar)..."]);
      // Strip de opgeslagen cluster-ID's vóór het versturen, zodat het clustering-endpoint
      // gegarandeerd vers rekent, niet per ongeluk kopieert.
      const rawForClustering = storedSegments.map(({ fromClusterId: _f, toClusterId: _t, ...rest }) => rest);
      const clusterRes = await fetch(`/api/admin/cluster-only?${params.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments: rawForClustering }),
      });
      const clusterJson = await clusterRes.json();
      if (!clusterRes.ok) {
        setLog((prev) => [...prev, `⚠️ ${clusterJson.details ?? clusterJson.error}`]);
        setRunning(false);
        return;
      }
      setLog((prev) => [...prev, `Klaar: live clustering in ${clusterJson.computeTimeMs}ms, ${clusterJson.uniqueClusterCount} unieke clusters.`]);

      const computed: Record<string, ComputedAssignment> = clusterJson.assignments;

      // Fase 2: GROEPERING vergelijken (niet letterlijke labels -- die zijn willekeurig
      // tussen twee onafhankelijke union-find-runs). Bouw een bijectie-check: elke
      // opgeslagen cluster-ID moet naar PRECIES ÉÉN berekende cluster-ID wijzen, en vice versa.
      setLog((prev) => [...prev, "Stap 3: groepering vergelijken (bijectie-check)..."]);

      const storedToComputedFrom = new Map<string, Set<string>>();
      const computedToStoredFrom = new Map<string, Set<string>>();
      const storedToComputedTo = new Map<string, Set<string>>();
      const computedToStoredTo = new Map<string, Set<string>>();

      let totalCompared = 0;
      let missingComputed = 0;
      const differenceExamples: Record<string, unknown>[] = [];

      for (const seg of storedSegments) {
        const comp = computed[seg.id];
        if (!comp) {
          missingComputed++;
          continue;
        }
        if (!seg.fromClusterId || !seg.toClusterId) continue;
        totalCompared++;

        if (!storedToComputedFrom.has(seg.fromClusterId)) storedToComputedFrom.set(seg.fromClusterId, new Set());
        storedToComputedFrom.get(seg.fromClusterId)!.add(comp.f);
        if (!computedToStoredFrom.has(comp.f)) computedToStoredFrom.set(comp.f, new Set());
        computedToStoredFrom.get(comp.f)!.add(seg.fromClusterId);

        if (!storedToComputedTo.has(seg.toClusterId)) storedToComputedTo.set(seg.toClusterId, new Set());
        storedToComputedTo.get(seg.toClusterId)!.add(comp.t);
        if (!computedToStoredTo.has(comp.t)) computedToStoredTo.set(comp.t, new Set());
        computedToStoredTo.get(comp.t)!.add(seg.toClusterId);
      }

      function countNonBijective(map: Map<string, Set<string>>): number {
        let count = 0;
        for (const set of map.values()) if (set.size > 1) count++;
        return count;
      }

      const storedFromSplits = countNonBijective(storedToComputedFrom); // 1 opgeslagen cluster -> meerdere berekende (opgeslagen versie SPLITST wat live SAMENVOEGT)
      const computedFromSplits = countNonBijective(computedToStoredFrom); // 1 berekende cluster -> meerdere opgeslagen (opgeslagen versie VOEGT SAMEN wat live SPLITST)
      const storedToSplits = countNonBijective(storedToComputedTo);
      const computedToSplits = countNonBijective(computedToStoredTo);

      // Concrete voorbeelden verzamelen van niet-bijectieve gevallen (echte afwijkingen).
      for (const [storedId, computedSet] of storedToComputedFrom) {
        if (computedSet.size > 1 && differenceExamples.length < 20) {
          differenceExamples.push({ type: "storedFrom_splits_into_multiple_computed", storedClusterId: storedId, computedClusterIds: Array.from(computedSet) });
        }
      }
      for (const [computedId, storedSet] of computedToStoredFrom) {
        if (storedSet.size > 1 && differenceExamples.length < 20) {
          differenceExamples.push({ type: "computedFrom_splits_into_multiple_stored", computedClusterId: computedId, storedClusterIds: Array.from(storedSet) });
        }
      }

      const isEquivalent = storedFromSplits === 0 && computedFromSplits === 0 && storedToSplits === 0 && computedToSplits === 0;

      const result = {
        segmentCount: storedSegments.length,
        totalCompared,
        missingComputed,
        storedUniqueClusters: new Set(storedSegments.flatMap((s) => [s.fromClusterId, s.toClusterId]).filter(Boolean)).size,
        computedUniqueClusters: clusterJson.uniqueClusterCount,
        bijectieCheck: {
          isEquivalent,
          storedFromSplitsIntoMultipleComputed: storedFromSplits,
          computedFromSplitsIntoMultipleStored: computedFromSplits,
          storedToSplitsIntoMultipleComputed: storedToSplits,
          computedToSplitsIntoMultipleStored: computedToSplits,
        },
        differenceExamples,
      };

      setOutput(result);
      setLog((prev) => [...prev, isEquivalent ? "✅ BEWEZEN: opgeslagen en live clustering zijn equivalent (zelfde groepering, andere labels)." : "⚠️ NIET EQUIVALENT: opgeslagen en live clustering groeperen anders."]);
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ ${err instanceof Error ? err.message : String(err)}`]);
    }
    setRunning(false);
  }

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Clustering vergelijken (opgeslagen vs. live)</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Fase 1+2 van het uitvoeringsplan. Vergelijkt GROEPERING (niet letterlijke labels -- die zijn willekeurig tussen twee onafhankelijke
        union-find-runs) via een bijectie-check.
      </p>

      <input
        type="text"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="DEBUG_SECRET"
        style={{ width: "100%", padding: 10, fontSize: 14, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12 }}
      />

      <button onClick={run} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig..." : "Vergelijk clustering"}
      </button>

      <pre style={{ fontSize: 11, background: "#f5f5f0", padding: 8, borderRadius: 6, marginBottom: 12, whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>

      {output && (
        <pre style={{ fontSize: 11, background: "#eef", padding: 8, borderRadius: 6, maxHeight: 500, overflowY: "auto", whiteSpace: "pre-wrap" }}>
          {JSON.stringify(output, null, 2)}
        </pre>
      )}
    </div>
  );
}
