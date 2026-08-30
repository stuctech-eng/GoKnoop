import { describe, it, expect } from "vitest";
import { generateLoopRoutesWithFallback } from "./loop-route-generator";
import { InMemoryGraphProvider } from "./fixtures/in-memory-graph-provider";
import type { GraphEdge, GraphNode } from "./types";

/**
 * Fixture die het Volendam-patroon nabootst: kandidaat "deadend" heeft
 * edges (dus niet geïsoleerd), maar is een doodlopende spoor -- elke
 * heenweg vanaf "deadend" gebruikt de enige edge die het knooppunt heeft,
 * waardoor een terugweg die die edge vermijdt GEGARANDEERD onmogelijk is.
 * Kandidaat "hub" zit middenin een goed verbonden rastergraaf en moet wél
 * werken. Dit isoleert het FALLBACK-MECHANISME zelf, los van de precieze
 * (in het echt rijkere) reden waarom een knooppunt kan falen.
 */
async function buildDeadEndFixture(): Promise<InMemoryGraphProvider> {
  const nodes: GraphNode[] = [
    { id: "deadend", x: -1000, y: 0, displayNumber: "96" },
    { id: "hub", x: 0, y: 0, displayNumber: "97" },
    { id: "n1", x: 1000, y: 0, displayNumber: "1" },
    { id: "n2", x: 2000, y: 0, displayNumber: "2" },
    { id: "n3", x: 1000, y: 1000, displayNumber: "3" },
    { id: "n4", x: 2000, y: 1000, displayNumber: "4" },
    { id: "n5", x: 1000, y: -1000, displayNumber: "5" },
    { id: "n6", x: 2000, y: -1000, displayNumber: "6" },
  ];

  const edges: GraphEdge[] = [
    { id: "e-deadend-hub", fromLogicalNodeId: "deadend", toLogicalNodeId: "hub", distanceM: 1000, directionality: "unknown", geometry: [{ x: -1000, y: 0 }, { x: 0, y: 0 }] },
    { id: "e-hub-n1", fromLogicalNodeId: "hub", toLogicalNodeId: "n1", distanceM: 1000, directionality: "unknown", geometry: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] },
    { id: "e-n1-n2", fromLogicalNodeId: "n1", toLogicalNodeId: "n2", distanceM: 1000, directionality: "unknown", geometry: [{ x: 1000, y: 0 }, { x: 2000, y: 0 }] },
    { id: "e-n1-n3", fromLogicalNodeId: "n1", toLogicalNodeId: "n3", distanceM: 1000, directionality: "unknown", geometry: [{ x: 1000, y: 0 }, { x: 1000, y: 1000 }] },
    { id: "e-n2-n4", fromLogicalNodeId: "n2", toLogicalNodeId: "n4", distanceM: 1000, directionality: "unknown", geometry: [{ x: 2000, y: 0 }, { x: 2000, y: 1000 }] },
    { id: "e-n3-n4", fromLogicalNodeId: "n3", toLogicalNodeId: "n4", distanceM: 1000, directionality: "unknown", geometry: [{ x: 1000, y: 1000 }, { x: 2000, y: 1000 }] },
    { id: "e-hub-n5", fromLogicalNodeId: "hub", toLogicalNodeId: "n5", distanceM: 1000, directionality: "unknown", geometry: [{ x: 0, y: 0 }, { x: 1000, y: -1000 }] },
    { id: "e-n5-n6", fromLogicalNodeId: "n5", toLogicalNodeId: "n6", distanceM: 1000, directionality: "unknown", geometry: [{ x: 1000, y: -1000 }, { x: 2000, y: -1000 }] },
    { id: "e-n1-n5", fromLogicalNodeId: "n1", toLogicalNodeId: "n5", distanceM: 1000, directionality: "unknown", geometry: [{ x: 1000, y: 0 }, { x: 1000, y: -1000 }] },
    { id: "e-n2-n6", fromLogicalNodeId: "n2", toLogicalNodeId: "n6", distanceM: 1000, directionality: "unknown", geometry: [{ x: 2000, y: 0 }, { x: 2000, y: -1000 }] },
  ];

  const provider = new InMemoryGraphProvider(nodes, edges);
  await provider.load();
  return provider;
}

describe("generateLoopRoutesWithFallback — het exacte Volendam-patroon (kandidaat 1 faalt, kandidaat 2 werkt)", () => {
  it("valt terug van 'deadend' naar 'hub' en rapporteert transparant welke kandidaat daadwerkelijk gebruikt is", async () => {
    const provider = await buildDeadEndFixture();
    const candidates = [
      { logicalNodeId: "deadend", distanceM: 538 },
      { logicalNodeId: "hub", distanceM: 1055 },
    ];

    const result = generateLoopRoutesWithFallback(provider, "v-test", candidates, 2000, { circuityFactor: 1.0, radiusTolerance: 0.6, count: 4 });

    expect("ok" in result).toBe(false);
    if ("selectedStartNodeId" in result) {
      expect(result.selectedStartNodeId).toBe("hub");
      expect(result.selectedStartNodeDisplayNumber).toBe("97");
      expect(result.selectedCandidateRank).toBe(2);
      expect(result.selectedStartNodeDistanceM).toBe(1055);
      expect(result.candidatesAttempted).toBe(2);
      expect(result.foundCount).toBeGreaterThan(0);
    }
  });

  it("gebruikt kandidaat 1 direct (rank 1) als die al bruikbare routes oplevert -- geen onnodige extra pogingen", async () => {
    const provider = await buildDeadEndFixture();
    const candidates = [
      { logicalNodeId: "hub", distanceM: 100 },
      { logicalNodeId: "deadend", distanceM: 900 },
    ];

    const result = generateLoopRoutesWithFallback(provider, "v-test", candidates, 2000, { circuityFactor: 1.0, radiusTolerance: 0.6, count: 4 });

    if ("selectedStartNodeId" in result) {
      expect(result.selectedStartNodeId).toBe("hub");
      expect(result.selectedCandidateRank).toBe(1);
      expect(result.candidatesAttempted).toBe(1);
    } else {
      throw new Error("verwachtte een succesvol resultaat");
    }
  });

  it("geeft een duidelijke faal-uitkomst als GEEN enkele kandidaat een route oplevert", async () => {
    const provider = await buildDeadEndFixture();
    const candidates = [
      { logicalNodeId: "deadend", distanceM: 538 },
      { logicalNodeId: "deadend", distanceM: 538 },
    ];

    const result = generateLoopRoutesWithFallback(provider, "v-test", candidates, 2000, { circuityFactor: 1.0, radiusTolerance: 0.6, count: 4 });

    expect("ok" in result && result.ok === false).toBe(true);
    if ("ok" in result && result.ok === false) {
      expect(result.reason).toBe("no_usable_candidate");
      expect(result.candidatesAttempted).toBe(2);
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts.every((a) => a.foundCount === 0)).toBe(true);
    }
  });

  it("slaat een onbekend logicalNodeId over zonder te crashen, en probeert de volgende kandidaat", async () => {
    const provider = await buildDeadEndFixture();
    const candidates = [
      { logicalNodeId: "bestaat-niet", distanceM: 100 },
      { logicalNodeId: "hub", distanceM: 200 },
    ];

    const result = generateLoopRoutesWithFallback(provider, "v-test", candidates, 2000, { circuityFactor: 1.0, radiusTolerance: 0.6, count: 4 });

    if ("selectedStartNodeId" in result) {
      expect(result.selectedStartNodeId).toBe("hub");
      expect(result.selectedCandidateRank).toBe(2);
    } else {
      throw new Error("verwachtte een succesvol resultaat");
    }
  });

  it("selectedStartNodeDistanceM is null als de aanroeper geen afstand heeft meegegeven voor die kandidaat", async () => {
    const provider = await buildDeadEndFixture();
    const candidates = [{ logicalNodeId: "hub" }];

    const result = generateLoopRoutesWithFallback(provider, "v-test", candidates, 2000, { circuityFactor: 1.0, radiusTolerance: 0.6, count: 4 });

    if ("selectedStartNodeId" in result) {
      expect(result.selectedStartNodeDistanceM).toBeNull();
    } else {
      throw new Error("verwachtte een succesvol resultaat");
    }
  });
});
