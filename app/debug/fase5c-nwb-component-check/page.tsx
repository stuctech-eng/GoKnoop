"use client";

import { useState } from "react";
import { buildValidatedCombinedGraph, computeConnectedComponents, dijkstraOnCombinedGraph, type SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";
import { rdToWgs84 } from "@/lib/route-engine/coordinate-transform";
import type { GraphProvider, GraphNode, GraphEdge } from "@/lib/route-engine/types";

const REGION = "volendam";
// De twee connector-NWB-knopen uit de vorige analyse (v1: 3Sx24A -> AG9myG).
const CONNECTOR_1_NWB_NODE_ID = "nwb:wegvakken.07bf7b0f-370d-4f27-bfe4-be8a4817e15b:to";
const CONNECTOR_3_NWB_NODE_ID = "nwb:wegvakken.a03e1813-1fce-4be7-9d18-3d984935faea:to";

/** Lege GraphProvider (0 GoKnoop-nodes) -- gebruikt om buildValidatedCombinedGraph
 * een PURE NWB-only-graaf te laten opleveren, met hergebruik van dezelfde,
 * al-geteste clustering-logica (geen nieuwe code voor NWB-connectiviteit nodig). */
class EmptyGraphProvider implements GraphProvider {
  async load() {}
  getNode(): GraphNode | undefined {
    return undefined;
  }
  getAllNodeIds(): string[] {
    return [];
  }
  getEdgesFrom(): GraphEdge[] {
    return [];
  }
}

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

export default function Fase5cNwbComponentCheckPage() {
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);

  function getKey() {
    return window.localStorage.getItem("goknoop_debug_secret") || "";
  }

  async function run() {
    setRunning(true);
    setLog([]);
    setReport(null);
    const key = getKey();

    setLog((prev) => [...prev, "Volendam NWB-tegels lezen..."]);
    const segmentsById = new Map<string, SlimNwbSegment>();
    let offset = 0;
    for (;;) {
      try {
        const params = new URLSearchParams({ region: REGION, offset: String(offset) });
        if (key) params.set("key", key);
        const res = await fetch(`/api/debug/nwb-collector-read-tiles?${params.toString()}`, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok) {
          setLog((prev) => [...prev, `⚠️ ${json.details ?? json.error}`]);
          setRunning(false);
          return;
        }
        for (const seg of json.segments as SlimNwbSegment[]) segmentsById.set(seg.id, seg);
        if (json.done) break;
        offset += json.tilesInPage;
      } catch (err) {
        setLog((prev) => [...prev, `⚠️ ${err instanceof Error ? err.message : String(err)}`]);
        setRunning(false);
        return;
      }
    }
    const nwbSegments = Array.from(segmentsById.values());
    setLog((prev) => [...prev, `${nwbSegments.length} NWB-segmenten gelezen. Pure NWB-only-graaf bouwen (lege GoKnoop-provider)...`]);

    await new Promise((r) => setTimeout(r, 20));
    const emptyProvider = new EmptyGraphProvider();
    const nwbOnlyGraph = await buildValidatedCombinedGraph(emptyProvider, nwbSegments, 20, []);
    const componentStats = computeConnectedComponents(nwbOnlyGraph);
    setLog((prev) => [...prev, `NWB-only-graaf: ${componentStats.totalNodes} clusterknopen, ${componentStats.componentCount} componenten.`]);

    function analyzeCluster(nodeId: string) {
      const root = componentStats.componentOfNode.get(nodeId);
      const pos = nwbOnlyGraph.nodePosition.get(nodeId);
      let nodeCount = 0;
      const memberIds = new Set<string>();
      for (const [id, r] of componentStats.componentOfNode.entries()) {
        if (r === root) {
          nodeCount++;
          memberIds.add(id);
        }
      }
      let edgeCount = 0;
      for (const [from, edges] of nwbOnlyGraph.adjacency.entries()) {
        if (!memberIds.has(from)) continue;
        for (const e of edges) if (memberIds.has(e.to)) edgeCount++;
      }
      edgeCount = edgeCount / 2; // elke edge dubbel geteld (beide richtingen)
      return {
        nodeId,
        gevonden: root !== undefined,
        componentId: root ?? null,
        nodeCountInComponent: nodeCount,
        edgeCountInComponent: edgeCount,
        rd: pos ? { x: pos.x, y: pos.y } : null,
        wgs84: pos ? rdToWgs84(pos.x, pos.y) : null,
      };
    }

    const cluster1 = analyzeCluster(CONNECTOR_1_NWB_NODE_ID);
    const cluster3 = analyzeCluster(CONNECTOR_3_NWB_NODE_ID);

    const geografischeAfstandM = cluster1.rd && cluster3.rd ? Math.hypot(cluster3.rd.x - cluster1.rd.x, cluster3.rd.y - cluster1.rd.y) : null;
    const zelfdeComponent = cluster1.gevonden && cluster3.gevonden && cluster1.componentId === cluster3.componentId;

    let nwbPathResult: Record<string, unknown> = { LET_OP: "niet getest -- clusters gevonden in verschillende componenten, dus per definitie geen pad mogelijk" };
    if (zelfdeComponent) {
      const result = dijkstraOnCombinedGraph(nwbOnlyGraph, CONNECTOR_1_NWB_NODE_ID, CONNECTOR_3_NWB_NODE_ID);
      nwbPathResult = result.found ? { padGevonden: true, afstandM: Math.round(result.distanceM), hops: result.steps.length } : { padGevonden: false, opmerking: "Onverwacht: zelfde component maar geen pad -- zou niet moeten voorkomen" };
    }

    let diagnose: string;
    if (!cluster1.gevonden || !cluster3.gevonden) {
      diagnose = "ONBEKEND -- één van beide clusters niet gevonden in de NWB-only-graaf (mogelijk een naamgevingsverschil, geen conclusie mogelijk)";
    } else if (zelfdeComponent) {
      diagnose = "A: ZELFDE NWB-component -- de eerder voorgestelde verklaring (gescheiden NWB-fragmenten) klopt NIET. Er moet een andere oorzaak zijn.";
    } else if (geografischeAfstandM !== null && geografischeAfstandM < 5000) {
      diagnose = "B: VERSCHILLENDE NWB-componenten, geografisch dichtbij (<5km) -- dit is vermoedelijk precies het mechanisme.";
    } else {
      diagnose = "C: VERSCHILLENDE NWB-componenten, geografisch ver uit elkaar -- de vraag verschuift naar waarom de connector daar uitkomt.";
    }

    setReport({
      cluster1_connector1: cluster1,
      cluster3_connector3: cluster3,
      geografischeAfstandTussenClustersM: geografischeAfstandM !== null ? Math.round(geografischeAfstandM) : null,
      zelfdeNwbComponent: zelfdeComponent,
      nwbPadTest: nwbPathResult,
      DIAGNOSE: diagnose,
    });
    setLog((prev) => [...prev, "Analyse klaar."]);
    setRunning(false);
  }

  const copyText = report ? JSON.stringify(report, null, 2) : "";

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Fase 5C — NWB-component-check</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Zitten de NWB-clusters van connector 1 en connector 3 in dezelfde NWB-only-component? Geen F, geen connector-aanpassing, geen reparatie.
      </p>

      <button onClick={run} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig..." : "Start check"}
      </button>

      {log.length > 0 && (
        <div style={{ fontSize: 11, background: "#f0f0eb", padding: 10, borderRadius: 8, marginBottom: 12, maxHeight: 150, overflowY: "auto" }}>
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}

      {report && (
        <>
          <CopyAllButton text={copyText} />
          <pre style={{ fontSize: 10, background: "#f5f5f0", padding: 8, borderRadius: 6, overflowX: "auto", whiteSpace: "pre-wrap" }}>{copyText}</pre>
        </>
      )}
    </div>
  );
}
