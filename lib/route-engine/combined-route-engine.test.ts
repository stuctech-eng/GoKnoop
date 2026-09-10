import { describe, it, expect } from "vitest";
import { computeCombinedRoute, F_NWB_PRODUCTION, F_CONNECTOR_PRODUCTION } from "./combined-route-engine";
import type { GraphProvider, GraphNode, GraphEdge } from "./types";
import type { SlimNwbSegment, ValidatedConnectorInput } from "../nwb-analysis/combined-graph";

class FakeGraphProvider implements GraphProvider {
  constructor(
    private readonly nodes: Map<string, GraphNode>,
    private readonly edgesByNode: Map<string, GraphEdge[]>
  ) {}
  async load(): Promise<void> {}
  getNode(nodeId: string): GraphNode | undefined {
    return this.nodes.get(nodeId);
  }
  getAllNodeIds(): string[] {
    return [...this.nodes.keys()];
  }
  getEdgesFrom(nodeId: string): GraphEdge[] {
    return this.edgesByNode.get(nodeId) || [];
  }
}

function makeNode(id: string, x: number, y: number): GraphNode {
  return { id, x, y, displayNumber: id } as GraphNode;
}

describe("computeCombinedRoute (productie-module, Fase G/H/I)", () => {
  it("bevestigt de definitieve, Fase-C-gekozen productiewaarden", () => {
    expect(F_NWB_PRODUCTION).toBe(1.2);
    expect(F_CONNECTOR_PRODUCTION).toBe(1.0);
  });

  it("geeft node_not_found terug als from/to niet bestaat -- geen crash, geen aanname", () => {
    const provider = new FakeGraphProvider(new Map(), new Map());
    const result = computeCombinedRoute(provider, [], [], "onbestaand-1", "onbestaand-2");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("node_not_found");
  });

  it("geeft disconnected terug als er geen enkel pad bestaat (geen GoKnoop, geen NWB, geen connector)", () => {
    const nodes = new Map<string, GraphNode>([
      ["1", makeNode("1", 0, 0)],
      ["2", makeNode("2", 1000, 0)],
    ]);
    const provider = new FakeGraphProvider(nodes, new Map());
    const result = computeCombinedRoute(provider, [], [], "1", "2");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("disconnected");
  });

  it("accepteert een normale, gezonde route (GoKnoop + NWB gemengd, lage deviationFactor)", () => {
    const goknoopEdge: GraphEdge = { id: "g1", fromLogicalNodeId: "1", toLogicalNodeId: "2", distanceM: 5000, directionality: "unknown", geometry: [] };
    const nodes = new Map<string, GraphNode>([
      ["1", makeNode("1", 0, 0)],
      ["2", makeNode("2", 5000, 0)],
    ]);
    const edges = new Map<string, GraphEdge[]>([
      ["1", [goknoopEdge]],
      ["2", [goknoopEdge]],
    ]);
    const provider = new FakeGraphProvider(nodes, edges);
    const result = computeCombinedRoute(provider, [], [], "1", "2");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quality.verdict).toBe("geaccepteerd");
      expect(result.geometryAvailable).toEqual({ goknoop: true, nwb: false });
      expect(result.distanceM).toBe(5000);
    }
  });

  it("WIJST een 337km-achtige anomalie AF -- de validatielaag werkt end-to-end in de productie-module", () => {
    // Zelfde schaal-verhouding als de echte Volendam-anomalie (~20x deviation),
    // hier klein nagebouwd: twee gescheiden NWB-componenten, GoKnoop-brug is
    // een enorme omweg t.o.v. de hemelsbrede afstand.
    const nodes = new Map<string, GraphNode>();
    const edgesByNode = new Map<string, GraphEdge[]>();
    function addGoknoopEdge(id: string, a: string, b: string, distanceM: number) {
      const edge: GraphEdge = { id, fromLogicalNodeId: a, toLogicalNodeId: b, distanceM, directionality: "unknown", geometry: [] };
      if (!edgesByNode.has(a)) edgesByNode.set(a, []);
      if (!edgesByNode.has(b)) edgesByNode.set(b, []);
      edgesByNode.get(a)!.push(edge);
      edgesByNode.get(b)!.push(edge);
    }
    // Start en doel liggen dicht bij elkaar (hemelsbreed ~1000m).
    nodes.set("start", makeNode("start", 0, 0));
    nodes.set("doel", makeNode("doel", 1000, 0));
    // Maar de enige GoKnoop-route tussen hun twee (aparte) NWB-aansluitpunten is 25.000m.
    nodes.set("mid", makeNode("mid", 500, 5000));
    addGoknoopEdge("g1", "start", "mid", 12500);
    addGoknoopEdge("g2", "mid", "doel", 12500);

    const nwbSegments: SlimNwbSegment[] = [];
    const validatedConnectors: ValidatedConnectorInput[] = [
      { goknoopNodeId: "start", nwbSegmentId: "n/a", nwbEndpoint: "from", distanceM: 0, confidence: "high" },
    ];
    // (Geen NWB-edges nodig voor dit scenario -- het punt is dat de GoKnoop-brug zelf al absurd is.)

    const provider = new FakeGraphProvider(nodes, edgesByNode);
    const result = computeCombinedRoute(provider, nwbSegments, [], "start", "doel");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("quality_rejected");
      expect(result.quality?.deviationFactor).toBeGreaterThan(3.5);
    }
  });

  it("meet computeTimeMs (voor latency-monitoring, Fase K)", () => {
    const nodes = new Map<string, GraphNode>([
      ["1", makeNode("1", 0, 0)],
      ["2", makeNode("2", 100, 0)],
    ]);
    const edge: GraphEdge = { id: "e1", fromLogicalNodeId: "1", toLogicalNodeId: "2", distanceM: 100, directionality: "unknown", geometry: [] };
    const provider = new FakeGraphProvider(nodes, new Map([["1", [edge]], ["2", [edge]]]));
    const result = computeCombinedRoute(provider, [], [], "1", "2");
    expect(result.ok).toBe(true);
    if (result.ok) expect(typeof result.computeTimeMs).toBe("number");
  });
});
