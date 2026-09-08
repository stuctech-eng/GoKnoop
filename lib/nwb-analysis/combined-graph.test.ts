import { describe, it, expect } from "vitest";
import { buildCombinedGraph, dijkstraOnCombinedGraph } from "./combined-graph";
import type { GraphProvider, GraphNode, GraphEdge } from "../route-engine/types";
import type { SlimNwbSegment } from "./combined-graph";

/** Minimale fake GraphProvider, zelfde patroon als bridge-augmented-graph-provider.test.ts. */
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

describe("combined-graph", () => {
  it("vindt GEEN route tussen twee volledig gescheiden GoKnoop-clusters zonder NWB (controlegeval)", () => {
    // Cluster A: knoop 1-2 verbonden. Cluster B: knoop 3-4 verbonden. Geen enkele
    // GoKnoop-verbinding tussen de twee clusters -- exact zoals het huidige,
    // echte Amsterdam/Hilversum-probleem.
    const nodes = new Map<string, GraphNode>([
      ["1", makeNode("1", 0, 0)],
      ["2", makeNode("2", 100, 0)],
      ["3", makeNode("3", 100000, 0)], // ver weg, apart cluster
      ["4", makeNode("4", 100100, 0)],
    ]);
    const edges = new Map<string, GraphEdge[]>([
      ["1", [{ id: "e1", fromLogicalNodeId: "1", toLogicalNodeId: "2", distanceM: 100, directionality: "unknown", geometry: [] }]],
      ["2", [{ id: "e1", fromLogicalNodeId: "2", toLogicalNodeId: "1", distanceM: 100, directionality: "unknown", geometry: [] }]],
      ["3", [{ id: "e2", fromLogicalNodeId: "3", toLogicalNodeId: "4", distanceM: 100, directionality: "unknown", geometry: [] }]],
      ["4", [{ id: "e2", fromLogicalNodeId: "4", toLogicalNodeId: "3", distanceM: 100, directionality: "unknown", geometry: [] }]],
    ]);
    const provider = new FakeGraphProvider(nodes, edges);

    const graph = buildCombinedGraph(provider, [], 5, { minX: -1000, minY: -1000, maxX: 200000, maxY: 1000 });
    const result = dijkstraOnCombinedGraph(graph, "1", "4");
    expect(result.found).toBe(false);
  });

  it("vindt WEL een route wanneer een NWB-segment de twee clusters verbindt", () => {
    const nodes = new Map<string, GraphNode>([
      ["1", makeNode("1", 0, 0)],
      ["2", makeNode("2", 100, 0)],
      ["3", makeNode("3", 100000, 0)],
      ["4", makeNode("4", 100100, 0)],
    ]);
    const edges = new Map<string, GraphEdge[]>([
      ["1", [{ id: "e1", fromLogicalNodeId: "1", toLogicalNodeId: "2", distanceM: 100, directionality: "unknown", geometry: [] }]],
      ["2", [{ id: "e1", fromLogicalNodeId: "2", toLogicalNodeId: "1", distanceM: 100, directionality: "unknown", geometry: [] }]],
      ["3", [{ id: "e2", fromLogicalNodeId: "3", toLogicalNodeId: "4", distanceM: 100, directionality: "unknown", geometry: [] }]],
      ["4", [{ id: "e2", fromLogicalNodeId: "4", toLogicalNodeId: "3", distanceM: 100, directionality: "unknown", geometry: [] }]],
    ]);
    const provider = new FakeGraphProvider(nodes, edges);

    // NWB-segment van vlak bij knoop 2 (binnen 5m) naar vlak bij knoop 3 (binnen 5m).
    const nwbSegments: SlimNwbSegment[] = [
      {
        id: "nwb1",
        bstCode: "FP",
        wegnummer: null,
        straatnaam: "Testpad",
        from: { x: 103, y: 0 }, // 3m van knoop 2
        to: { x: 99997, y: 0 }, // 3m van knoop 3
        lengthM: 99894, // reële padlengte (kan afwijken van de rechte-lijn-afstand, hier gelijk voor eenvoud)
      },
    ];

    const graph = buildCombinedGraph(provider, nwbSegments, 5, { minX: -1000, minY: -1000, maxX: 200000, maxY: 1000 });
    const result = dijkstraOnCombinedGraph(graph, "1", "4");
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.nwbEdgeCount).toBeGreaterThan(0);
      expect(result.connectorCount).toBeGreaterThan(0);
      expect(result.goknoopEdgeCount).toBeGreaterThan(0);
      // Totale afstand moet ongeveer kloppen: 100 (GoKnoop 1->2) + ~99897 (NWB) + 100 (GoKnoop 3->4) + connectors
      expect(result.distanceM).toBeGreaterThan(90000);
      expect(result.distanceM).toBeLessThan(110000);
    }
  });

  it("maakt GEEN connector als de afstand groter is dan de tolerantie", () => {
    const nodes = new Map<string, GraphNode>([["1", makeNode("1", 0, 0)]]);
    const edges = new Map<string, GraphEdge[]>([["1", []]]);
    const provider = new FakeGraphProvider(nodes, edges);

    const nwbSegments: SlimNwbSegment[] = [
      {
        id: "nwb1",
        bstCode: "FP",
        wegnummer: null,
        straatnaam: null,
        from: { x: 50, y: 0 }, // 50m van knoop 1 -- ruim buiten een 5m-tolerantie
        to: { x: 100, y: 0 },
        lengthM: 50,
      },
    ];

    const graph = buildCombinedGraph(provider, nwbSegments, 5, { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 });
    const result = dijkstraOnCombinedGraph(graph, "1", "nwb:nwb1:from");
    // Geen connector binnen 5m -- knoop 1 moet dus geïsoleerd blijven van het NWB-segment.
    expect(result.found).toBe(false);
  });

  it("vindt de correcte kortste route in een grotere keten (schaal-controle voor de heap-gebaseerde Dijkstra)", () => {
    // Keten van 3000 knopen, elk verbonden met de volgende op afstand 10 --
    // geen enorme graaf, maar groot genoeg om te bevestigen dat de
    // heap-gebaseerde Dijkstra (i.p.v. de eerdere, te trage sort-per-stap-
    // aanpak) ook op enige schaal correct blijft werken.
    const CHAIN_LENGTH = 3000;
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge[]>();
    for (let i = 0; i < CHAIN_LENGTH; i++) {
      nodes.set(String(i), makeNode(String(i), i * 10, 0));
      const edgeList: GraphEdge[] = [];
      if (i > 0) edgeList.push({ id: `e${i - 1}`, fromLogicalNodeId: String(i), toLogicalNodeId: String(i - 1), distanceM: 10, directionality: "unknown", geometry: [] });
      if (i < CHAIN_LENGTH - 1) edgeList.push({ id: `e${i}`, fromLogicalNodeId: String(i), toLogicalNodeId: String(i + 1), distanceM: 10, directionality: "unknown", geometry: [] });
      edges.set(String(i), edgeList);
    }
    const provider = new FakeGraphProvider(nodes, edges);
    const graph = buildCombinedGraph(provider, [], 5, { minX: -1, minY: -1, maxX: 1, maxY: 1 });
    const result = dijkstraOnCombinedGraph(graph, "0", String(CHAIN_LENGTH - 1));
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.distanceM).toBe((CHAIN_LENGTH - 1) * 10);
    }
  });

  it("navigeert correct vanaf de 'to'-kant van een gedeeld edge-object (regressietest voor de zelf-lus-bug)", () => {
    // TOEGEVOEGD 8-9-2026: de echte FirestoreGraphProvider indexeert ÉÉN
    // edge-object onder ZOWEL fromLogicalNodeId als toLogicalNodeId (voor
    // bidirectionele toegang, zie firestore-graph-provider.ts addEdgeIndex).
    // Dit scenario -- hetzelfde edge-object teruggegeven vanaf de 'to'-kant --
    // ontbrak in de eerdere tests (die gebruikten per richting een apart,
    // al-correct-georiënteerd edge-object) en verborg daardoor een echte bug:
    // blind e.toLogicalNodeId als bestemming gebruiken werd dan een lus naar
    // zichzelf i.p.v. een verbinding naar de overkant.
    const sharedEdge: GraphEdge = { id: "e1", fromLogicalNodeId: "1", toLogicalNodeId: "2", distanceM: 50, directionality: "unknown", geometry: [] };
    const nodes2 = new Map<string, GraphNode>([
      ["1", makeNode("1", 0, 0)],
      ["2", makeNode("2", 50, 0)],
    ]);
    const edges2 = new Map<string, GraphEdge[]>([
      ["1", [sharedEdge]], // zelfde object
      ["2", [sharedEdge]], // zelfde object, vanaf de 'to'-kant opgevraagd
    ]);
    const provider2 = new FakeGraphProvider(nodes2, edges2);
    const graph2 = buildCombinedGraph(provider2, [], 5, { minX: -1, minY: -1, maxX: 1, maxY: 1 });

    const edgesFrom2 = graph2.adjacency.get("2") ?? [];
    expect(edgesFrom2.some((e) => e.to === "1")).toBe(true);
    expect(edgesFrom2.some((e) => e.to === "2")).toBe(false); // geen lus naar zichzelf

    const result2 = dijkstraOnCombinedGraph(graph2, "2", "1");
    expect(result2.found).toBe(true);
    if (result2.found) expect(result2.distanceM).toBe(50);
  });
});
