"use client";

import { useState } from "react";
import {
  buildValidatedCombinedGraph,
  dijkstraWithCostModel,
  makeCostFn,
  type SlimNwbSegment,
  type ValidatedConnectorInput,
  type CombinedGraph,
} from "@/lib/nwb-analysis/combined-graph";
import { generateConnectorCandidates, type GoKnoopNodeInput } from "@/lib/nwb-analysis/connector-candidates";
import type { GraphProvider, GraphNode, GraphEdge } from "@/lib/route-engine/types";

/** Zelfde client-side adapter als Fase 4. */
class ClientGraphProvider implements GraphProvider {
  private nodeMap = new Map<string, { id: string; x: number; y: number; displayNumber: string | null }>();
  private edgesByNode = new Map<string, GraphEdge[]>();
  constructor(nodes: { id: string; x: number; y: number; displayNumber: string | null }[], edges: { id: string; from: string; to: string; distanceM: number }[]) {
    for (const n of nodes) this.nodeMap.set(n.id, n);
    for (const e of edges) {
      const edge: GraphEdge = { id: e.id, fromLogicalNodeId: e.from, toLogicalNodeId: e.to, distanceM: e.distanceM, directionality: "unknown", geometry: [] };
      if (!this.edgesByNode.has(e.from)) this.edgesByNode.set(e.from, []);
      this.edgesByNode.get(e.from)!.push(edge);
      if (!this.edgesByNode.has(e.to)) this.edgesByNode.set(e.to, []);
      this.edgesByNode.get(e.to)!.push(edge);
    }
  }
  async load() {}
  getNode(id: string): GraphNode | undefined {
    const n = this.nodeMap.get(id);
    return n ? ({ id: n.id, x: n.x, y: n.y, displayNumber: n.displayNumber ?? undefined } as GraphNode) : undefined;
  }
  getAllNodeIds(): string[] {
    return Array.from(this.nodeMap.keys());
  }
  getEdgesFrom(id: string): GraphEdge[] {
    return this.edgesByNode.get(id) || [];
  }
  rawCoords(id: string) {
    return this.nodeMap.get(id);
  }
}

// Fase 5B: verfijnde reeks rond de eerder gevonden 1,15-1,30-zone, zoals gevraagd.
const F_NWB_SWEEP = [1.1, 1.15, 1.2, 1.25, 1.3, 1.4, 1.5];
const F_CONNECTOR_VARIANTS = [1.0]; // Fase 5 toonde al dat connectorkosten nauwelijks effect hebben -- hier bewust niet herhaald, om de sweep snel te houden

// 24 ECHTE, al-bekende knooppunt-ID's uit de eerdere visuele-validatiesteekproef
// (Fase 3) -- geen nieuwe dataverzameling nodig. 8 paren per regio, mix van
// korte en langere afstanden. Niet vooraf gelabeld als "goed"/"gat"/"gelijk" --
// dat bepaalt de meting zelf, niet een aanname vooraf.
const REGIONS: Record<string, { label: string; pairs: { name: string; from: string; to: string }[] }> = {
  hilversum: {
    label: "Amsterdam <-> Hilversum (Gooi/Noord-Holland)",
    pairs: [
      { name: "h1", from: "0UI2zsv34ka6D657V04J", to: "609ZZjTtmvsbsONm8At1" },
      { name: "h2", from: "CrGOciNbJJSPaz5dcvcC", to: "kdjFT4uM78oPkaxHymyQ" },
      { name: "h3", from: "MQAnNb1IMego7dnVPXpS", to: "US9yrmEO1tUjlQveJut0" },
      { name: "h4", from: "Qp3eBqEgYTSrDfdV0z4W", to: "tkY9O14LqiOtxsZ8GTPz" },
      { name: "h5", from: "dCu273Zm0fy8oZcQHMbd", to: "pR2n6KWgtHLRPwvkUmZ8" },
      { name: "h6", from: "CJSXBPUMG49vOPmYvhJd", to: "MQAnNb1IMego7dnVPXpS" },
      { name: "h7", from: "0UI2zsv34ka6D657V04J", to: "CrGOciNbJJSPaz5dcvcC" },
      { name: "h8", from: "609ZZjTtmvsbsONm8At1", to: "dCu273Zm0fy8oZcQHMbd" },
    ],
  },
  lochem: {
    label: "Lochem / Achterhoek",
    pairs: [
      { name: "l1", from: "0pgYw2kgDphP2IT1RAi7", to: "61aNR7RWLxQhHTOfMHtm" },
      { name: "l2", from: "9GsDbaxRKR3SKA6rMkiq", to: "J4UhJPLZfZGQ38dbhALM" },
      { name: "l3", from: "CDdOFbRpdb959FzzPLc0", to: "WDsLzusuMQzU8aBk43mq" },
      { name: "l4", from: "WQ1CZAUn96pMGxPcHHVu", to: "h8FdTXd9M80jRHoYX4do" },
      { name: "l5", from: "umaP8hitTyqe6H6mhhWM", to: "0pgYw2kgDphP2IT1RAi7" },
      { name: "l6", from: "9cdQ8xUK4u2DFybtRTfg", to: "J4UhJPLZfZGQ38dbhALM" },
      { name: "l7", from: "bR0u430Tm1qT6yHBUU4k", to: "WDsLzusuMQzU8aBk43mq" },
      { name: "l8", from: "DULwi9RMia4vV4Wbdc2a", to: "h8FdTXd9M80jRHoYX4do" },
    ],
  },
  volendam: {
    label: "Volendam / Edam / Purmerend",
    pairs: [
      { name: "v1", from: "3Sx24AWzdYTR4Psx0JJW", to: "AG9myGNbdE6eH0W2SUmi" },
      { name: "v2", from: "KYgN1n5FB93kHhu0D2MU", to: "Sxnbzx2IVYDbopuJM7u9" },
      { name: "v3", from: "ZYvQlRuGXufA9ewLFhpL", to: "hByks0xWrsp3uOfyGT4u" },
      { name: "v4", from: "nKfPyXuKA5e2SMxiKON3", to: "pR2n6KWgtHLRPwvkUmZ8" },
      { name: "v5", from: "CJSXBPUMG49vOPmYvhJd", to: "KYgN1n5FB93kHhu0D2MU" },
      { name: "v6", from: "7fmSWIHYsKu3Wb3yOtM2", to: "ZYvQlRuGXufA9ewLFhpL" },
      { name: "v7", from: "AG9myGNbdE6eH0W2SUmi", to: "nKfPyXuKA5e2SMxiKON3" },
      { name: "v8", from: "3Sx24AWzdYTR4Psx0JJW", to: "hByks0xWrsp3uOfyGT4u" },
    ],
  },
};

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

export default function Fase5CostModelResearchPage() {
  const [datasetVersionId, setDatasetVersionId] = useState("uINZ3y2QsgBdEyky3duq");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);

  function getKey() {
    return window.localStorage.getItem("goknoop_debug_secret") || "";
  }

  async function runAll() {
    setRunning(true);
    setLog([]);
    setReport(null);
    const key = getKey();

    setLog((prev) => [...prev, "Volledige GoKnoop-graaf ophalen..."]);
    let provider: ClientGraphProvider;
    try {
      const params = new URLSearchParams({ datasetVersionId });
      if (key) params.set("key", key);
      const res = await fetch(`/api/debug/fase4-goknoop-full-graph?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setLog((prev) => [...prev, `⚠️ ${json.details ?? json.error}`]);
        setRunning(false);
        return;
      }
      provider = new ClientGraphProvider(json.nodes, json.edges);
      setLog((prev) => [...prev, `GoKnoop-graaf: ${json.nodeCount} nodes.`]);
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ ${err instanceof Error ? err.message : String(err)}`]);
      setRunning(false);
      return;
    }

    const allResults: Record<string, unknown> = {};

    for (const [regionKey, region] of Object.entries(REGIONS)) {
      setLog((prev) => [...prev, `--- ${regionKey}: data laden + graaf bouwen ---`]);

      const segmentsById = new Map<string, SlimNwbSegment>();
      let offset = 0;
      for (;;) {
        try {
          const params = new URLSearchParams({ region: regionKey, offset: String(offset) });
          if (key) params.set("key", key);
          const res = await fetch(`/api/debug/nwb-collector-read-tiles?${params.toString()}`, { cache: "no-store" });
          const json = await res.json();
          if (!res.ok) break;
          for (const seg of json.segments as SlimNwbSegment[]) segmentsById.set(seg.id, seg);
          if (json.done) break;
          offset += json.tilesInPage;
        } catch {
          break;
        }
      }
      const nwbSegments = Array.from(segmentsById.values());

      let goknoopBearingNodes: GoKnoopNodeInput[] = [];
      try {
        const params = new URLSearchParams({ region: regionKey, datasetVersionId });
        if (key) params.set("key", key);
        const res = await fetch(`/api/debug/nwb-collector-goknoop-bearings?${params.toString()}`, { cache: "no-store" });
        const json = await res.json();
        if (res.ok) goknoopBearingNodes = json.nodes;
      } catch {
        /* val terug op lege lijst -- connectorgeneratie levert dan 0 op, zichtbaar in de output */
      }

      await new Promise((r) => setTimeout(r, 20));
      const candidateResult = generateConnectorCandidates(goknoopBearingNodes, nwbSegments, 20);
      const validatedConnectors: ValidatedConnectorInput[] = candidateResult.candidates
        .filter((c) => c.confidence !== "rejected")
        .map((c) => ({ goknoopNodeId: c.goknoopNodeId, nwbSegmentId: c.nwbSegmentId, nwbEndpoint: c.nwbEndpoint, distanceM: c.distanceM, confidence: c.confidence as "high" | "lower" }));

      const combined: CombinedGraph = buildValidatedCombinedGraph(provider, nwbSegments, 20, validatedConnectors);
      setLog((prev) => [...prev, `${regionKey}: graaf klaar (${validatedConnectors.length} connectoren). F-sweep starten...`]);
      await new Promise((r) => setTimeout(r, 20));

      const regionResult: Record<string, unknown> = {};

      for (const pair of region.pairs) {
        const fromNode = provider.rawCoords(pair.from);
        const toNode = provider.rawCoords(pair.to);
        const straightLineM = fromNode && toNode ? Math.hypot(toNode.x - fromNode.x, toNode.y - fromNode.y) : null;

        // Hoofd-sweep: F_nwb varieert, F_connector vast op 1.0 (neutraal).
        const sweepResults: Record<string, unknown> = {};
        let firstGoknoopUsageF: number | null = null;
        let firstNwbZeroF: number | null = null;
        let baselineDistanceM: number | null = null;

        for (const fNwb of F_NWB_SWEEP) {
          const result = dijkstraWithCostModel(combined, pair.from, pair.to, makeCostFn(fNwb, 1.0));
          if (!result.found) {
            sweepResults[`F=${fNwb}`] = { routeFound: false };
            continue;
          }
          if (fNwb === 1.0) baselineDistanceM = result.distanceM;
          if (firstGoknoopUsageF === null && result.goknoopEdgeCount > 0) firstGoknoopUsageF = fNwb;
          if (firstNwbZeroF === null && result.nwbEdgeCount === 0) firstNwbZeroF = fNwb;

          const totalEdges = result.goknoopEdgeCount + result.nwbEdgeCount + result.connectorCount;
          sweepResults[`F=${fNwb}`] = {
            routeFound: true,
            distanceM: Math.round(result.distanceM),
            deviationFactor: straightLineM ? Math.round((result.distanceM / straightLineM) * 100) / 100 : null,
            goknoopEdgeCount: result.goknoopEdgeCount,
            nwbEdgeCount: result.nwbEdgeCount,
            connectorCount: result.connectorCount,
            goknoopAandeel: totalEdges > 0 ? Math.round((result.goknoopEdgeCount / totalEdges) * 1000) / 1000 : 0,
            nwbAandeel: totalEdges > 0 ? Math.round((result.nwbEdgeCount / totalEdges) * 1000) / 1000 : 0,
            goknoopDistanceM: Math.round(result.goknoopDistanceM),
            nwbDistanceM: Math.round(result.nwbDistanceM),
            connectorDistanceM: Math.round(result.connectorDistanceM),
            totalHops: result.goknoopEdgeCount + result.nwbEdgeCount + result.connectorCount,
            afstandVsBaselineRatio: baselineDistanceM ? Math.round((result.distanceM / baselineDistanceM) * 100) / 100 : 1,
          };
        }

        // Connector-kostenvariant, getest bij F_nwb=1.0 (baseline) en bij het eerste omslagpunt (indien gevonden).
        const connectorVariantResults: Record<string, unknown> = {};
        const connectorTestFNwb = [1.0, firstGoknoopUsageF ?? F_NWB_SWEEP[F_NWB_SWEEP.length - 1]];
        for (const fNwb of connectorTestFNwb) {
          for (const fConn of F_CONNECTOR_VARIANTS) {
            const result = dijkstraWithCostModel(combined, pair.from, pair.to, makeCostFn(fNwb, fConn));
            connectorVariantResults[`Fnwb=${fNwb}_Fconn=${fConn}`] = result.found
              ? { routeFound: true, distanceM: Math.round(result.distanceM), connectorCount: result.connectorCount, goknoopEdgeCount: result.goknoopEdgeCount, nwbEdgeCount: result.nwbEdgeCount }
              : { routeFound: false };
          }
        }

        regionResult[pair.name] = {
          straightLineM: straightLineM ? Math.round(straightLineM) : null,
          omslagpunten: {
            eersteFWaarGoKnoopWordtGebruikt: firstGoknoopUsageF,
            eersteFWaarNwbHelemaalNietMeerGebruiktWordt: firstNwbZeroF,
          },
          fNwbSweep: sweepResults,
          connectorKostenVarianten: connectorVariantResults,
        };
      }

      allResults[regionKey] = regionResult;
      setLog((prev) => [...prev, `✅ ${regionKey}: klaar.`]);
    }

    setReport(allResults);
    setLog((prev) => [...prev, "Alle regio's + F-sweeps klaar. Aggregatie berekenen..."]);

    // Aggregatie over ALLE paren samen, per F-waarde -- dit is wat het
    // mogelijk maakt om iets te zeggen over "is de zone stabiel", in plaats
    // van 24 aparte tabellen te moeten vergelijken.
    const aggregation: Record<string, { gemGoknoopAandeel: number; gemDeviationFactor: number; gemAfstandRatio: number; aantalMetGoknoop: number; aantalZonderNwb: number; aantalDuurderDan1_3x: number; totaalParen: number }> = {};
    for (const fNwb of F_NWB_SWEEP) {
      const key = `F=${fNwb}`;
      let sumGoknoopAandeel = 0;
      let sumDeviation = 0;
      let sumRatio = 0;
      let count = 0;
      let metGoknoop = 0;
      let zonderNwb = 0;
      let duurderDan1_3x = 0;

      for (const regionResult of Object.values(allResults)) {
        for (const pairResult of Object.values(regionResult as Record<string, unknown>)) {
          const sweep = (pairResult as { fNwbSweep: Record<string, Record<string, unknown>> }).fNwbSweep;
          const entry = sweep[key];
          if (!entry || entry.routeFound !== true) continue;
          count++;
          sumGoknoopAandeel += entry.goknoopAandeel as number;
          sumDeviation += entry.deviationFactor as number;
          sumRatio += entry.afstandVsBaselineRatio as number;
          if ((entry.goknoopEdgeCount as number) > 0) metGoknoop++;
          if ((entry.nwbEdgeCount as number) === 0) zonderNwb++;
          if ((entry.afstandVsBaselineRatio as number) > 1.3) duurderDan1_3x++;
        }
      }

      aggregation[key] = {
        gemGoknoopAandeel: count > 0 ? Math.round((sumGoknoopAandeel / count) * 1000) / 1000 : 0,
        gemDeviationFactor: count > 0 ? Math.round((sumDeviation / count) * 100) / 100 : 0,
        gemAfstandRatio: count > 0 ? Math.round((sumRatio / count) * 100) / 100 : 0,
        aantalMetGoknoop: metGoknoop,
        aantalZonderNwb: zonderNwb,
        aantalDuurderDan1_3x: duurderDan1_3x,
        totaalParen: count,
      };
    }

    setReport({ AGGREGATIE_OVER_ALLE_24_PAREN: aggregation, perParenDetail: allResults });
    setLog((prev) => [...prev, "Aggregatie klaar."]);
    setRunning(false);
  }

  const copyText = report ? JSON.stringify(report, null, 2) : "";

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Fase 5B — Kalibratieronde (24 paren)</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Verfijnde F-reeks (1,10-1,50) over 24 echte routeparen, verspreid over drie regio's -- toetst of de eerder gevonden 1,15-1,30-zone stabiel blijft, niet gebaseerd op slechts 5 paren.
      </p>

      <input value={datasetVersionId} onChange={(e) => setDatasetVersionId(e.target.value)} placeholder="datasetVersionId" style={{ width: "100%", padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12 }} />

      <button onClick={runAll} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig... (kan een minuut duren)" : "Start Fase 5-onderzoek"}
      </button>

      {log.length > 0 && (
        <div style={{ fontSize: 11, background: "#f0f0eb", padding: 10, borderRadius: 8, marginBottom: 12, maxHeight: 200, overflowY: "auto" }}>
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}

      {report && (
        <>
          <CopyAllButton text={copyText} />
          <pre style={{ fontSize: 9, background: "#f5f5f0", padding: 8, borderRadius: 6, overflowX: "auto", whiteSpace: "pre-wrap" }}>{copyText}</pre>
        </>
      )}
    </div>
  );
}
