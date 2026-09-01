import { describe, it, expect } from "vitest";
import { generateLoopRoutes } from "./loop-route-generator";
import { InMemoryGraphProvider } from "./fixtures/in-memory-graph-provider";
import type { GraphEdge, GraphNode } from "./types";

/**
 * Fase 2 (gereden-routes-tracking, 29-8-2026): een 3x3-rastergraaf (zelfde
 * fixture-stijl als loop-route-generator.integration.test.ts) waarin
 * meerdere lussen mogelijk zijn -- bewijst dat `avoidRouteEdgeSets` een
 * kandidaat die te veel overlapt met een eerder gereden route overslaat,
 * en de andere kandidaten wél gewoon oplevert.
 */

const SPACING = 1000;

function gridNodeId(row: number, col: number): string {
  return `n${row}_${col}`;
}

async function buildGridProvider(): Promise<InMemoryGraphProvider> {
  const nodes: GraphNode[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      nodes.push({ id: gridNodeId(row, col), x: col * SPACING, y: row * SPACING });
    }
  }
  const edges: GraphEdge[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      if (col < 2) {
        const a = gridNodeId(row, col);
        const b = gridNodeId(row, col + 1);
        edges.push({ id: `e-${a}-${b}`, fromLogicalNodeId: a, toLogicalNodeId: b, distanceM: SPACING, directionality: "unknown", geometry: [{ x: col * SPACING, y: row * SPACING }, { x: (col + 1) * SPACING, y: row * SPACING }] });
      }
      if (row < 2) {
        const a = gridNodeId(row, col);
        const b = gridNodeId(row + 1, col);
        edges.push({ id: `e-${a}-${b}`, fromLogicalNodeId: a, toLogicalNodeId: b, distanceM: SPACING, directionality: "unknown", geometry: [{ x: col * SPACING, y: row * SPACING }, { x: col * SPACING, y: (row + 1) * SPACING }] });
      }
    }
  }
  const provider = new InMemoryGraphProvider(nodes, edges);
  await provider.load();
  return provider;
}

describe("generateLoopRoutes — avoidRouteEdgeSets (Fase 2: gereden routes vermijden)", () => {
  it("zonder avoidRouteEdgeSets: gewoon kandidaten gevonden zoals altijd", async () => {
    const provider = await buildGridProvider();
    const result = generateLoopRoutes(provider, "v-test", gridNodeId(1, 1), 4000, {
      circuityFactor: 1.0,
      radiusTolerance: 0.6,
      angleBuckets: 8,
      candidatesPerBucket: 4,
      count: 4,
    });
    expect(result.foundCount).toBeGreaterThan(0);
    expect(result.diagnostics.historyRejected).toBe(0);
  });

  it("met avoidRouteEdgeSets die identiek zijn aan de EERSTE kandidaat: die kandidaat wordt overgeslagen, historyRejected > 0", async () => {
    const provider = await buildGridProvider();

    // Eerst zonder geschiedenis draaien om te weten welke edges de beste (eerste) kandidaat gebruikt.
    const baseline = generateLoopRoutes(provider, "v-test", gridNodeId(1, 1), 4000, {
      circuityFactor: 1.0,
      radiusTolerance: 0.6,
      angleBuckets: 8,
      candidatesPerBucket: 4,
      count: 1,
    });
    expect(baseline.foundCount).toBeGreaterThan(0);
    const riddenEdges = baseline.loops[0].route.edges;

    // Nu opnieuw draaien, met die exacte edge-set als "eerder gereden" -- de eerste kandidaat
    // moet nu overgeslagen worden.
    const withHistory = generateLoopRoutes(provider, "v-test", gridNodeId(1, 1), 4000, {
      circuityFactor: 1.0,
      radiusTolerance: 0.6,
      angleBuckets: 8,
      candidatesPerBucket: 4,
      count: 1,
      avoidRouteEdgeSets: [riddenEdges],
    });

    expect(withHistory.diagnostics.historyRejected).toBeGreaterThan(0);
    if (withHistory.foundCount > 0) {
      // Als er nog een andere, voldoende afwijkende kandidaat gevonden is, mag die NIET
      // de exact eerder gereden edge-set zijn.
      expect(withHistory.loops[0].route.edges).not.toEqual(riddenEdges);
    }
  });

  it("een lege avoidRouteEdgeSets-array gedraagt zich identiek aan het weglaten ervan", async () => {
    const provider = await buildGridProvider();
    const withEmpty = generateLoopRoutes(provider, "v-test", gridNodeId(1, 1), 4000, {
      circuityFactor: 1.0,
      radiusTolerance: 0.6,
      angleBuckets: 8,
      candidatesPerBucket: 4,
      count: 4,
      avoidRouteEdgeSets: [],
    });
    expect(withEmpty.diagnostics.historyRejected).toBe(0);
  });

  it("meerdere eerder gereden routes tegelijk worden allemaal gecontroleerd", async () => {
    const provider = await buildGridProvider();
    const baseline = generateLoopRoutes(provider, "v-test", gridNodeId(1, 1), 4000, {
      circuityFactor: 1.0,
      radiusTolerance: 0.6,
      angleBuckets: 8,
      candidatesPerBucket: 4,
      count: 4,
    });
    expect(baseline.foundCount).toBeGreaterThanOrEqual(2);
    const allRiddenEdgeSets = baseline.loops.map((l) => l.route.edges);

    const withFullHistory = generateLoopRoutes(provider, "v-test", gridNodeId(1, 1), 4000, {
      circuityFactor: 1.0,
      radiusTolerance: 0.6,
      angleBuckets: 8,
      candidatesPerBucket: 4,
      count: 4,
      avoidRouteEdgeSets: allRiddenEdgeSets,
    });

    // Alle eerder gevonden routes staan nu in de geschiedenis -- geen van de nieuwe
    // resultaten mag daar nog exact mee overeenkomen.
    for (const loop of withFullHistory.loops) {
      const matchesHistory = allRiddenEdgeSets.some((ridden) => JSON.stringify(ridden) === JSON.stringify(loop.route.edges));
      expect(matchesHistory).toBe(false);
    }
  });
});
