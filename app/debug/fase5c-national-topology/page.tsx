"use client";

import { useState } from "react";
import { buildValidatedCombinedGraph, computeConnectedComponents, dijkstraOnCombinedGraph } from "@/lib/nwb-analysis/combined-graph";
import { findBridges, type SimpleEdge } from "@/lib/nwb-analysis/bridge-finder";
import { rdToWgs84 } from "@/lib/route-engine/coordinate-transform";
import type { GraphProvider, GraphNode, GraphEdge } from "@/lib/route-engine/types";

// Grens tussen "West" en "Rest" -- x=180.000 RD, gekozen op basis van de al-
// bekende clusters: Amsterdam/Volendam-regio ligt rond x=122k-141k, Lochem/
// Achterhoek rond x=220k-231k. 180.000 ligt daar ruim tussenin (ongeveer
// Utrecht/Veluwe-hoogte).
const WEST_THRESHOLD_X = 180000;

// Bekende, al-eerder-gebruikte echte knoop-ID's: West-kant (Amsterdam/
// Volendam-regio) en Oost-kant (Lochem/Achterhoek) -- voor de multi-route-test.
const WEST_TEST_NODES = ["CJSXBPUMG49vOPmYvhJd", "7fmSWIHYsKu3Wb3yOtM2", "3Sx24AWzdYTR4Psx0JJW", "AG9myGNbdE6eH0W2SUmi"];
const EAST_TEST_NODES = ["0pgYw2kgDphP2IT1RAi7", "9GsDbaxRKR3SKA6rMkiq", "CDdOFbRpdb959FzzPLc0"];

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

export default function Fase5cNationalTopologyPage() {
  const [datasetVersionId, setDatasetVersionId] = useState("uINZ3y2QsgBdEyky3duq");
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

    setLog((prev) => [...prev, "Volledige, landelijke GoKnoop-graaf ophalen..."]);
    let rawNodes: { id: string; x: number; y: number; displayNumber: string | null }[] = [];
    let rawEdges: { id: string; from: string; to: string; distanceM: number }[] = [];
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
      rawNodes = json.nodes;
      rawEdges = json.edges;
      provider = new ClientGraphProvider(rawNodes, rawEdges);
      setLog((prev) => [...prev, `${rawNodes.length} nodes, ${rawEdges.length} edges geladen.`]);
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ ${err instanceof Error ? err.message : String(err)}`]);
      setRunning(false);
      return;
    }

    // 1. Connected components (GoKnoop-only) -- bevestiging van Fase 1.
    const goknoopOnlyGraph = buildValidatedCombinedGraph(provider, [], 20, []);
    const componentStats = computeConnectedComponents(goknoopOnlyGraph);
    setLog((prev) => [...prev, `Componenten: ${componentStats.componentCount}, grootste: ${componentStats.largestComponentSize} (${componentStats.largestComponentPercent.toFixed(1)}%).`]);

    // 2. Geografische ligging van de grootste component: hoeveel van zijn
    // knopen liggen west/oost van de grens?
    let westCountInLargest = 0;
    let eastCountInLargest = 0;
    const largestRoot = (() => {
      const counts = new Map<string, number>();
      for (const root of componentStats.componentOfNode.values()) counts.set(root, (counts.get(root) || 0) + 1);
      let best: string | null = null;
      let bestSize = 0;
      for (const [root, size] of counts) if (size > bestSize) { best = root; bestSize = size; }
      return best;
    })();
    for (const n of rawNodes) {
      if (componentStats.componentOfNode.get(n.id) !== largestRoot) continue;
      if (n.x < WEST_THRESHOLD_X) westCountInLargest++;
      else eastCountInLargest++;
    }
    setLog((prev) => [...prev, `Grootste component: ${westCountInLargest} west, ${eastCountInLargest} oost van x=${WEST_THRESHOLD_X}.`]);

    // 3. Bridges vinden op de VOLLEDIGE graaf.
    setLog((prev) => [...prev, "Bridges zoeken (kan even duren)..."]);
    await new Promise((r) => setTimeout(r, 20));
    const simpleEdges: SimpleEdge[] = rawEdges.map((e) => ({ id: e.id, a: e.from, b: e.to, distanceM: e.distanceM }));
    const allBridges = findBridges(rawNodes.map((n) => n.id), simpleEdges);
    setLog((prev) => [...prev, `${allBridges.length} bridges gevonden in de volledige landelijke graaf.`]);

    // 4. Welke bridges kruisen daadwerkelijk de west/oost-grens?
    const nodeById = new Map(rawNodes.map((n) => [n.id, n]));
    const crossingBridges = allBridges
      .map((b) => {
        const nodeA = nodeById.get(b.a);
        const nodeB = nodeById.get(b.b);
        if (!nodeA || !nodeB) return null;
        const aIsWest = nodeA.x < WEST_THRESHOLD_X;
        const bIsWest = nodeB.x < WEST_THRESHOLD_X;
        return { ...b, aIsWest, bIsWest, kruistGrens: aIsWest !== bIsWest, aWgs84: rdToWgs84(nodeA.x, nodeA.y), bWgs84: rdToWgs84(nodeB.x, nodeB.y) };
      })
      .filter((b): b is NonNullable<typeof b> => b !== null && b.kruistGrens);
    setLog((prev) => [...prev, `Daarvan kruisen ${crossingBridges.length} de west/oost-grens.`]);

    // 5. Multi-route-test: West-knopen naar Oost-knopen, GoKnoop-only (geen NWB, geen F).
    const multiRouteResults: Record<string, unknown> = {};
    const usedBridgeNodeIds = new Set<string>();
    for (const westId of WEST_TEST_NODES) {
      for (const eastId of EAST_TEST_NODES) {
        const result = dijkstraOnCombinedGraph(goknoopOnlyGraph, westId, eastId);
        if (result.found) {
          // Zoek of een bekende bridge-node in dit pad voorkomt.
          const bridgeNodesInPath = result.steps.filter((s) => allBridges.some((br) => br.a === s.nodeId || br.b === s.nodeId)).map((s) => s.nodeId);
          for (const bn of bridgeNodesInPath) usedBridgeNodeIds.add(bn);
          multiRouteResults[`${westId.slice(0, 6)}->${eastId.slice(0, 6)}`] = {
            routeFound: true,
            distanceM: Math.round(result.distanceM),
            totalHops: result.steps.length,
          };
        } else {
          multiRouteResults[`${westId.slice(0, 6)}->${eastId.slice(0, 6)}`] = { routeFound: false };
        }
      }
    }
    setLog((prev) => [...prev, `Multi-route-test klaar. ${usedBridgeNodeIds.size} unieke bridge-knopen gebruikt over alle geteste paren samen.`]);

    setReport({
      componentAnalyse: {
        totaalComponenten: componentStats.componentCount,
        grootsteComponentGrootte: componentStats.largestComponentSize,
        grootsteComponentPercent: Math.round(componentStats.largestComponentPercent * 10) / 10,
        grootsteComponentWestAantal: westCountInLargest,
        grootsteComponentOostAantal: eastCountInLargest,
      },
      bridgeAnalyse: {
        totaalBridgesLandelijk: allBridges.length,
        bridgesDieWestOostGrensKruisen: crossingBridges.length,
        details: crossingBridges.map((b) => ({
          edgeId: b.edgeId,
          nodeA: b.a,
          nodeAWgs84: b.aWgs84,
          nodeB: b.b,
          nodeBWgs84: b.bWgs84,
          distanceM: Math.round(b.distanceM),
        })),
      },
      multiRouteTest: {
        LET_OP: "GoKnoop-only, geen NWB, geen F/kosten -- puur topologie.",
        westTestNodes: WEST_TEST_NODES,
        eastTestNodes: EAST_TEST_NODES,
        resultaten: multiRouteResults,
        uniekeBridgeKnopenGebruikt: Array.from(usedBridgeNodeIds),
      },
    });
    setLog((prev) => [...prev, "Analyse klaar."]);
    setRunning(false);
  }

  const copyText = report ? JSON.stringify(report, null, 2) : "";

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Fase 5C — Landelijke topologie West/Oost</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Componenten, bridges (single points of failure), en een multi-route-test. Puur GoKnoop-only topologie, geen NWB, geen F/kosten, geen productiecode.
      </p>

      <input value={datasetVersionId} onChange={(e) => setDatasetVersionId(e.target.value)} placeholder="datasetVersionId" style={{ width: "100%", padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12 }} />

      <button onClick={run} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig..." : "Start landelijke analyse"}
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
