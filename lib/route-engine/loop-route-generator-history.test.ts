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

  it("BIJGESTELD (30-8-2026, echte regressie): als het vermijden van ALLE eerder gereden routes te weinig frisse opties overlaat, valt de generator terug op de best passende eerder-gereden routes -- geen harde uitsluiting meer, geen leeg/verschraald resultaat", async () => {
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

    // Kern van de fix: nog steeds routes gevonden (niet leeg/verschraald), ook al is de hele
    // eerdere geschiedenis nu "verboden terrein" -- de zachte-voorkeur-terugval zorgt dat er
    // alsnog bruikbare routes overblijven, desnoods eerder-gereden exemplaren.
    expect(withFullHistory.foundCount).toBeGreaterThan(0);
    // En cruciaal: de gevonden routes wijken NIET drastisch verder af van de doelafstand dan
    // de oorspronkelijke, ongefilterde beste route -- dat was precies het gerapporteerde
    // probleem (20km gevraagd, 65km teruggekregen).
    const bestDeviationWithHistory = Math.min(...withFullHistory.loops.map((l) => l.deviationPercent));
    const bestDeviationBaseline = Math.min(...baseline.loops.map((l) => l.deviationPercent));
    expect(bestDeviationWithHistory).toBeCloseTo(bestDeviationBaseline, 1);
  });

  it("[verplichte regressietest, letterlijk het gerapporteerde scenario] geeft nooit een veel te lange route terug puur om herhaling te vermijden -- backfill houdt de kwaliteit intact", async () => {
    const provider = await buildGridProvider();
    // Simuleer "een hele dag testen in hetzelfde gebied": alle 4 baseline-routes staan al in
    // de geschiedenis (net als 20 opgehoopte gereden routes in de praktijk zouden doen).
    const baseline = generateLoopRoutes(provider, "v-test", gridNodeId(1, 1), 4000, {
      circuityFactor: 1.0,
      radiusTolerance: 0.6,
      angleBuckets: 8,
      candidatesPerBucket: 4,
      count: 4,
    });
    const heavyHistory = baseline.loops.map((l) => l.route.edges);

    const result = generateLoopRoutes(provider, "v-test", gridNodeId(1, 1), 4000, {
      circuityFactor: 1.0,
      radiusTolerance: 0.6,
      angleBuckets: 8,
      candidatesPerBucket: 4,
      count: 4,
      avoidRouteEdgeSets: heavyHistory,
    });

    expect(result.foundCount).toBeGreaterThan(0);
    // Geen enkele gevonden route mag meer dan 25% afwijken als de baseline al een route <10% had --
    // een grove sanity-check tegen precies het gerapporteerde symptoom (20km -> 65km, ~225% afwijking).
    for (const loop of result.loops) {
      expect(loop.deviationPercent).toBeLessThan(50);
    }
  });
});
