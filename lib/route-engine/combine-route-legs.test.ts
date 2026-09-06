import { describe, it, expect } from "vitest";
import { combineRouteLegs } from "./combine-route-legs";
import type { CombinableLeg } from "./combine-route-legs";

function fakeRoute(nodes: string[], edges: string[], geometry: { x: number; y: number }[], distanceM: number) {
  return {
    id: "r1",
    datasetVersionId: "v1",
    source: "route-engine-v1" as const,
    network: "fiets" as const,
    mode: "bicycle" as const,
    nodes,
    edges,
    geometry,
    distanceM,
    elevation: null,
    durationEstimate: null,
    preferences: {},
    constraints: {},
    waypoints: [],
    alternatives: [],
    navigation: null,
    metadata: { algorithm: "dijkstra" as const, computedAt: "2026-08-30T00:00:00.000Z", computeTimeMs: 1, edgesConsidered: 1 },
  };
}

describe("combineRouteLegs", () => {
  it("plakt nodes aan elkaar zonder het gedeelde tussenpunt te dupliceren", () => {
    const legA: CombinableLeg = {
      route: fakeRoute(["A", "B", "W"], ["e1", "e2"], [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], 2000),
      resolvedEdges: [],
      nodeDisplayNumbers: ["1", "2", "3"],
    };
    const legB: CombinableLeg = {
      route: fakeRoute(["W", "C", "D"], ["e3", "e4"], [{ x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }], 1500),
      resolvedEdges: [],
      nodeDisplayNumbers: ["3", "4", "5"],
    };
    const combined = combineRouteLegs(legA, legB);
    expect(combined.route.nodes).toEqual(["A", "B", "W", "C", "D"]); // "W" maar één keer
    expect(combined.nodeDisplayNumbers).toEqual(["1", "2", "3", "4", "5"]); // idem, maar één keer "3"
  });

  it("plakt edges gewoon achter elkaar (geen overlap om te verwijderen)", () => {
    const legA: CombinableLeg = { route: fakeRoute(["A", "W"], ["e1"], [{ x: 0, y: 0 }, { x: 1, y: 0 }], 1000), resolvedEdges: [], nodeDisplayNumbers: ["1", "2"] };
    const legB: CombinableLeg = { route: fakeRoute(["W", "B"], ["e2"], [{ x: 1, y: 0 }, { x: 2, y: 0 }], 1000), resolvedEdges: [], nodeDisplayNumbers: ["2", "3"] };
    const combined = combineRouteLegs(legA, legB);
    expect(combined.route.edges).toEqual(["e1", "e2"]);
  });

  it("telt de afstanden van beide benen bij elkaar op", () => {
    const legA: CombinableLeg = { route: fakeRoute(["A", "W"], ["e1"], [{ x: 0, y: 0 }, { x: 1, y: 0 }], 3000), resolvedEdges: [], nodeDisplayNumbers: ["1", "2"] };
    const legB: CombinableLeg = { route: fakeRoute(["W", "B"], ["e2"], [{ x: 1, y: 0 }, { x: 2, y: 0 }], 2500), resolvedEdges: [], nodeDisplayNumbers: ["2", "3"] };
    const combined = combineRouteLegs(legA, legB);
    expect(combined.route.distanceM).toBe(5500);
  });

  it("plakt de geometrie zonder het gedeelde punt te dupliceren", () => {
    const legA: CombinableLeg = { route: fakeRoute(["A", "W"], ["e1"], [{ x: 0, y: 0 }, { x: 5, y: 5 }], 1000), resolvedEdges: [], nodeDisplayNumbers: ["1", "2"] };
    const legB: CombinableLeg = { route: fakeRoute(["W", "B"], ["e2"], [{ x: 5, y: 5 }, { x: 10, y: 10 }], 1000), resolvedEdges: [], nodeDisplayNumbers: ["2", "3"] };
    const combined = combineRouteLegs(legA, legB);
    expect(combined.route.geometry).toEqual([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }]);
  });
});
