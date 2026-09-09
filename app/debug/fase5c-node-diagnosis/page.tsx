"use client";

import { useState } from "react";
import { buildValidatedCombinedGraph, computeConnectedComponents, dijkstraOnCombinedGraph, type SlimNwbSegment, type ValidatedConnectorInput } from "@/lib/nwb-analysis/combined-graph";
import { generateConnectorCandidates, type GoKnoopNodeInput } from "@/lib/nwb-analysis/connector-candidates";
import { rdToWgs84 } from "@/lib/route-engine/coordinate-transform";
import type { GraphProvider, GraphNode, GraphEdge } from "@/lib/route-engine/types";

const TARGET_NODE_ID = "AG9myGNbdE6eH0W2SUmi";
const FROM_NODE_ID = "3Sx24AWzdYTR4Psx0JJW"; // v1-paar uit Fase 5B, waar de 337km-omweg optrad
const REGION = "volendam";

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

export default function Fase5cNodeDiagnosisPage() {
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

    setLog((prev) => [...prev, "Volledige GoKnoop-graaf ophalen..."]);
    let provider: ClientGraphProvider;
    let rawNodes: { id: string; x: number; y: number; displayNumber: string | null }[] = [];
    let rawEdges: { id: string; from: string; to: string; distanceM: number }[] = [];
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
    } catch (err) {
      setLog((prev) => [...prev, `⚠️ ${err instanceof Error ? err.message : String(err)}`]);
      setRunning(false);
      return;
    }

    // Vraag 1: exacte locatie.
    const targetNode = provider.getNode(TARGET_NODE_ID);
    if (!targetNode) {
      setLog((prev) => [...prev, `⚠️ Knoop ${TARGET_NODE_ID} niet gevonden in de graaf.`]);
      setRunning(false);
      return;
    }
    const targetWgs84 = rdToWgs84(targetNode.x, targetNode.y);

    // Vraag 2: directe GoKnoop-buren.
    const directNeighbors = provider.getEdgesFrom(TARGET_NODE_ID).map((e) => {
      const otherEnd = e.fromLogicalNodeId === TARGET_NODE_ID ? e.toLogicalNodeId : e.fromLogicalNodeId;
      const otherNode = provider.getNode(otherEnd);
      return { nodeId: otherEnd, distanceM: e.distanceM, x: otherNode?.x, y: otherNode?.y };
    });

    // Vraag 3: connected component in de GoKnoop-ONLY graaf (geen NWB, geen connectors).
    const goknoopOnlyGraph = buildValidatedCombinedGraph(provider, [], 20, []);
    const goknoopOnlyComponents = computeConnectedComponents(goknoopOnlyGraph);
    const targetComponentGoKnoopOnly = goknoopOnlyComponents.componentOfNode.get(TARGET_NODE_ID);
    const fromComponentGoKnoopOnly = goknoopOnlyComponents.componentOfNode.get(FROM_NODE_ID);
    let targetComponentSizeGoKnoopOnly = 0;
    for (const root of goknoopOnlyComponents.componentOfNode.values()) if (root === targetComponentGoKnoopOnly) targetComponentSizeGoKnoopOnly++;

    setLog((prev) => [...prev, `Knoop gevonden. GoKnoop-only component-grootte: ${targetComponentSizeGoKnoopOnly}. Zelfde component als startpunt? ${targetComponentGoKnoopOnly === fromComponentGoKnoopOnly}`]);

    // Nu de Volendam NWB-data + connectoren erbij, voor de vergelijking.
    setLog((prev) => [...prev, "Volendam NWB-tegels lezen..."]);
    const segmentsById = new Map<string, SlimNwbSegment>();
    let offset = 0;
    for (;;) {
      try {
        const params = new URLSearchParams({ region: REGION, offset: String(offset) });
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
      const params = new URLSearchParams({ region: REGION, datasetVersionId });
      if (key) params.set("key", key);
      const res = await fetch(`/api/debug/nwb-collector-goknoop-bearings?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (res.ok) goknoopBearingNodes = json.nodes;
    } catch {
      /* leeg */
    }

    await new Promise((r) => setTimeout(r, 20));
    const candidateResult = generateConnectorCandidates(goknoopBearingNodes, nwbSegments, 20);

    // Vraag 7: connectors specifiek bij deze knoop (geaccepteerd én afgewezen).
    const connectorsAtTarget = candidateResult.candidates.filter((c) => c.goknoopNodeId === TARGET_NODE_ID);

    const validatedConnectors: ValidatedConnectorInput[] = candidateResult.candidates
      .filter((c) => c.confidence !== "rejected")
      .map((c) => ({ goknoopNodeId: c.goknoopNodeId, nwbSegmentId: c.nwbSegmentId, nwbEndpoint: c.nwbEndpoint, distanceM: c.distanceM, confidence: c.confidence as "high" | "lower" }));

    const combined = buildValidatedCombinedGraph(provider, nwbSegments, 20, validatedConnectors);
    const combinedComponents = computeConnectedComponents(combined);
    const targetComponentCombined = combinedComponents.componentOfNode.get(TARGET_NODE_ID);
    const fromComponentCombined = combinedComponents.componentOfNode.get(FROM_NODE_ID);
    let targetComponentSizeCombined = 0;
    for (const root of combinedComponents.componentOfNode.values()) if (root === targetComponentCombined) targetComponentSizeCombined++;

    // Vraag 8/9: NWB-segmenten in de buurt (los van of er een geldige connector is).
    const nearbyNwbEndpoints: { distanceM: number; bstCode: string | null; segmentId: string }[] = [];
    for (const seg of nwbSegments) {
      const dFrom = Math.hypot(seg.from.x - targetNode.x, seg.from.y - targetNode.y);
      const dTo = Math.hypot(seg.to.x - targetNode.x, seg.to.y - targetNode.y);
      const minD = Math.min(dFrom, dTo);
      if (minD <= 100) nearbyNwbEndpoints.push({ distanceM: Math.round(minD), bstCode: seg.bstCode, segmentId: seg.id });
    }
    nearbyNwbEndpoints.sort((a, b) => a.distanceM - b.distanceM);

    // Vraag 5/6/10: de daadwerkelijke Dijkstra-route natrekken (bestaande, ongewijzigde functie -- geen F/kosten).
    setLog((prev) => [...prev, "Werkelijk pad natrekken (ongewogen, F niet aangeraakt)..."]);
    const routeResult = dijkstraOnCombinedGraph(combined, FROM_NODE_ID, TARGET_NODE_ID);

    // Padgeometrie-analyse: voor elke stap de coördinaat opzoeken (zowel
    // GoKnoop- als NWB-cluster-knopen staan in combined.nodePosition) en de
    // loodrechte afwijking t.o.v. de rechte lijn start->doel berekenen --
    // zelfde techniek als de eerdere Hilversum-breukpunt-analyse. Nog steeds
    // GEEN F/kosten aangeraakt, puur uitlezen van het al-berekende pad.
    let pathGeometryAnalysis: Record<string, unknown> = { LET_OP: "geen route gevonden, geometrie-analyse overgeslagen" };
    if (routeResult.found) {
      const startPos = combined.nodePosition.get(FROM_NODE_ID);
      const endPos = combined.nodePosition.get(TARGET_NODE_ID);
      if (startPos && endPos) {
        function perpendicularDistance(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const lengthSq = dx * dx + dy * dy;
          if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
          const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
          const projX = a.x + t * dx;
          const projY = a.y + t * dy;
          return Math.hypot(p.x - projX, p.y - projY);
        }

        const stepsWithGeometry = routeResult.steps.map((s, i) => {
          const pos = combined.nodePosition.get(s.nodeId);
          const deviationM = pos ? perpendicularDistance(pos, startPos, endPos) : null;
          return { index: i, nodeId: s.nodeId, bron: s.edgeSource, x: pos?.x, y: pos?.y, loodrechteAfwijkingM: deviationM !== null ? Math.round(deviationM) : null };
        });

        let maxDeviation = -1;
        let maxDeviationStep: (typeof stepsWithGeometry)[number] | null = null;
        for (const s of stepsWithGeometry) {
          if (s.loodrechteAfwijkingM !== null && s.loodrechteAfwijkingM > maxDeviation) {
            maxDeviation = s.loodrechteAfwijkingM;
            maxDeviationStep = s;
          }
        }

        const sampleEveryN = Math.max(1, Math.floor(stepsWithGeometry.length / 25)); // ~25 gelijkmatig verspreide punten
        const sampled = stepsWithGeometry.filter((_, i) => i % sampleEveryN === 0);

        pathGeometryAnalysis = {
          totalStappen: stepsWithGeometry.length,
          diepstePunt: maxDeviationStep
            ? {
                ...maxDeviationStep,
                percentageDoorRoute: ((maxDeviationStep.index / stepsWithGeometry.length) * 100).toFixed(1) + "%",
                wgs84: maxDeviationStep.x !== undefined && maxDeviationStep.y !== undefined ? rdToWgs84(maxDeviationStep.x, maxDeviationStep.y) : null,
              }
            : null,
          verspreideSteekproef: sampled.map((s) => ({
            index: s.index,
            percentageDoorRoute: ((s.index / stepsWithGeometry.length) * 100).toFixed(1) + "%",
            bron: s.bron,
            loodrechteAfwijkingM: s.loodrechteAfwijkingM,
            wgs84: s.x !== undefined && s.y !== undefined ? rdToWgs84(s.x, s.y) : null,
          })),
        };
      }
    }

    setReport({
      vraag1_locatie: { nodeId: TARGET_NODE_ID, rd: { x: targetNode.x, y: targetNode.y }, wgs84: targetWgs84 },
      vraag2_directeGoKnoopBuren: { aantal: directNeighbors.length, buren: directNeighbors },
      vraag3en4_connectedComponent: {
        goknoopOnly: {
          componentGrootte: targetComponentSizeGoKnoopOnly,
          zelfdeComponentAlsStartpunt: targetComponentGoKnoopOnly === fromComponentGoKnoopOnly,
        },
        totalComponentsGoKnoopOnly: goknoopOnlyComponents.componentCount,
        largestComponentGoKnoopOnly: goknoopOnlyComponents.largestComponentSize,
      },
      vraag5en9_metNwbEnConnectors: {
        componentGrootte: targetComponentSizeCombined,
        zelfdeComponentAlsStartpuntNu: targetComponentCombined === fromComponentCombined,
        LET_OP: "Als dit 'true' is maar de route toch enorm is, ligt het probleem NIET bij bereikbaarheid maar bij de KORTSTE-PAD-keuze zelf (bv. een zeer lange, kronkelende enige verbinding).",
      },
      vraag7_connectorsBijDezeKnoop: {
        aantalKandidaten: connectorsAtTarget.length,
        high: connectorsAtTarget.filter((c) => c.confidence === "high").length,
        lower: connectorsAtTarget.filter((c) => c.confidence === "lower").length,
        rejected: connectorsAtTarget.filter((c) => c.confidence === "rejected").length,
        details: connectorsAtTarget.map((c) => ({ nwbSegmentId: c.nwbSegmentId, distanceM: Math.round(c.distanceM), confidence: c.confidence, rejectionReason: c.rejectionReason })),
      },
      vraag8_nwbInDeBuurt100m: { aantal: nearbyNwbEndpoints.length, segmenten: nearbyNwbEndpoints.slice(0, 20) },
      vraag6en10_werkelijkePad: routeResult.found
        ? {
            routeFound: true,
            totaleAfstandM: Math.round(routeResult.distanceM),
            totalHops: routeResult.steps.length,
            goknoopEdgeCount: routeResult.goknoopEdgeCount,
            nwbEdgeCount: routeResult.nwbEdgeCount,
            connectorCount: routeResult.connectorCount,
            eersteVijftienStappen: routeResult.steps.slice(0, 15).map((s) => ({ nodeId: s.nodeId, bron: s.edgeSource, cumulatieveAfstandM: Math.round(s.distanceM) })),
            laatsteVijftienStappen: routeResult.steps.slice(-15).map((s) => ({ nodeId: s.nodeId, bron: s.edgeSource, cumulatieveAfstandM: Math.round(s.distanceM) })),
          }
        : { routeFound: false },
      padgeometrieAnalyse: pathGeometryAnalysis,
    });
    setLog((prev) => [...prev, "Diagnose klaar."]);
    setRunning(false);
  }

  const copyText = report ? JSON.stringify(report, null, 2) : "";

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Fase 5C — Diagnose: {TARGET_NODE_ID.slice(0, 8)}...</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Puur onderzoek naar waarom deze specifieke knoop een enorme omweg veroorzaakt. Geen F/kosten/productiecode aangeraakt.
      </p>

      <input value={datasetVersionId} onChange={(e) => setDatasetVersionId(e.target.value)} placeholder="datasetVersionId" style={{ width: "100%", padding: 10, fontSize: 13, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12 }} />

      <button onClick={run} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig..." : "Start diagnose"}
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
          <pre style={{ fontSize: 9, background: "#f5f5f0", padding: 8, borderRadius: 6, overflowX: "auto", whiteSpace: "pre-wrap" }}>{copyText}</pre>
        </>
      )}
    </div>
  );
}
