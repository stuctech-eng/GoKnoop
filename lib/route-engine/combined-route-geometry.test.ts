import { describe, it, expect, vi, afterEach } from "vitest";
import { buildCombinedRouteGeometry } from "./combined-route-geometry";
import type { GraphProvider, GraphNode, GraphEdge, Point } from "./types";
import type { CombinedGraph, CostAwareStep } from "../nwb-analysis/combined-graph";

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

function makeCombinedGraph(nodePositions: Record<string, { x: number; y: number; source: "goknoop" | "nwb" }>): CombinedGraph {
  return {
    adjacency: new Map(),
    nodePosition: new Map(Object.entries(nodePositions)),
    totalConnectorsCreated: 0,
  };
}

function mockGeometryFetch(featuresById: Record<string, Point[]>) {
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        type: "FeatureCollection",
        features: Object.entries(featuresById).map(([id, coords]) => ({
          type: "Feature",
          id,
          geometry: { type: "LineString", coordinates: coords.map((p) => [p.x, p.y]) },
        })),
      }),
  } as Response);
  vi.stubGlobal("fetch", mockFetch);
}

describe("buildCombinedRouteGeometry (Fase M4, 10-9-2026)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hergebruikt de ECHTE GoKnoop-geometrie voor een GoKnoop-hop, in de juiste richting", async () => {
    const goknoopEdge: GraphEdge = { id: "g1", fromLogicalNodeId: "A", toLogicalNodeId: "B", distanceM: 100, directionality: "bidirectional", geometry: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }] };
    const provider = new FakeGraphProvider(new Map([["A", { id: "A", x: 0, y: 0 } as GraphNode], ["B", { id: "B", x: 100, y: 0 } as GraphNode]]), new Map([["A", [goknoopEdge]], ["B", [goknoopEdge]]]));
    const graph = makeCombinedGraph({ A: { x: 0, y: 0, source: "goknoop" }, B: { x: 100, y: 0, source: "goknoop" } });

    const steps: CostAwareStep[] = [
      { nodeId: "A", edgeSource: "start" },
      { nodeId: "B", edgeSource: "goknoop" },
    ];
    const result = await buildCombinedRouteGeometry(steps, graph, provider);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0].geometry).toEqual(goknoopEdge.geometry); // A->B is al de forward-richting
    }
  });

  it("haalt LIVE NWB-geometrie op en oriënteert 'm correct op de reisrichting", async () => {
    mockGeometryFetch({ "wegvakken.test1": [{ x: 100, y: 0 }, { x: 150, y: 0 }, { x: 200, y: 0 }] }); // van X naar Y in de brondata
    const provider = new FakeGraphProvider(new Map(), new Map());
    const graph = makeCombinedGraph({ "nwb:cluster-a": { x: 100, y: 0, source: "nwb" }, "nwb:cluster-b": { x: 200, y: 0, source: "nwb" } });

    const steps: CostAwareStep[] = [
      { nodeId: "nwb:cluster-a", edgeSource: "start" },
      { nodeId: "nwb:cluster-b", edgeSource: "nwb", nwbSegmentId: "wegvakken.test1" },
    ];
    const result = await buildCombinedRouteGeometry(steps, graph, provider);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.edges[0].geometry[0]).toEqual({ x: 100, y: 0 }); // start bij het beginpunt van de reis, niet omgekeerd
      expect(result.unresolvedNwbSegments).toEqual([]);
    }
  });

  it("KERNGEVAL: een segment dat het pad TWEEMAAL doorkruist verschijnt ook TWEEMAAL in de uitvoer -- geen deduplicatie", async () => {
    mockGeometryFetch({ "wegvakken.heenweg": [{ x: 0, y: 0 }, { x: 100, y: 0 }] });
    const provider = new FakeGraphProvider(new Map(), new Map());
    const graph = makeCombinedGraph({
      "nwb:start": { x: 0, y: 0, source: "nwb" },
      "nwb:eind": { x: 100, y: 0, source: "nwb" },
    });

    // Pad: start -> eind (segment X heen) -> start (segment X terug) -- kunstmatig,
    // maar test precies het contract: geen enkele stap mag verdwijnen.
    const steps: CostAwareStep[] = [
      { nodeId: "nwb:start", edgeSource: "start" },
      { nodeId: "nwb:eind", edgeSource: "nwb", nwbSegmentId: "wegvakken.heenweg" },
      { nodeId: "nwb:start", edgeSource: "nwb", nwbSegmentId: "wegvakken.heenweg" },
    ];
    const result = await buildCombinedRouteGeometry(steps, graph, provider);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.edges).toHaveLength(2); // BEIDE doorkruisingen aanwezig, niet gededupliceerd tot 1
      expect(result.edges[0].id).not.toBe(result.edges[1].id); // elk een uniek ID (anders zouden ze elkaar overschrijven bij eventuele Map-opslag elders)
      // De twee moeten elkaars spiegelbeeld zijn (heen vs. terug).
      expect(result.edges[0].geometry[0]).toEqual({ x: 0, y: 0 });
      expect(result.edges[1].geometry[0]).toEqual({ x: 100, y: 0 });
    }
  });

  it("gebruikt een rechte lijn voor een connector-hop (geen bronroute-geometrie bestaat hiervoor)", async () => {
    const provider = new FakeGraphProvider(new Map(), new Map());
    const graph = makeCombinedGraph({ A: { x: 0, y: 0, source: "goknoop" }, "nwb:cluster": { x: 5, y: 5, source: "nwb" } });

    const steps: CostAwareStep[] = [
      { nodeId: "A", edgeSource: "start" },
      { nodeId: "nwb:cluster", edgeSource: "connector" },
    ];
    const result = await buildCombinedRouteGeometry(steps, graph, provider);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.edges[0].geometry).toEqual([{ x: 0, y: 0 }, { x: 5, y: 5 }]);
    }
  });

  it("degradeert veilig (rechte lijn) als geometrie-ophalen voor een specifiek segment mislukt, i.p.v. de hele route te laten falen", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ type: "FeatureCollection", features: [] }) } as Response);
    vi.stubGlobal("fetch", mockFetch);
    const provider = new FakeGraphProvider(new Map(), new Map());
    const graph = makeCombinedGraph({ "nwb:a": { x: 0, y: 0, source: "nwb" }, "nwb:b": { x: 100, y: 0, source: "nwb" } });

    const steps: CostAwareStep[] = [
      { nodeId: "nwb:a", edgeSource: "start" },
      { nodeId: "nwb:b", edgeSource: "nwb", nwbSegmentId: "wegvakken.niet-gevonden" },
    ];
    const result = await buildCombinedRouteGeometry(steps, graph, provider);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.edges[0].geometry).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]); // rechte-lijn-fallback
      expect(result.unresolvedNwbSegments).toContain("wegvakken.niet-gevonden");
    }
  });

  it("geeft een duidelijke fout als een GoKnoop-edge niet resolveerbaar is (geen stille datacorruptie)", async () => {
    const provider = new FakeGraphProvider(new Map([["A", { id: "A", x: 0, y: 0 } as GraphNode], ["B", { id: "B", x: 100, y: 0 } as GraphNode]]), new Map());
    const graph = makeCombinedGraph({ A: { x: 0, y: 0, source: "goknoop" }, B: { x: 100, y: 0, source: "goknoop" } });

    const steps: CostAwareStep[] = [
      { nodeId: "A", edgeSource: "start" },
      { nodeId: "B", edgeSource: "goknoop" },
    ];
    const result = await buildCombinedRouteGeometry(steps, graph, provider);
    expect(result.ok).toBe(false);
  });
});
