import { describe, it, expect } from "vitest";
import { generateLoopRoutes } from "./loop-route-generator";
import { InMemoryGraphProvider } from "./fixtures/in-memory-graph-provider";
import { buildRouteProgressModel } from "../navigation/progress/route-progress-model";
import type { GraphEdge, GraphNode } from "./types";

/**
 * Bewijst de kern van de Phase 4-UI-integratiestap (GOKNOOP-MASTER.md
 * sectie 7): "Route Engine → GraphEdge[] → Navigation Engine → Map/UI"
 * blijft één bron van waarheid. Geen tweede/parallel route-datamodel --
 * `LoopCandidate.resolvedEdges` uit de ECHTE `generateLoopRoutes()` wordt
 * hier rechtstreeks aan `buildRouteProgressModel()` (Navigation Engine,
 * stap 5) gevoerd.
 */

const SPACING = 1000; // meter tussen naburige grid-nodes

function gridNodeId(row: number, col: number): string {
  return `n${row}_${col}`;
}

function nodePoint(row: number, col: number) {
  return { x: col * SPACING, y: row * SPACING };
}

function edge(
  overrides: Partial<GraphEdge> & Pick<GraphEdge, "id" | "fromLogicalNodeId" | "toLogicalNodeId" | "distanceM" | "geometry">
): GraphEdge {
  return { directionality: "unknown", ...overrides };
}

/** 3x3-rastergraaf, alle buren verbonden -- ruim voldoende kandidaten voor de rondje-heuristiek om een lus te vinden. */
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
        edges.push(
          edge({ id: `e-${a}-${b}`, fromLogicalNodeId: a, toLogicalNodeId: b, distanceM: SPACING, geometry: [nodePoint(row, col), nodePoint(row, col + 1)] })
        );
      }
      if (row < 2) {
        const a = gridNodeId(row, col);
        const b = gridNodeId(row + 1, col);
        edges.push(
          edge({ id: `e-${a}-${b}`, fromLogicalNodeId: a, toLogicalNodeId: b, distanceM: SPACING, geometry: [nodePoint(row, col), nodePoint(row + 1, col)] })
        );
      }
    }
  }

  const provider = new InMemoryGraphProvider(nodes, edges);
  await provider.load();
  return provider;
}

describe("generateLoopRoutes + resolveRouteEdges — Route Engine → GraphEdge[] → Navigation Engine (geen gat)", () => {
  it("resolvedEdges van een gevonden lus is direct bruikbaar door buildRouteProgressModel, met matchende totaalafstand", async () => {
    const provider = await buildGridProvider();
    const result = generateLoopRoutes(provider, "v-test", gridNodeId(1, 1), 4000, {
      circuityFactor: 1.0,
      radiusTolerance: 0.6,
      angleBuckets: 8,
      candidatesPerBucket: 4,
      count: 1,
    });

    expect(result.foundCount).toBeGreaterThan(0); // de heuristiek moet op dit eenvoudige rooster minstens één lus vinden

    const loop = result.loops[0];
    expect(loop.resolvedEdges).toHaveLength(loop.route.edges.length);
    expect(loop.resolvedEdges.map((e) => e.id)).toEqual(loop.route.edges); // exacte volgorde/inhoud, geen reconstructie

    // DE KERNPROEF: dit is precies wat de Navigation Engine (stap 5) nodig heeft --
    // rechtstreeks, zonder tussenstap, zonder de edges opnieuw af te leiden.
    const model = buildRouteProgressModel(loop.resolvedEdges, loop.route.nodes);

    // Distance-invariant blijft intact over de grens Route Engine <-> Navigation Engine heen:
    // de som van de ECHTE edge.distanceM-waarden (Navigation Engine) komt overeen met
    // route.distanceM (Route Engine) -- geen tweede, afwijkende afstandsbron.
    expect(model.totalDistanceM).toBeCloseTo(loop.route.distanceM, 6);
  });

  it("elke geaccepteerde lus in een grotere aanvraag heeft consistente resolvedEdges", async () => {
    const provider = await buildGridProvider();
    const result = generateLoopRoutes(provider, "v-test", gridNodeId(1, 1), 4000, {
      circuityFactor: 1.0,
      radiusTolerance: 0.6,
      angleBuckets: 8,
      candidatesPerBucket: 4,
      count: 4,
    });

    for (const loop of result.loops) {
      expect(loop.resolvedEdges.map((e) => e.id)).toEqual(loop.route.edges);
      const model = buildRouteProgressModel(loop.resolvedEdges, loop.route.nodes);
      expect(model.totalDistanceM).toBeCloseTo(loop.route.distanceM, 6);
    }
  });
});
