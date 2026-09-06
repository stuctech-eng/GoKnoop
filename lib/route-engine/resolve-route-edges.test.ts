import { describe, it, expect } from "vitest";
import { resolveRouteEdges } from "./resolve-route-edges";
import { InMemoryGraphProvider } from "./fixtures/in-memory-graph-provider";
import type { GraphEdge, GraphNode, Route } from "./types";

function node(id: string, x: number, y: number): GraphNode {
  return { id, x, y };
}

function edge(overrides: Partial<GraphEdge> & Pick<GraphEdge, "id" | "fromLogicalNodeId" | "toLogicalNodeId" | "distanceM" | "geometry">): GraphEdge {
  return { directionality: "unknown", ...overrides };
}

function route(overrides: Partial<Route> & Pick<Route, "nodes" | "edges">): Route {
  return {
    id: "test-route",
    datasetVersionId: "v1",
    source: "route-engine-v1",
    network: "fiets",
    mode: "bicycle",
    geometry: [],
    distanceM: 0,
    elevation: null,
    durationEstimate: null,
    preferences: {},
    constraints: {},
    waypoints: [],
    alternatives: [],
    navigation: null,
    metadata: { algorithm: "dijkstra", computedAt: "2026-08-29T00:00:00.000Z", computeTimeMs: 1, edgesConsidered: 0 },
    ...overrides,
  };
}

async function buildFixtureProvider(): Promise<InMemoryGraphProvider> {
  const nodes: GraphNode[] = [node("A", 0, 0), node("B", 100, 0), node("C", 200, 0)];
  const edges: GraphEdge[] = [
    edge({ id: "e-ab", fromLogicalNodeId: "A", toLogicalNodeId: "B", distanceM: 100, geometry: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }),
    edge({ id: "e-bc", fromLogicalNodeId: "B", toLogicalNodeId: "C", distanceM: 100, geometry: [{ x: 100, y: 0 }, { x: 200, y: 0 }] }),
  ];
  const provider = new InMemoryGraphProvider(nodes, edges);
  await provider.load();
  return provider;
}

describe("resolveRouteEdges", () => {
  it("resolveert Route.edges[] naar de volledige GraphEdge-objecten, in dezelfde volgorde", async () => {
    const provider = await buildFixtureProvider();
    const r = route({ nodes: ["A", "B", "C"], edges: ["e-ab", "e-bc"] });

    const resolved = resolveRouteEdges(provider, r);

    expect(resolved).toHaveLength(2);
    expect(resolved[0].id).toBe("e-ab");
    expect(resolved[0].distanceM).toBe(100);
    expect(resolved[1].id).toBe("e-bc");
  });

  it("gooit een duidelijke fout als een edge niet resolveerbaar is (geen stille gaten)", async () => {
    const provider = await buildFixtureProvider();
    const r = route({ nodes: ["A", "B", "C"], edges: ["e-ab", "niet-bestaand"] });

    expect(() => resolveRouteEdges(provider, r)).toThrow(/niet-bestaand/);
  });

  it("werkt correct bij parallelle edges tussen dezelfde nodes (filtert ondubbelzinnig op edge-id)", async () => {
    const nodes: GraphNode[] = [node("A", 0, 0), node("B", 100, 0)];
    const edges: GraphEdge[] = [
      edge({ id: "e-ab-1", fromLogicalNodeId: "A", toLogicalNodeId: "B", distanceM: 100, geometry: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }),
      edge({ id: "e-ab-2", fromLogicalNodeId: "A", toLogicalNodeId: "B", distanceM: 120, geometry: [{ x: 0, y: 0 }, { x: 50, y: 30 }, { x: 100, y: 0 }] }),
    ];
    const provider = new InMemoryGraphProvider(nodes, edges);
    await provider.load();

    const r = route({ nodes: ["A", "B"], edges: ["e-ab-2"] });
    const resolved = resolveRouteEdges(provider, r);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe("e-ab-2");
    expect(resolved[0].distanceM).toBe(120); // niet per ongeluk de andere parallelle edge (100m)
  });

  it("geeft een lege array voor een route zonder edges (geen crash)", async () => {
    const provider = await buildFixtureProvider();
    const r = route({ nodes: ["A"], edges: [] });
    expect(resolveRouteEdges(provider, r)).toEqual([]);
  });
});
