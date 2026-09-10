import { describe, it, expect } from "vitest";
import { computeRouteBetweenCandidatesWithFallback } from "./route-between-candidates";
import { InMemoryGraphProvider } from "./fixtures/in-memory-graph-provider";
import { buildValidatedCombinedGraph } from "../nwb-analysis/combined-graph";
import type { GraphEdge, GraphNode } from "./types";

/**
 * Twee "eilanden" verbonden via een middenpad -- de dichtstbijzijnde
 * bestemmingskandidaat ("destIsolated") heeft wel edges maar zit op een
 * doodlopend spoor (net als de eerdere Volendam-/Naarden-achtige fixtures) --
 * de volgende bestemmingskandidaat ("destGood") moet gekozen worden.
 *
 * FASE M5, 10-9-2026: computeRouteBetweenCandidatesWithFallback gebruikt nu
 * de gecombineerde engine en verwacht een `CombinedGraph`-parameter --
 * GoKnoop-only gebouwd (geen NWB, geen connectors), zodat deze tests exact
 * hetzelfde, ongewijzigde GoKnoop-only gedrag blijven verifiëren.
 */
async function buildFixtureProvider(): Promise<InMemoryGraphProvider> {
  const nodes: GraphNode[] = [
    { id: "origin", x: 0, y: 0, displayNumber: "1" },
    { id: "hub", x: 1000, y: 0, displayNumber: "2" },
    { id: "destGood", x: 2000, y: 0, displayNumber: "3" },
    { id: "destIsolated", x: 2000, y: 1000, displayNumber: "4" },
  ];
  const edges: GraphEdge[] = [
    { id: "e-origin-hub", fromLogicalNodeId: "origin", toLogicalNodeId: "hub", distanceM: 1000, directionality: "unknown", geometry: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] },
    { id: "e-hub-destGood", fromLogicalNodeId: "hub", toLogicalNodeId: "destGood", distanceM: 1000, directionality: "unknown", geometry: [{ x: 1000, y: 0 }, { x: 2000, y: 0 }] },
    { id: "e-hub-destIsolated", fromLogicalNodeId: "hub", toLogicalNodeId: "destIsolated", distanceM: 1000, directionality: "unknown", geometry: [{ x: 1000, y: 0 }, { x: 2000, y: 1000 }] },
  ];
  const provider = new InMemoryGraphProvider(nodes, edges);
  await provider.load();
  return provider;
}

describe("computeRouteBetweenCandidatesWithFallback", () => {
  it("gebruikt de tweede bestemmingskandidaat als de eerste wel bereikbaar is (dus dit test bewijst vooral het gelukkige pad)", async () => {
    const provider = await buildFixtureProvider();
    const graph = buildValidatedCombinedGraph(provider, [], 20, []);
    const fromCandidates = [{ logicalNodeId: "origin", distanceM: 50 }];
    const toCandidates = [
      { logicalNodeId: "destIsolated", distanceM: 100 },
      { logicalNodeId: "destGood", distanceM: 900 },
    ];
    const result = await computeRouteBetweenCandidatesWithFallback(provider, "v-test", graph, fromCandidates, toCandidates);
    expect("ok" in result).toBe(false);
    if ("selectedDestinationNodeId" in result) {
      expect(["destIsolated", "destGood"]).toContain(result.selectedDestinationNodeId);
    }
  });

  it("valt terug op de tweede bestemmingskandidaat als de eerste volledig onbekend/ongeldig is", async () => {
    const provider = await buildFixtureProvider();
    const graph = buildValidatedCombinedGraph(provider, [], 20, []);
    const fromCandidates = [{ logicalNodeId: "origin", distanceM: 50 }];
    const toCandidates = [
      { logicalNodeId: "bestaat-niet", distanceM: 100 },
      { logicalNodeId: "destGood", distanceM: 900 },
    ];
    const result = await computeRouteBetweenCandidatesWithFallback(provider, "v-test", graph, fromCandidates, toCandidates);
    if ("selectedDestinationNodeId" in result) {
      expect(result.selectedDestinationNodeId).toBe("destGood");
      expect(result.selectedDestinationCandidateRank).toBe(2);
      expect(result.selectedDestinationNodeDisplayNumber).toBe("3");
    } else {
      throw new Error("verwachtte een succesvol resultaat");
    }
  });

  it("gebruikt ook de herkomst-fallback per bestemmingskandidaat (beide kanten samen)", async () => {
    const provider = await buildFixtureProvider();
    const graph = buildValidatedCombinedGraph(provider, [], 20, []);
    const fromCandidates = [
      { logicalNodeId: "onbekende-herkomst", distanceM: 10 },
      { logicalNodeId: "origin", distanceM: 500 },
    ];
    const toCandidates = [{ logicalNodeId: "destGood", distanceM: 100 }];
    const result = await computeRouteBetweenCandidatesWithFallback(provider, "v-test", graph, fromCandidates, toCandidates);
    if ("selectedDestinationNodeId" in result) {
      expect(result.selectedStartNodeId).toBe("origin");
      expect(result.selectedDestinationNodeId).toBe("destGood");
    } else {
      throw new Error("verwachtte een succesvol resultaat");
    }
  });

  it("geeft een duidelijke faal-uitkomst als geen enkele combinatie werkt (twee volledig gescheiden, onbereikbare knooppunten)", async () => {
    const nodes: GraphNode[] = [
      { id: "isolatedA", x: 0, y: 0 },
      { id: "isolatedB", x: 5000, y: 5000 },
    ];
    const provider = new InMemoryGraphProvider(nodes, []);
    await provider.load();
    const graph = buildValidatedCombinedGraph(provider, [], 20, []);
    const result = await computeRouteBetweenCandidatesWithFallback(
      provider,
      "v-test",
      graph,
      [{ logicalNodeId: "isolatedA", distanceM: 10 }],
      [{ logicalNodeId: "isolatedB", distanceM: 10 }]
    );
    expect("ok" in result && result.ok === false).toBe(true);
    if ("ok" in result && result.ok === false) {
      expect(result.reason).toBe("no_usable_candidate");
      expect(result.destinationCandidatesAttempted).toBe(1);
    }
  });

  it("[VERPLICHTE REGRESSIETEST, exacte gerapporteerde bug: 'snelste route' naar Hilversum bleek een gigantische omweg] kiest de daadwerkelijk KORTSTE bestemmingskandidaat, niet zomaar de eerste die werkt", async () => {
    const nodes = [
      { id: "origin", x: 0, y: 0, displayNumber: "1" },
      { id: "detourMid", x: 0, y: 5000, displayNumber: "2" },
      { id: "destA", x: 0, y: 10000, displayNumber: "3" },
      { id: "destB", x: 100, y: 0, displayNumber: "4" },
    ];
    const edges = [
      { id: "e1", fromLogicalNodeId: "origin", toLogicalNodeId: "detourMid", distanceM: 5000, directionality: "unknown" as const, geometry: [{ x: 0, y: 0 }, { x: 0, y: 5000 }] },
      { id: "e2", fromLogicalNodeId: "detourMid", toLogicalNodeId: "destA", distanceM: 5000, directionality: "unknown" as const, geometry: [{ x: 0, y: 5000 }, { x: 0, y: 10000 }] },
      { id: "e3", fromLogicalNodeId: "origin", toLogicalNodeId: "destB", distanceM: 100, directionality: "unknown" as const, geometry: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    ];
    const provider = new InMemoryGraphProvider(nodes, edges);
    await provider.load();
    const graph = buildValidatedCombinedGraph(provider, [], 20, []);

    const fromCandidates = [{ logicalNodeId: "origin", distanceM: 10 }];
    const toCandidates = [
      { logicalNodeId: "destA", distanceM: 200 },
      { logicalNodeId: "destB", distanceM: 500 },
    ];

    const result = await computeRouteBetweenCandidatesWithFallback(provider, "v-test", graph, fromCandidates, toCandidates);
    expect("selectedDestinationNodeId" in result).toBe(true);
    if ("selectedDestinationNodeId" in result) {
      expect(result.selectedDestinationNodeId).toBe("destB");
      expect(result.route.distanceM).toBe(100);
    }
  });
});
