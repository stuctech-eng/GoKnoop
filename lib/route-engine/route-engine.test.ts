import { describe, it, expect, beforeAll } from "vitest";
import { FixtureGraphProvider } from "./fixtures/fixture-graph-provider";
import { findShortestPath } from "./dijkstra";
import { buildRoute, RouteInvariantError } from "./route-builder";
import { computeRoute } from "./route-engine";
import { isTraversable } from "./is-traversable";
import type { GraphEdge } from "./types";

describe("Route Engine — kern (fixture-graaf)", () => {
  let provider: FixtureGraphProvider;

  beforeAll(async () => {
    provider = new FixtureGraphProvider();
    await provider.load();
  });

  // --- 2. Dijkstra-kern: bekende kortste paden ---
  describe("Dijkstra — bekende kortste paden", () => {
    it("N1 -> N3 gebruikt de goedkopere parallelle edge (E5, niet E1) en niet de directe E3", () => {
      const result = findShortestPath(provider, "N1", "N3");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.totalDistanceM).toBe(180); // 80 (E5) + 100 (E2), niet 200 via E1, niet 250 via E3
      expect(result.nodeSequence).toEqual(["N1", "N2", "N3"]);
      expect(result.edgeSequence.map((e) => e.id)).toEqual(["E5", "E2"]);
    });

    it("N1 -> N5 volgt de volledige keten via de goedkoopste edges", () => {
      const result = findShortestPath(provider, "N1", "N5");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.totalDistanceM).toBe(290); // 80 + 100 + 50 + 60
      expect(result.nodeSequence).toEqual(["N1", "N2", "N3", "N4", "N5"]);
    });

    it("N1 -> N1 (triviaal geval) geeft een lege route met afstand 0", () => {
      const result = findShortestPath(provider, "N1", "N1");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.totalDistanceM).toBe(0);
      expect(result.nodeSequence).toEqual(["N1"]);
      expect(result.edgeSequence).toEqual([]);
    });
  });

  // --- 3. Parallelle edges ---
  describe("Parallelle edges", () => {
    it("kiest bij meerdere edges tussen hetzelfde nodepaar altijd de goedkoopste", () => {
      // N1<->N2 heeft E1 (100m) en E5 (80m parallel) -- direct pad moet E5 gebruiken.
      const result = findShortestPath(provider, "N1", "N2");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.edgeSequence.map((e) => e.id)).toEqual(["E5"]);
      expect(result.totalDistanceM).toBe(80);
    });

    it("avoidEdgeIds op de goedkope parallelle edge dwingt de duurdere af, blokkeert niet het hele nodepaar", () => {
      const result = findShortestPath(provider, "N1", "N2", { avoidEdgeIds: ["E5"] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.edgeSequence.map((e) => e.id)).toEqual(["E1"]);
      expect(result.totalDistanceM).toBe(100);
    });
  });

  // --- 4. isTraversable() ---
  describe("isTraversable()", () => {
    it("behandelt directionality='unknown' als traversable in beide richtingen", () => {
      const edge: GraphEdge = {
        id: "test",
        fromLogicalNodeId: "A",
        toLogicalNodeId: "B",
        distanceM: 10,
        directionality: "unknown",
        geometry: [],
      };
      expect(isTraversable(edge, "A")).toBe(true);
      expect(isTraversable(edge, "B")).toBe(true);
    });

    it("respecteert 'forward' en 'reverse' correct (voorbereid op toekomstig gebruik)", () => {
      const forwardEdge: GraphEdge = {
        id: "f",
        fromLogicalNodeId: "A",
        toLogicalNodeId: "B",
        distanceM: 10,
        directionality: "forward",
        geometry: [],
      };
      expect(isTraversable(forwardEdge, "A")).toBe(true);
      expect(isTraversable(forwardEdge, "B")).toBe(false);

      const reverseEdge: GraphEdge = { ...forwardEdge, id: "r", directionality: "reverse" };
      expect(isTraversable(reverseEdge, "A")).toBe(false);
      expect(isTraversable(reverseEdge, "B")).toBe(true);
    });
  });

  // --- 5. Constraints ---
  describe("Constraints", () => {
    it("avoidNodeIds sluit een node volledig uit, ook als tussenstop", () => {
      // Enige pad N1->N3 zonder N2 is via E3 (250m, direct).
      const result = findShortestPath(provider, "N1", "N3", { avoidNodeIds: ["N2"] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.edgeSequence.map((e) => e.id)).toEqual(["E3"]);
      expect(result.totalDistanceM).toBe(250);
    });

    it("avoidNodeIds op het startpunt zelf geeft all_paths_blocked_by_constraints", () => {
      const result = findShortestPath(provider, "N1", "N3", { avoidNodeIds: ["N1"] });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("all_paths_blocked_by_constraints");
    });

    it("avoidEdgeIds op alle mogelijke paden geeft all_paths_blocked_by_constraints... of disconnected", () => {
      // Blokkeer alle edges tussen N1 en de rest -- geen enkel pad meer mogelijk.
      const result = findShortestPath(provider, "N1", "N3", { avoidEdgeIds: ["E1", "E5", "E3"] });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("no_traversable_edges");
    });
  });

  // --- 6. Disconnected / no-path-gevallen ---
  describe("Disconnected / geen pad mogelijk", () => {
    it("N1 -> N6 (volledig geïsoleerde node) geeft reason 'disconnected'", () => {
      const result = findShortestPath(provider, "N1", "N6");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("disconnected");
    });

    it("N6 -> N1 (vanuit de geïsoleerde node) geeft reason 'no_traversable_edges'", () => {
      const result = findShortestPath(provider, "N6", "N1");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("no_traversable_edges");
    });

    it("een niet-bestaande node geeft reason 'disconnected'", () => {
      const result = findShortestPath(provider, "N1", "DOES_NOT_EXIST");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("disconnected");
    });
  });

  // --- 7 & 8. Route-reconstructie: nodes[] + edges[], geometrie, distance-invariant ---
  describe("Route-reconstructie", () => {
    it("bouwt een Route met verplichte edges[] naast nodes[]", () => {
      const result = findShortestPath(provider, "N1", "N3");
      if (!result.ok) throw new Error("setup faalde");
      const route = buildRoute({
        datasetVersionId: "test-version",
        dijkstraResult: result,
        constraints: {},
        computeTimeMs: 1,
        edgesConsidered: 6,
      });
      expect(route.nodes).toEqual(["N1", "N2", "N3"]);
      expect(route.edges).toEqual(["E5", "E2"]);
    });

    it("reconstrueert de geometrie in de juiste doorlooprichting, zonder gedupliceerde naadpunten", () => {
      const result = findShortestPath(provider, "N1", "N3");
      if (!result.ok) throw new Error("setup faalde");
      const route = buildRoute({
        datasetVersionId: "test-version",
        dijkstraResult: result,
        constraints: {},
        computeTimeMs: 1,
        edgesConsidered: 6,
      });
      // E5: (0,0)->(50,-10)->(100,0); E2: (100,0)->(200,0). Naadpunt (100,0) niet dubbel.
      expect(route.geometry).toEqual([
        { x: 0, y: 0 },
        { x: 50, y: -10 },
        { x: 100, y: 0 },
        { x: 200, y: 0 },
      ]);
    });

    it("distance-invariant: route.distanceM === som van edges[i].distanceM", () => {
      const result = findShortestPath(provider, "N1", "N5");
      if (!result.ok) throw new Error("setup faalde");
      const route = buildRoute({
        datasetVersionId: "test-version",
        dijkstraResult: result,
        constraints: {},
        computeTimeMs: 1,
        edgesConsidered: 6,
      });
      const sumOfEdges = result.edgeSequence.reduce((s, e) => s + e.distanceM, 0);
      expect(route.distanceM).toBe(sumOfEdges);
      expect(route.distanceM).toBe(290);
    });

    it("gooit RouteInvariantError als de invariant kunstmatig wordt geschonden", () => {
      const result = findShortestPath(provider, "N1", "N3");
      if (!result.ok) throw new Error("setup faalde");
      const corrupted = { ...result, totalDistanceM: result.totalDistanceM + 9999 };
      expect(() =>
        buildRoute({
          datasetVersionId: "test-version",
          dijkstraResult: corrupted,
          constraints: {},
          computeTimeMs: 1,
          edgesConsidered: 6,
        })
      ).toThrow(RouteInvariantError);
    });
  });

  // --- Volledige orkestratie (computeRoute) ---
  describe("computeRoute() — volledige orkestratie", () => {
    it("geeft een compleet Route-object terug met correcte metadata", () => {
      const route = computeRoute(provider, "test-version", "N1", "N3");
      expect("id" in route).toBe(true);
      if (!("id" in route)) return;
      expect(route.distanceM).toBe(180);
      expect(route.metadata.algorithm).toBe("dijkstra");
      expect(route.source).toBe("route-engine-v1");
      expect(route.mode).toBe("bicycle");
      expect(route.alternatives).toEqual([]);
      expect(route.waypoints).toEqual([]);
      expect(route.elevation).toBeNull();
      expect(route.navigation).toBeNull();
    });

    it("geeft een RouteError (geen Route) terug bij een onmogelijk pad", () => {
      const result = computeRoute(provider, "test-version", "N1", "N6");
      expect("ok" in result && result.ok === false).toBe(true);
      if (!("reason" in result)) return;
      expect(result.reason).toBe("disconnected");
    });
  });
});
