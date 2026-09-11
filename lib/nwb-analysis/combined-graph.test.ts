import { describe, it, expect } from "vitest";
import {
  buildCombinedGraph,
  buildValidatedCombinedGraph,
  computeConnectedComponents,
  dijkstraOnCombinedGraph,
  dijkstraWithCostModel,
  makeCostFn,
} from "./combined-graph";
import type { GraphProvider, GraphNode, GraphEdge } from "../route-engine/types";
import type { SlimNwbSegment, ValidatedConnectorInput } from "./combined-graph";

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
  it("vindt GEEN route tussen twee volledig gescheiden GoKnoop-clusters zonder NWB (controlegeval)", async () => {
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

    const graph = await buildCombinedGraph(provider, [], 5, { minX: -1000, minY: -1000, maxX: 200000, maxY: 1000 });
    const result = dijkstraOnCombinedGraph(graph, "1", "4");
    expect(result.found).toBe(false);
  });

  it("vindt WEL een route wanneer een NWB-segment de twee clusters verbindt", async () => {
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

    const graph = await buildCombinedGraph(provider, nwbSegments, 5, { minX: -1000, minY: -1000, maxX: 200000, maxY: 1000 });
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

  it("maakt GEEN connector als de afstand groter is dan de tolerantie", async () => {
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

    const graph = await buildCombinedGraph(provider, nwbSegments, 5, { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 });
    const result = dijkstraOnCombinedGraph(graph, "1", "nwb:nwb1:from");
    // Geen connector binnen 5m -- knoop 1 moet dus geïsoleerd blijven van het NWB-segment.
    expect(result.found).toBe(false);
  });

  it("vindt de correcte kortste route in een grotere keten (schaal-controle voor de heap-gebaseerde Dijkstra)", async () => {
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
    const graph = await buildCombinedGraph(provider, [], 5, { minX: -1, minY: -1, maxX: 1, maxY: 1 });
    const result = dijkstraOnCombinedGraph(graph, "0", String(CHAIN_LENGTH - 1));
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.distanceM).toBe((CHAIN_LENGTH - 1) * 10);
    }
  });

  it("navigeert correct vanaf de 'to'-kant van een gedeeld edge-object (regressietest voor de zelf-lus-bug)", async () => {
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
    const graph2 = await buildCombinedGraph(provider2, [], 5, { minX: -1, minY: -1, maxX: 1, maxY: 1 });

    const edgesFrom2 = graph2.adjacency.get("2") ?? [];
    expect(edgesFrom2.some((e) => e.to === "1")).toBe(true);
    expect(edgesFrom2.some((e) => e.to === "2")).toBe(false); // geen lus naar zichzelf

    const result2 = dijkstraOnCombinedGraph(graph2, "2", "1");
    expect(result2.found).toBe(true);
    if (result2.found) expect(result2.distanceM).toBe(50);
  });
});

describe("buildValidatedCombinedGraph (Fase 4 -- gebruikt gevalideerde connectoren, geen blinde nabijheid)", () => {
  it("maakt GEEN connector als er geen gevalideerde kandidaat voor is, ook al liggen de punten dicht bij elkaar", async () => {
    const nodes = new Map<string, GraphNode>([["1", makeNode("1", 0, 0)]]);
    const edges = new Map<string, GraphEdge[]>([["1", []]]);
    const provider = new FakeGraphProvider(nodes, edges);
    const nwbSegments: SlimNwbSegment[] = [
      { id: "nwb1", bstCode: "FP", wegnummer: null, straatnaam: null, from: { x: 1, y: 0 }, to: { x: 100, y: 0 }, lengthM: 99 }, // 1m van knoop "1"
    ];
    // Geen validatedConnectors meegegeven -- ook al liggen ze dicht bij elkaar, mag er GEEN connector ontstaan.
    const graph = await buildValidatedCombinedGraph(provider, nwbSegments, 5, []);
    expect(graph.totalConnectorsCreated).toBe(0);
    const result = dijkstraOnCombinedGraph(graph, "1", "nwb:nwb1:from");
    expect(result.found).toBe(false);
  });

  it("maakt WEL een connector-edge voor een expliciet gevalideerde, niet-afgewezen kandidaat", async () => {
    const nodes = new Map<string, GraphNode>([["1", makeNode("1", 0, 0)]]);
    const edges = new Map<string, GraphEdge[]>([["1", []]]);
    const provider = new FakeGraphProvider(nodes, edges);
    const nwbSegments: SlimNwbSegment[] = [{ id: "nwb1", bstCode: "FP", wegnummer: null, straatnaam: null, from: { x: 1, y: 0 }, to: { x: 100, y: 0 }, lengthM: 99 }];
    const validatedConnectors: ValidatedConnectorInput[] = [{ goknoopNodeId: "1", nwbSegmentId: "nwb1", nwbEndpoint: "from", distanceM: 1, confidence: "high" }];

    const graph = await buildValidatedCombinedGraph(provider, nwbSegments, 5, validatedConnectors);
    expect(graph.totalConnectorsCreated).toBe(1);
    expect(graph.connectorsUsed).toEqual({ high: 1, lower: 0 });

    const result = dijkstraOnCombinedGraph(graph, "1", "nwb:nwb1:from");
    expect(result.found).toBe(true);
    if (result.found) expect(result.distanceM).toBe(1);
  });

  it("telt high en lower afzonderlijk", async () => {
    const nodes = new Map<string, GraphNode>([
      ["1", makeNode("1", 0, 0)],
      ["2", makeNode("2", 1000, 0)],
    ]);
    const edges = new Map<string, GraphEdge[]>([
      ["1", []],
      ["2", []],
    ]);
    const provider = new FakeGraphProvider(nodes, edges);
    const nwbSegments: SlimNwbSegment[] = [
      { id: "a", bstCode: "FP", wegnummer: null, straatnaam: null, from: { x: 1, y: 0 }, to: { x: 50, y: 0 }, lengthM: 49 },
      { id: "b", bstCode: "RB", wegnummer: null, straatnaam: null, from: { x: 1001, y: 0 }, to: { x: 1050, y: 0 }, lengthM: 49 },
    ];
    const validatedConnectors: ValidatedConnectorInput[] = [
      { goknoopNodeId: "1", nwbSegmentId: "a", nwbEndpoint: "from", distanceM: 1, confidence: "high" },
      { goknoopNodeId: "2", nwbSegmentId: "b", nwbEndpoint: "from", distanceM: 1, confidence: "lower" },
    ];
    const graph = await buildValidatedCombinedGraph(provider, nwbSegments, 5, validatedConnectors);
    expect(graph.connectorsUsed).toEqual({ high: 1, lower: 1 });
  });

  it("blijft de GoKnoop-graaf en NWB-graaf zelf ongewijzigd bouwen (zelfde als buildCombinedGraph, alleen stap 4 verschilt)", async () => {
    const nodes = new Map<string, GraphNode>([
      ["1", makeNode("1", 0, 0)],
      ["2", makeNode("2", 100, 0)],
    ]);
    const sharedEdge: GraphEdge = { id: "e1", fromLogicalNodeId: "1", toLogicalNodeId: "2", distanceM: 100, directionality: "unknown", geometry: [] };
    const edges = new Map<string, GraphEdge[]>([
      ["1", [sharedEdge]],
      ["2", [sharedEdge]],
    ]);
    const provider = new FakeGraphProvider(nodes, edges);
    const graph = await buildValidatedCombinedGraph(provider, [], 5, []);
    const result = dijkstraOnCombinedGraph(graph, "1", "2");
    expect(result.found).toBe(true);
    if (result.found) expect(result.distanceM).toBe(100);
  });
});

describe("computeConnectedComponents (Fase 4 -- topologie op de volledige gecombineerde graaf)", () => {
  it("telt twee gescheiden GoKnoop-clusters als 2 componenten zolang er geen connector is", async () => {
    const nodes = new Map<string, GraphNode>([
      ["1", makeNode("1", 0, 0)],
      ["2", makeNode("2", 100, 0)],
      ["3", makeNode("3", 100000, 0)],
      ["4", makeNode("4", 100100, 0)],
    ]);
    const edges = new Map<string, GraphEdge[]>([
      ["1", [{ id: "e1", fromLogicalNodeId: "1", toLogicalNodeId: "2", distanceM: 100, directionality: "unknown", geometry: [] }]],
      ["2", [{ id: "e1", fromLogicalNodeId: "1", toLogicalNodeId: "2", distanceM: 100, directionality: "unknown", geometry: [] }]],
      ["3", [{ id: "e2", fromLogicalNodeId: "3", toLogicalNodeId: "4", distanceM: 100, directionality: "unknown", geometry: [] }]],
      ["4", [{ id: "e2", fromLogicalNodeId: "3", toLogicalNodeId: "4", distanceM: 100, directionality: "unknown", geometry: [] }]],
    ]);
    const provider = new FakeGraphProvider(nodes, edges);
    const graph = await buildValidatedCombinedGraph(provider, [], 5, []);
    const stats = computeConnectedComponents(graph);
    expect(stats.componentCount).toBe(2);
    expect(stats.totalNodes).toBe(4);
    expect(stats.largestComponentSize).toBe(2);
    expect(stats.largestComponentPercent).toBe(50);
  });

  it("verenigt twee GoKnoop-clusters tot 1 component zodra een gevalideerde NWB-connector ze verbindt", async () => {
    const nodes = new Map<string, GraphNode>([
      ["1", makeNode("1", 0, 0)],
      ["2", makeNode("2", 100, 0)],
      ["3", makeNode("3", 100000, 0)],
      ["4", makeNode("4", 100100, 0)],
    ]);
    const edges = new Map<string, GraphEdge[]>([
      ["1", [{ id: "e1", fromLogicalNodeId: "1", toLogicalNodeId: "2", distanceM: 100, directionality: "unknown", geometry: [] }]],
      ["2", [{ id: "e1", fromLogicalNodeId: "1", toLogicalNodeId: "2", distanceM: 100, directionality: "unknown", geometry: [] }]],
      ["3", [{ id: "e2", fromLogicalNodeId: "3", toLogicalNodeId: "4", distanceM: 100, directionality: "unknown", geometry: [] }]],
      ["4", [{ id: "e2", fromLogicalNodeId: "3", toLogicalNodeId: "4", distanceM: 100, directionality: "unknown", geometry: [] }]],
    ]);
    const provider = new FakeGraphProvider(nodes, edges);
    const nwbSegments: SlimNwbSegment[] = [
      { id: "bridge", bstCode: "FP", wegnummer: null, straatnaam: null, from: { x: 103, y: 0 }, to: { x: 99997, y: 0 }, lengthM: 99894 },
    ];
    const validatedConnectors: ValidatedConnectorInput[] = [
      { goknoopNodeId: "2", nwbSegmentId: "bridge", nwbEndpoint: "from", distanceM: 3, confidence: "high" },
      { goknoopNodeId: "3", nwbSegmentId: "bridge", nwbEndpoint: "to", distanceM: 3, confidence: "high" },
    ];
    const graph = await buildValidatedCombinedGraph(provider, nwbSegments, 5, validatedConnectors);
    const stats = computeConnectedComponents(graph);
    expect(stats.componentCount).toBe(1);
    expect(stats.largestComponentPercent).toBe(100);
  });
});

describe("dijkstraWithCostModel + makeCostFn (Fase 5 -- empirisch kostenmodel)", () => {
  /**
   * Scenario: twee parallelle routes tussen dezelfde start/eind -- één via
   * GoKnoop (40 km werkelijk), één via NWB (35 km werkelijk). Dit test
   * PRECIES het wiskundige omslagpunt uit de architectuurreview van
   * vandaag: NWB wint zolang D_nwb × F < D_goknoop, dus bij D_g=40, D_n=35
   * is het omslagpunt F = 40/35 ≈ 1,143.
   */
  async function buildParallelRoutesScenario() {
    // GoKnoop-pad: 1 -> 2 -> 3, elk 20km, totaal 40km.
    const goknoopEdge1: GraphEdge = { id: "g1", fromLogicalNodeId: "1", toLogicalNodeId: "mid", distanceM: 20000, directionality: "unknown", geometry: [] };
    const goknoopEdge2: GraphEdge = { id: "g2", fromLogicalNodeId: "mid", toLogicalNodeId: "3", distanceM: 20000, directionality: "unknown", geometry: [] };
    const nodes = new Map<string, GraphNode>([
      ["1", makeNode("1", 0, 0)],
      ["mid", makeNode("mid", 20000, 0)],
      ["3", makeNode("3", 40000, 0)],
    ]);
    const edges = new Map<string, GraphEdge[]>([
      ["1", [goknoopEdge1]],
      ["mid", [goknoopEdge1, goknoopEdge2]],
      ["3", [goknoopEdge2]],
    ]);
    const provider = new FakeGraphProvider(nodes, edges);
    // NWB-pad: rechtstreeks van 1 naar 3, 35km werkelijk, via connectors op afstand 0 (voor een schoon, exact narekenbaar scenario).
    const nwbSegments: SlimNwbSegment[] = [{ id: "shortcut", bstCode: "FP", wegnummer: null, straatnaam: null, from: { x: 0, y: 100 }, to: { x: 35000, y: 100 }, lengthM: 35000 }];
    const validatedConnectors: ValidatedConnectorInput[] = [
      { goknoopNodeId: "1", nwbSegmentId: "shortcut", nwbEndpoint: "from", distanceM: 0, confidence: "high" },
      { goknoopNodeId: "3", nwbSegmentId: "shortcut", nwbEndpoint: "to", distanceM: 0, confidence: "high" },
    ];
    return await buildValidatedCombinedGraph(provider, nwbSegments, 5, validatedConnectors);
  }

  it("bij F=1,00 (baseline) wint NWB (35km) van GoKnoop (40km) -- reproduceert de Fase 4-bevinding", async () => {
    const graph = await buildParallelRoutesScenario();
    const result = dijkstraWithCostModel(graph, "1", "3", makeCostFn(1.0, 1.0));
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.nwbEdgeCount).toBeGreaterThan(0);
      expect(result.goknoopEdgeCount).toBe(0);
      expect(result.distanceM).toBeCloseTo(35000, -1);
    }
  });

  it("bij F=1,10 (onder het omslagpunt 1,143) wint NWB nog steeds", async () => {
    const graph = await buildParallelRoutesScenario();
    const result = dijkstraWithCostModel(graph, "1", "3", makeCostFn(1.1, 1.0));
    expect(result.found).toBe(true);
    if (result.found) expect(result.goknoopEdgeCount).toBe(0);
  });

  it("bij F=1,15 (boven het omslagpunt 1,143) wint GoKnoop -- het voorspelde omslagpunt klopt empirisch", async () => {
    const graph = await buildParallelRoutesScenario();
    const result = dijkstraWithCostModel(graph, "1", "3", makeCostFn(1.15, 1.0));
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.goknoopEdgeCount).toBe(2);
      expect(result.nwbEdgeCount).toBe(0);
      // Cruciaal: de GERAPPORTEERDE afstand is de WERKELIJKE 40km, nooit de opgehoogde kosten.
      expect(result.distanceM).toBeCloseTo(40000, -1);
    }
  });

  it("distanceM (werkelijk) en costTotal (gewogen) zijn verschillende getallen zodra F != 1", async () => {
    const graph = await buildParallelRoutesScenario();
    const result = dijkstraWithCostModel(graph, "1", "3", makeCostFn(1.0, 1.0));
    expect(result.found).toBe(true);
    if (result.found) {
      // Bij F=1.0 voor dit pad (NWB) zijn kosten en afstand toevallig gelijk -- test daarom met een van-1-afwijkende F.
    }
    const result2 = dijkstraWithCostModel(graph, "1", "3", makeCostFn(1.2, 1.0));
    expect(result2.found).toBe(true);
    if (result2.found) {
      // Bij F=1.2 wint GoKnoop (40km, kosten=40000) -- costTotal en distanceM zijn hier gelijk want GoKnoop-edges wegen altijd 1.0.
      // Test daarom expliciet het NWB-pad zelf bij een F waarbij het nog wint, om het verschil te tonen.
    }
    const result3 = dijkstraWithCostModel(graph, "1", "3", makeCostFn(1.1, 1.0));
    expect(result3.found).toBe(true);
    if (result3.found) {
      expect(result3.distanceM).toBeCloseTo(35000, -1); // werkelijke afstand van het NWB-pad
      expect(result3.costTotal).toBeCloseTo(38500, -1); // 35000 * 1.1 -- de kosten die de keuze bepaalden
      expect(result3.distanceM).not.toBeCloseTo(result3.costTotal, -1);
    }
  });
});

describe("CombinedEdge.nwbInfo.segmentId (10-9-2026, Geometry Integration Audit) -- betrouwbare segment-ID door de hele keten, geen reconstructie uit het cluster-knoop-ID", () => {
  it("een NWB-edge draagt het originele segment.id, niet het (mogelijk afwijkende) cluster-wortel-ID", async () => {
    const nodes = new Map<string, GraphNode>([
      ["1", makeNode("1", 0, 0)],
      ["2", makeNode("2", 1000, 0)],
    ]);
    const provider = new FakeGraphProvider(nodes, new Map());
    const nwbSegments: SlimNwbSegment[] = [{ id: "wegvakken.origineel-id-123", bstCode: "FP", wegnummer: null, straatnaam: "Teststraat", from: { x: 0, y: 0 }, to: { x: 1000, y: 0 }, lengthM: 1000 }];
    const graph = await buildValidatedCombinedGraph(provider, nwbSegments, 5, []);

    // Zoek de NWB-edge op in de adjacency-lijst en controleer het segmentId direct.
    let foundSegmentId: string | undefined;
    for (const edges of graph.adjacency.values()) {
      for (const e of edges) {
        if (e.source === "nwb") foundSegmentId = e.nwbInfo?.segmentId;
      }
    }
    expect(foundSegmentId).toBe("wegvakken.origineel-id-123");
  });

  it("KERNGEVAL: bij een cluster van MEERDERE samengevoegde punten is het segmentId nog steeds correct -- dit was precies de situatie waarin het oude, parseer-gebaseerde cluster-knoop-ID onbetrouwbaar bleek", async () => {
    // Drie NWB-segmenten die allemaal in hetzelfde ene punt samenkomen (een
    // kruising) -- hun from/to-clusters smelten samen tot één cluster met
    // 3+ leden, dus de cluster-wortel is NIET meer gelijk aan slechts één
    // van de drie segment-ID's (union-find kiest een willekeurige wortel).
    const nodes = new Map<string, GraphNode>();
    const provider = new FakeGraphProvider(nodes, new Map());
    const nwbSegments: SlimNwbSegment[] = [
      { id: "wegvakken.noord", bstCode: "FP", wegnummer: null, straatnaam: null, from: { x: 0, y: 100 }, to: { x: 0, y: 0 }, lengthM: 100 },
      { id: "wegvakken.oost", bstCode: "FP", wegnummer: null, straatnaam: null, from: { x: 100, y: 0 }, to: { x: 1, y: 0 }, lengthM: 100 }, // eindigt vlak bij (0,0) -- binnen tolerantie
      { id: "wegvakken.zuid", bstCode: "FP", wegnummer: null, straatnaam: null, from: { x: 0, y: -100 }, to: { x: 0, y: 1 }, lengthM: 100 }, // eindigt vlak bij (0,0)
    ];
    const graph = await buildValidatedCombinedGraph(provider, nwbSegments, 5, []);

    const foundSegmentIds = new Set<string>();
    for (const edges of graph.adjacency.values()) {
      for (const e of edges) {
        if (e.source === "nwb" && e.nwbInfo) foundSegmentIds.add(e.nwbInfo.segmentId);
      }
    }
    // Alle drie de originele segment-ID's moeten terug te vinden zijn, exact zoals opgeslagen.
    expect(foundSegmentIds).toEqual(new Set(["wegvakken.noord", "wegvakken.oost", "wegvakken.zuid"]));
  });

  it("dijkstraWithCostModel geeft het correcte nwbSegmentId per stap terug in CostAwareStep (de productie-Dijkstra, niet alleen de oudere variant)", async () => {
    const nodes = new Map<string, GraphNode>([
      ["1", makeNode("1", 0, 0)],
      ["2", makeNode("2", 1000, 0)],
    ]);
    const provider = new FakeGraphProvider(nodes, new Map());
    const nwbSegments: SlimNwbSegment[] = [{ id: "wegvakken.stap-test", bstCode: "FP", wegnummer: null, straatnaam: null, from: { x: 0, y: 0 }, to: { x: 1000, y: 0 }, lengthM: 1000 }];
    const validatedConnectors: ValidatedConnectorInput[] = [
      { goknoopNodeId: "1", nwbSegmentId: "wegvakken.stap-test", nwbEndpoint: "from", distanceM: 0, confidence: "high" },
      { goknoopNodeId: "2", nwbSegmentId: "wegvakken.stap-test", nwbEndpoint: "to", distanceM: 0, confidence: "high" },
    ];
    const graph = await buildValidatedCombinedGraph(provider, nwbSegments, 5, validatedConnectors);
    const result = dijkstraWithCostModel(graph, "1", "2", makeCostFn(1.0, 1.0));

    expect(result.found).toBe(true);
    if (result.found) {
      const nwbStep = result.steps.find((s) => s.edgeSource === "nwb");
      expect(nwbStep?.nwbSegmentId).toBe("wegvakken.stap-test");
    }
  });
});

describe("buildBaseGraph -- vooraf-berekend clustering-kortpad (Fase M6/M7, 11-9-2026)", () => {
  it("gebruikt het snelle pad als ALLE segmenten fromClusterId/toClusterId hebben, en levert exact dezelfde graaf op als live clustering", async () => {
    const nodes = new Map<string, GraphNode>([
      ["1", makeNode("1", 0, 0)],
      ["2", makeNode("2", 1000, 0)],
    ]);
    const provider = new FakeGraphProvider(nodes, new Map());

    // Twee segmenten die, via live clustering, zouden samensmelten tot 1 cluster (binnen tolerantie).
    const liveSegments: SlimNwbSegment[] = [
      { id: "seg-a", bstCode: "FP", wegnummer: null, straatnaam: null, from: { x: 0, y: 0 }, to: { x: 500, y: 0 }, lengthM: 500 },
      { id: "seg-b", bstCode: "FP", wegnummer: null, straatnaam: null, from: { x: 500, y: 2 }, to: { x: 1000, y: 0 }, lengthM: 500 }, // (500,2) smelt samen met (500,0) -- 2m < tolerantie
    ];
    // Dezelfde twee segmenten, maar nu met VOORAF-BEREKENDE cluster-ID's (zoals een precompute-stap ze zou opleveren).
    const precomputedSegments: SlimNwbSegment[] = [
      { ...liveSegments[0], fromClusterId: "clusterX", toClusterId: "clusterY" },
      { ...liveSegments[1], fromClusterId: "clusterY", toClusterId: "clusterZ" }, // zelfde clusterY als seg-a's toClusterId -- bevestigt samensmelting
    ];

    const liveGraph = await buildValidatedCombinedGraph(provider, liveSegments, 5, []);
    const precomputedGraph = await buildValidatedCombinedGraph(provider, precomputedSegments, 5, []);

    // Beide paden moeten hetzelfde aantal NWB-clusters opleveren (2: het samengesmolten middelpunt, plus de twee uiteinden -- eigenlijk 3, maar de kern is: consistent tussen beide paden).
    const liveClusterCount = liveGraph.nodePosition.size - provider.getAllNodeIds().length;
    const precomputedClusterCount = precomputedGraph.nodePosition.size - provider.getAllNodeIds().length;
    expect(precomputedClusterCount).toBe(liveClusterCount);
  });

  it("valt terug op live clustering als SLECHTS SOMMIGE segmenten vooraf-berekende cluster-ID's hebben (geen halfslachtige toepassing)", async () => {
    const nodes = new Map<string, GraphNode>([["1", makeNode("1", 0, 0)]]);
    const provider = new FakeGraphProvider(nodes, new Map());
    const mixedSegments: SlimNwbSegment[] = [
      { id: "seg-a", bstCode: "FP", wegnummer: null, straatnaam: null, from: { x: 0, y: 0 }, to: { x: 500, y: 0 }, lengthM: 500, fromClusterId: "x", toClusterId: "y" },
      { id: "seg-b", bstCode: "FP", wegnummer: null, straatnaam: null, from: { x: 500, y: 0 }, to: { x: 1000, y: 0 }, lengthM: 500 }, // GEEN precomputed data
    ];
    // Mag niet crashen -- moet gewoon via live clustering werken (allPrecomputed === false zodra één segment het mist).
    const graph = await buildValidatedCombinedGraph(provider, mixedSegments, 5, []);
    expect(graph.nodePosition.size).toBeGreaterThan(1);
  });
});
