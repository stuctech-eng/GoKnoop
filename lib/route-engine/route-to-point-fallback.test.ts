import { describe, it, expect } from "vitest";
import { computeRouteWithFallback } from "./route-to-point-fallback";
import { InMemoryGraphProvider } from "./fixtures/in-memory-graph-provider";
import { buildValidatedCombinedGraph } from "../nwb-analysis/combined-graph";
import type { GraphEdge, GraphNode } from "./types";

/**
 * Zelfde soort fixture als de loop-generator-fallback-tests (6B): een
 * kandidaat die volledig geïsoleerd is qua bereikbaarheid naar het doel
 * (geen edge, dus zelfs de Route Engine kan er niets mee), een andere die
 * wel werkt.
 *
 * FASE M5, 10-9-2026: computeRouteWithFallback gebruikt nu de gecombineerde
 * engine en verwacht een `CombinedGraph`-parameter -- hier GoKnoop-only
 * gebouwd (geen NWB-segmenten, geen connectors), zodat deze tests exact
 * hetzelfde, ongewijzigde GoKnoop-only gedrag blijven verifiëren.
 */
async function buildFixtureProvider(): Promise<InMemoryGraphProvider> {
  const nodes: GraphNode[] = [
    { id: "isolated", x: -5000, y: 0, displayNumber: "96" },
    { id: "hub", x: 0, y: 0, displayNumber: "97" },
    { id: "target", x: 1000, y: 0, displayNumber: "99" },
  ];
  const edges: GraphEdge[] = [
    { id: "e-hub-target", fromLogicalNodeId: "hub", toLogicalNodeId: "target", distanceM: 1000, directionality: "unknown", geometry: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] },
  ];
  const provider = new InMemoryGraphProvider(nodes, edges);
  await provider.load();
  return provider;
}

describe("computeRouteWithFallback", () => {
  it("valt terug van een niet-bereikbare kandidaat naar een werkende, en rapporteert dat transparant", async () => {
    const provider = await buildFixtureProvider();
    const graph = buildValidatedCombinedGraph(provider, [], 20, []);
    const candidates = [
      { logicalNodeId: "isolated", distanceM: 200 }, // geen enkele edge, geen route mogelijk
      { logicalNodeId: "hub", distanceM: 800 },
    ];

    const result = await computeRouteWithFallback(provider, "v-test", graph, candidates, "target");

    expect("ok" in result).toBe(false);
    if ("selectedStartNodeId" in result) {
      expect(result.selectedStartNodeId).toBe("hub");
      expect(result.selectedStartNodeDisplayNumber).toBe("97");
      expect(result.selectedCandidateRank).toBe(2);
      expect(result.resolvedEdges).toHaveLength(1);
      expect(result.nodeDisplayNumbers).toEqual(["97", "99"]);
    }
  });

  it("gebruikt kandidaat 1 direct als die al werkt", async () => {
    const provider = await buildFixtureProvider();
    const graph = buildValidatedCombinedGraph(provider, [], 20, []);
    const candidates = [
      { logicalNodeId: "hub", distanceM: 100 },
      { logicalNodeId: "isolated", distanceM: 900 },
    ];
    const result = await computeRouteWithFallback(provider, "v-test", graph, candidates, "target");
    if ("selectedStartNodeId" in result) {
      expect(result.selectedCandidateRank).toBe(1);
    } else {
      throw new Error("verwachtte een succesvol resultaat");
    }
  });

  it("geeft een duidelijke faal-uitkomst als geen enkele kandidaat werkt", async () => {
    const provider = await buildFixtureProvider();
    const graph = buildValidatedCombinedGraph(provider, [], 20, []);
    const candidates = [{ logicalNodeId: "isolated", distanceM: 100 }];
    const result = await computeRouteWithFallback(provider, "v-test", graph, candidates, "target");
    expect("ok" in result && result.ok === false).toBe(true);
    if ("ok" in result && result.ok === false) {
      expect(result.reason).toBe("no_usable_candidate");
      expect(result.candidatesAttempted).toBe(1);
    }
  });

  it("[VERPLICHTE REGRESSIETEST, vervolg op sectie 9.50] kiest de daadwerkelijk KORTSTE herkomstkandidaat, niet zomaar de eerst-geprobeerde die werkt", async () => {
    const nodes: GraphNode[] = [
      { id: "originA", x: 0, y: 10000, displayNumber: "1" },
      { id: "detourMid", x: 0, y: 5000, displayNumber: "2" },
      { id: "target", x: 0, y: 0, displayNumber: "3" },
      { id: "originB", x: 100, y: 0, displayNumber: "4" },
    ];
    const edges: GraphEdge[] = [
      { id: "e1", fromLogicalNodeId: "originA", toLogicalNodeId: "detourMid", distanceM: 5000, directionality: "unknown", geometry: [{ x: 0, y: 10000 }, { x: 0, y: 5000 }] },
      { id: "e2", fromLogicalNodeId: "detourMid", toLogicalNodeId: "target", distanceM: 5000, directionality: "unknown", geometry: [{ x: 0, y: 5000 }, { x: 0, y: 0 }] },
      { id: "e3", fromLogicalNodeId: "originB", toLogicalNodeId: "target", distanceM: 100, directionality: "unknown", geometry: [{ x: 100, y: 0 }, { x: 0, y: 0 }] },
    ];
    const provider = new InMemoryGraphProvider(nodes, edges);
    await provider.load();
    const graph = buildValidatedCombinedGraph(provider, [], 20, []);

    const fromCandidates = [
      { logicalNodeId: "originA", distanceM: 50 },
      { logicalNodeId: "originB", distanceM: 300 },
    ];

    const result = await computeRouteWithFallback(provider, "v-test", graph, fromCandidates, "target");
    expect("selectedStartNodeId" in result).toBe(true);
    if ("selectedStartNodeId" in result) {
      expect(result.selectedStartNodeId).toBe("originB");
      expect(result.route.distanceM).toBe(100);
    }
  });
});
