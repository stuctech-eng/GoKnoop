import { describe, it, expect } from "vitest";
import { computeRouteWithFallback } from "./route-to-point-fallback";
import { InMemoryGraphProvider } from "./fixtures/in-memory-graph-provider";
import type { GraphEdge, GraphNode } from "./types";

/**
 * Zelfde soort fixture als de loop-generator-fallback-tests (6B): een
 * kandidaat die volledig geïsoleerd is qua bereikbaarheid naar het doel
 * (geen edge, dus zelfs de Route Engine kan er niets mee), een andere die
 * wel werkt.
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
    const candidates = [
      { logicalNodeId: "isolated", distanceM: 200 }, // geen enkele edge, geen route mogelijk
      { logicalNodeId: "hub", distanceM: 800 },
    ];

    const result = computeRouteWithFallback(provider, "v-test", candidates, "target");

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
    const candidates = [
      { logicalNodeId: "hub", distanceM: 100 },
      { logicalNodeId: "isolated", distanceM: 900 },
    ];
    const result = computeRouteWithFallback(provider, "v-test", candidates, "target");
    if ("selectedStartNodeId" in result) {
      expect(result.selectedCandidateRank).toBe(1);
    } else {
      throw new Error("verwachtte een succesvol resultaat");
    }
  });

  it("geeft een duidelijke faal-uitkomst als geen enkele kandidaat werkt", async () => {
    const provider = await buildFixtureProvider();
    const candidates = [{ logicalNodeId: "isolated", distanceM: 100 }];
    const result = computeRouteWithFallback(provider, "v-test", candidates, "target");
    expect("ok" in result && result.ok === false).toBe(true);
    if ("ok" in result && result.ok === false) {
      expect(result.reason).toBe("no_usable_candidate");
      expect(result.candidatesAttempted).toBe(1);
    }
  });
});
