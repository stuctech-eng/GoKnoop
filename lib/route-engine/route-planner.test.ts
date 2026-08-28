import { describe, it, expect, beforeAll } from "vitest";
import { InMemoryGraphProvider } from "./fixtures/in-memory-graph-provider";
import { diamondNodes, diamondEdges } from "./fixtures/diamond-graph";
import { fixtureNodes, fixtureEdges } from "./fixtures/simple-graph";
import { calculateAlternatives } from "./route-planner";
import { edgeOverlapRatio } from "./route-diversity";
import { computeRoute } from "./route-engine";

describe("route-diversity — edgeOverlapRatio", () => {
  it("geeft 1.0 voor identieke edge-sets", () => {
    expect(edgeOverlapRatio(["A", "B"], ["A", "B"])).toBe(1);
  });

  it("geeft 0.0 voor volledig disjuncte edge-sets", () => {
    expect(edgeOverlapRatio(["A", "B"], ["C", "D"])).toBe(0);
  });

  it("berekent de Jaccard-gelijkenis correct bij gedeeltelijke overlap", () => {
    // A={1,2,3}, B={2,3,4} -> intersectie=2, unie=4 -> 0.5
    expect(edgeOverlapRatio(["1", "2", "3"], ["2", "3", "4"])).toBe(0.5);
  });

  it("behandelt twee lege routes (zelfde start=eind) als identiek", () => {
    expect(edgeOverlapRatio([], [])).toBe(1);
  });
});

describe("RoutePlanner — calculateAlternatives", () => {
  describe("op de ruit-fixture (twee genuine paden)", () => {
    let provider: InMemoryGraphProvider;

    beforeAll(async () => {
      provider = new InMemoryGraphProvider(diamondNodes, diamondEdges);
      await provider.load();
    });

    it("vindt beide onafhankelijke paden als aparte alternatieven", () => {
      const result = calculateAlternatives(provider, "test", "N1", "N4", { count: 4 });
      expect(result.foundCount).toBe(2); // niet 4 -- er zijn er maar 2, en dat is eerlijk
      expect(result.routes.length).toBe(2);

      const distances = result.routes.map((r) => r.distanceM).sort((a, b) => a - b);
      expect(distances).toEqual([200, 220]); // pad via N2 (200) en via N3 (220)
    });

    it("de twee gevonden routes hebben geen overlappende edges (volledig verschillend tracé)", () => {
      const result = calculateAlternatives(provider, "test", "N1", "N4", { count: 4 });
      expect(result.routes.length).toBe(2);
      const overlap = edgeOverlapRatio(result.routes[0].edges, result.routes[1].edges);
      expect(overlap).toBe(0);
    });

    it("route 1 is altijd de kortste (geen constraints)", () => {
      const result = calculateAlternatives(provider, "test", "N1", "N4", { count: 4 });
      expect(result.routes[0].distanceM).toBe(200);
      expect(result.routes[0].edges).toEqual(["E1", "E2"]);
    });

    it("respecteert count=1 (alleen de kortste route, geen alternatieven gezocht)", () => {
      const result = calculateAlternatives(provider, "test", "N1", "N4", { count: 1 });
      expect(result.foundCount).toBe(1);
      expect(result.routes[0].distanceM).toBe(200);
    });
  });

  describe("op de lineaire simple-graph-fixture (slechts één zinvol pad)", () => {
    let provider: InMemoryGraphProvider;

    beforeAll(async () => {
      provider = new InMemoryGraphProvider(fixtureNodes, fixtureEdges);
      await provider.load();
    });

    it("geeft eerlijk 1 route terug i.p.v. te padden met duplicaten", () => {
      // N1->N3 heeft maar één werkelijk andere route (via E3, direct) --
      // zodra beide "paden" (via N2 en direct) zijn geprobeerd is er niets meer.
      const result = calculateAlternatives(provider, "test", "N1", "N3", { count: 4 });
      expect(result.foundCount).toBeLessThanOrEqual(2);
      expect(result.foundCount).toBeGreaterThanOrEqual(1);
      // Geen enkele geaccepteerde route mag een duplicaat van een andere zijn.
      for (let i = 0; i < result.routes.length; i++) {
        for (let j = i + 1; j < result.routes.length; j++) {
          expect(edgeOverlapRatio(result.routes[i].edges, result.routes[j].edges)).toBeLessThanOrEqual(0.7);
        }
      }
    });

    it("geeft 0 routes bij een onmogelijk pad (geïsoleerde node), zonder te crashen", () => {
      const result = calculateAlternatives(provider, "test", "N1", "N6", { count: 4 });
      expect(result.foundCount).toBe(0);
      expect(result.routes).toEqual([]);
    });
  });

  it("de onderliggende computeRoute()-primitive blijft ongewijzigd bruikbaar (regressiecheck)", async () => {
    const provider = new InMemoryGraphProvider(diamondNodes, diamondEdges);
    await provider.load();
    const single = computeRoute(provider, "test", "N1", "N4");
    expect("distanceM" in single && single.distanceM).toBe(200);
  });
});
