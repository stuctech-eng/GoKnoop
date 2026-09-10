import { describe, it, expect } from "vitest";
import { computeCombinedRoute, F_NWB_PRODUCTION, F_CONNECTOR_PRODUCTION } from "./combined-route-engine";
import type { GraphProvider, GraphNode, GraphEdge } from "./types";
import { buildValidatedCombinedGraph, type SlimNwbSegment, type ValidatedConnectorInput } from "../nwb-analysis/combined-graph";

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

/** Bouwt de graaf op precies dezelfde manier als de (nu cachende) productie-laag dat doet. */
function buildTestGraph(provider: GraphProvider, nwbSegments: SlimNwbSegment[] = [], connectors: ValidatedConnectorInput[] = []) {
  return buildValidatedCombinedGraph(provider, nwbSegments, 20, connectors);
}

describe("computeCombinedRoute (productie-module, Fase G/H/I, HERZIEN Fase K)", () => {
  it("bevestigt de definitieve, Fase-C-gekozen productiewaarden", () => {
    expect(F_NWB_PRODUCTION).toBe(1.2);
    expect(F_CONNECTOR_PRODUCTION).toBe(1.0);
  });

  it("geeft node_not_found terug als from/to niet in de graaf zit -- geen crash, geen aanname", () => {
    const provider = new FakeGraphProvider(new Map(), new Map());
    const graph = buildTestGraph(provider);
    const result = computeCombinedRoute(graph, "onbestaand-1", "onbestaand-2");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("node_not_found");
  });

  it("geeft disconnected terug als er geen enkel pad bestaat", () => {
    const nodes = new Map<string, GraphNode>([
      ["1", makeNode("1", 0, 0)],
      ["2", makeNode("2", 1000, 0)],
    ]);
    const provider = new FakeGraphProvider(nodes, new Map());
    const graph = buildTestGraph(provider);
    const result = computeCombinedRoute(graph, "1", "2");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("disconnected");
  });

  it("accepteert een normale, gezonde route", () => {
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
    const graph = buildTestGraph(provider);
    const result = computeCombinedRoute(graph, "1", "2");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quality.verdict).toBe("geaccepteerd");
      expect(result.geometryAvailable).toEqual({ goknoop: true, nwb: false });
      expect(result.distanceM).toBe(5000);
    }
  });

  it("WIJST een 337km-achtige anomalie AF -- de validatielaag werkt end-to-end", () => {
    const nodes = new Map<string, GraphNode>();
    const edgesByNode = new Map<string, GraphEdge[]>();
    function addGoknoopEdge(id: string, a: string, b: string, distanceM: number) {
      const edge: GraphEdge = { id, fromLogicalNodeId: a, toLogicalNodeId: b, distanceM, directionality: "unknown", geometry: [] };
      if (!edgesByNode.has(a)) edgesByNode.set(a, []);
      if (!edgesByNode.has(b)) edgesByNode.set(b, []);
      edgesByNode.get(a)!.push(edge);
      edgesByNode.get(b)!.push(edge);
    }
    nodes.set("start", makeNode("start", 0, 0));
    nodes.set("doel", makeNode("doel", 1000, 0));
    nodes.set("mid", makeNode("mid", 500, 5000));
    addGoknoopEdge("g1", "start", "mid", 12500);
    addGoknoopEdge("g2", "mid", "doel", 12500);

    const validatedConnectors: ValidatedConnectorInput[] = [
      { goknoopNodeId: "start", nwbSegmentId: "n/a", nwbEndpoint: "from", distanceM: 0, confidence: "high" },
    ];

    const provider = new FakeGraphProvider(nodes, edgesByNode);
    const graph = buildTestGraph(provider, [], validatedConnectors);
    const result = computeCombinedRoute(graph, "start", "doel");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("quality_rejected");
      expect(result.quality?.deviationFactor).toBeGreaterThan(3.5);
    }
  });

  it("meet computeTimeMs -- nu ALLEEN Dijkstra-tijd, geen graafopbouw meer inbegrepen", () => {
    const nodes = new Map<string, GraphNode>([
      ["1", makeNode("1", 0, 0)],
      ["2", makeNode("2", 100, 0)],
    ]);
    const edge: GraphEdge = { id: "e1", fromLogicalNodeId: "1", toLogicalNodeId: "2", distanceM: 100, directionality: "unknown", geometry: [] };
    const provider = new FakeGraphProvider(nodes, new Map([["1", [edge]], ["2", [edge]]]));
    const graph = buildTestGraph(provider);
    const result = computeCombinedRoute(graph, "1", "2");
    expect(result.ok).toBe(true);
    if (result.ok) expect(typeof result.computeTimeMs).toBe("number");
  });

  it("gebruikt graph.nodePosition voor de hemelsbrede afstand -- geen GraphProvider meer nodig in deze functie", () => {
    const nodes = new Map<string, GraphNode>([
      ["1", makeNode("1", 0, 0)],
      ["2", makeNode("2", 3000, 4000)],
    ]);
    const edge: GraphEdge = { id: "e1", fromLogicalNodeId: "1", toLogicalNodeId: "2", distanceM: 5000, directionality: "unknown", geometry: [] };
    const provider = new FakeGraphProvider(nodes, new Map([["1", [edge]], ["2", [edge]]]));
    const graph = buildTestGraph(provider);
    const result = computeCombinedRoute(graph, "1", "2");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.straightLineDistanceM).toBe(5000);
  });
});
