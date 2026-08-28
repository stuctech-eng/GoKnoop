import { describe, it, expect, beforeAll } from "vitest";
import { InMemoryGraphProvider } from "./fixtures/in-memory-graph-provider";
import { ringNodes, ringEdges } from "./fixtures/ring-graph";
import { generateLoopRoutes } from "./loop-route-generator";
import { edgeOverlapRatio } from "./route-diversity";

describe("Loop Route Generator — generateLoopRoutes (ring-fixture)", () => {
  let provider: InMemoryGraphProvider;

  beforeAll(async () => {
    provider = new InMemoryGraphProvider(ringNodes, ringEdges);
    await provider.load();
  });

  it("elke gegenereerde lus begint en eindigt op de startnode", () => {
    const result = generateLoopRoutes(provider, "test", "S", 700, { count: 4 });
    expect(result.foundCount).toBeGreaterThan(0);
    for (const candidate of result.loops) {
      expect(candidate.route.nodes[0]).toBe("S");
      expect(candidate.route.nodes[candidate.route.nodes.length - 1]).toBe("S");
    }
  });

  it("de heenweg en terugweg delen geen edges (echt rondje, geen heen-en-terug over dezelfde weg)", () => {
    const result = generateLoopRoutes(provider, "test", "S", 700, { count: 4 });
    expect(result.foundCount).toBeGreaterThan(0);
    for (const candidate of result.loops) {
      const edges = candidate.route.edges;
      // Elke edge mag in een geldig rondje maximaal 1x voorkomen zolang het
      // een simpele lus is zonder zelfoverlap -- check op duplicaten binnen 1 route.
      const uniqueEdges = new Set(edges);
      expect(uniqueEdges.size).toBe(edges.length);
    }
  });

  it("benadert de gewenste afstand redelijk (binnen de fixture's natuurlijke lusgroottes)", () => {
    // Kortste mogelijke lus is ~553m (spaak+ring+spaak). Vraag om 700m,
    // een haalbare grootte binnen deze kleine ring-fixture.
    const result = generateLoopRoutes(provider, "test", "S", 700, { count: 4 });
    expect(result.foundCount).toBeGreaterThan(0);
    // De beste kandidaat (laagste afwijking) moet binnen een royale marge zitten
    // -- dit is een heuristiek, geen exacte match, dus geen strenge tolerantie.
    expect(result.loops[0].deviationPercent).toBeLessThan(60);
  });

  it("sorteert kandidaten op afwijking van de doelafstand (beste eerst)", () => {
    const result = generateLoopRoutes(provider, "test", "S", 700, { count: 4 });
    for (let i = 1; i < result.loops.length; i++) {
      expect(result.loops[i].deviationM).toBeGreaterThanOrEqual(result.loops[i - 1].deviationM);
    }
  });

  it("gevonden lussen zijn onderling voldoende verschillend (diversiteitscontract)", () => {
    const result = generateLoopRoutes(provider, "test", "S", 700, { count: 4, overlapThreshold: 0.6 });
    for (let i = 0; i < result.loops.length; i++) {
      for (let j = i + 1; j < result.loops.length; j++) {
        const overlap = edgeOverlapRatio(result.loops[i].route.edges, result.loops[j].route.edges);
        expect(overlap).toBeLessThanOrEqual(0.6);
      }
    }
  });

  it("geeft eerlijk minder lussen terug dan gevraagd als er niet meer diverse opties bestaan", () => {
    const result = generateLoopRoutes(provider, "test", "S", 700, { count: 100 });
    expect(result.foundCount).toBeLessThan(100);
    expect(result.loops.length).toBe(result.foundCount);
  });

  it("geeft 0 lussen terug voor een niet-bestaande startnode, zonder te crashen", () => {
    const result = generateLoopRoutes(provider, "test", "DOES_NOT_EXIST", 700, { count: 4 });
    expect(result.foundCount).toBe(0);
    expect(result.loops).toEqual([]);
  });

  it("edgesConsidered en distanceM zijn intern consistent (som van heen- en terugweg)", () => {
    const result = generateLoopRoutes(provider, "test", "S", 700, { count: 1 });
    expect(result.foundCount).toBe(1);
    const loop = result.loops[0];
    expect(loop.actualDistanceM).toBe(loop.route.distanceM);
    expect(loop.deviationM).toBe(Math.abs(loop.actualDistanceM - 700));
  });
});
