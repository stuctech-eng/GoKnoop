"use client";

import { useState } from "react";

const NODE_BATCH_SIZE = 500;
const EDGE_BATCH_SIZE = 1000; // nu topologie-only (geen coords), dus veel groter mogelijk dan eerst

export default function MigrateGoknoopBatchedRunnerPage() {
  const [datasetVersionId, setDatasetVersionId] = useState("uINZ3y2QsgBdEyky3duq");
  const [key, setKey] = useState(() => (typeof window !== "undefined" ? window.localStorage.getItem("goknoop_debug_secret") || "" : ""));
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  async function readAll(kind: "nodes" | "edges"): Promise<Record<string, unknown>[]> {
    let items: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    for (;;) {
      const params = new URLSearchParams({ datasetVersionId, kind });
      if (cursor) params.set("cursor", cursor);
      if (key) params.set("key", key);
      const res = await fetch(`/api/admin/read-goknoop-nodes-edges?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.details ?? json.error);
      items = items.concat(json.items); // GEEN spread-operator -- zelfde stack-overflow-les als eerder vandaag
      setLog((prev) => [...prev, `${kind}: ${items.length} gelezen zover...`]);
      if (json.done) break;
      cursor = json.nextCursor;
    }
    return items;
  }

  async function writeBatches(kind: "nodes" | "edges", items: Record<string, unknown>[], batchSize: number) {
    for (let i = 0; i < items.length; i += batchSize) {
      const chunk = items.slice(i, i + batchSize);
      const batchIndex = i / batchSize;
      const params = new URLSearchParams();
      if (key) params.set("key", key);
      const res = await fetch(`/api/admin/migrate-goknoop-batched?${params.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetVersionId, kind, batchIndex, items: chunk }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.details ?? json.error);
      setLog((prev) => [...prev, `${kind}: batch ${batchIndex} opgeslagen (${chunk.length} items)`]);
    }
  }

  async function run() {
    setRunning(true);
    setLog([]);
    try {
      setLog((prev) => [...prev, "Nodes lezen..."]);
      const nodes = await readAll("nodes");
      setLog((prev) => [...prev, `Klaar: ${nodes.length} nodes. Wegschrijven in gebatcht formaat...`]);
      await writeBatches("nodes", nodes, NODE_BATCH_SIZE);

      setLog((prev) => [...prev, "Edges lezen..."]);
      const edgesRaw = await readAll("edges");
      // TOPOLOGIE-ONLY: coords eruit strippen vóór het wegschrijven. Dijkstra heeft
      // alleen from/to/distanceM nodig -- geometrie wordt straks apart, on-demand
      // opgehaald voor uitsluitend de edges in de uiteindelijk gekozen route (live
      // gemeten: 78 edge-batch-documenten MET coords kostte 6,2s -- veel te traag
      // voor de bulk-graafopbouw die bij elke aanvraag gebeurt).
      const edges = edgesRaw.map(({ coords: _coords, ...topology }) => topology);
      setLog((prev) => [...prev, `Klaar: ${edges.length} edges (topologie-only, coords gestript). Wegschrijven in gebatcht formaat...`]);
      await writeBatches("edges", edges, EDGE_BATCH_SIZE);

      setLog((prev) => [...prev, "✅ Volledig klaar. Originele logicalNodes/edges-collecties zijn ongewijzigd."]);
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ ${err instanceof Error ? err.message : String(err)}`]);
    }
    setRunning(false);
  }

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>GoKnoop → gebatcht opslagformaat</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Fase M6/M7. Migreert de bestaande, LOSSE logicalNodes/edges-documenten (11.003 + ~15.495, live gemeten: 11,2s om te laden -- boven de 10s-limiet)
        naar een gebatcht formaat. Raakt de originele collecties niet aan.
      </p>

      <input
        type="text"
        value={datasetVersionId}
        onChange={(e) => setDatasetVersionId(e.target.value)}
        placeholder="datasetVersionId"
        style={{ width: "100%", padding: 10, fontSize: 14, border: "1px solid #ccc", borderRadius: 8, marginBottom: 8 }}
      />
      <input
        type="text"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="DEBUG_SECRET (optioneel als al ingesteld via /debug/instellingen)"
        style={{ width: "100%", padding: 10, fontSize: 14, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12 }}
      />

      <button onClick={run} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig..." : "Migreer naar gebatcht formaat"}
      </button>

      <pre style={{ fontSize: 11, background: "#f5f5f0", padding: 8, borderRadius: 6, maxHeight: 400, overflowY: "auto", whiteSpace: "pre-wrap" }}>
        {log.join("\n")}
      </pre>
    </div>
  );
}
