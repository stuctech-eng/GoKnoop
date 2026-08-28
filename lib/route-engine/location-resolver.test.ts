import { describe, it, expect } from "vitest";
import { InMemoryGraphProvider } from "./fixtures/in-memory-graph-provider";
import { resolveNearestNodes } from "./location-resolver";
import type { GraphEdge } from "./types";

/** Simpele edge waarmee een node "routeerbaar" wordt in de testfixtures. */
function edgeBetween(id: string, a: string, b: string): GraphEdge {
  return { id, fromLogicalNodeId: a, toLogicalNodeId: b, distanceM: 1, directionality: "unknown", geometry: [] };
}

describe("Location Resolver — resolveNearestNodes", () => {
  it("sorteert op afstand, dichtstbijzijnde eerst", async () => {
    const provider = new InMemoryGraphProvider(
      [
        { id: "A", x: 0, y: 0 },
        { id: "B", x: 100, y: 0 },
        { id: "C", x: 50, y: 0 },
        { id: "D", x: 1000, y: 0 },
      ],
      [edgeBetween("e1", "A", "B"), edgeBetween("e2", "B", "C"), edgeBetween("e3", "C", "D")]
    );
    await provider.load();

    const result = resolveNearestNodes(provider, { x: 0, y: 0 }, 3);
    expect(result.map((c) => c.logicalNodeId)).toEqual(["A", "C", "B"]);
    expect(result[0].distanceM).toBe(0);
    expect(result[1].distanceM).toBe(50);
    expect(result[2].distanceM).toBe(100);
  });

  it("respecteert de limit-parameter", async () => {
    const provider = new InMemoryGraphProvider(
      [
        { id: "A", x: 0, y: 0 },
        { id: "B", x: 10, y: 0 },
        { id: "C", x: 20, y: 0 },
        { id: "D", x: 30, y: 0 },
        { id: "E", x: 40, y: 0 },
      ],
      [edgeBetween("e1", "A", "B"), edgeBetween("e2", "B", "C"), edgeBetween("e3", "C", "D"), edgeBetween("e4", "D", "E")]
    );
    await provider.load();

    const result = resolveNearestNodes(provider, { x: 0, y: 0 }, 2);
    expect(result.length).toBe(2);
  });

  it("geeft een lege lijst bij een lege graph", async () => {
    const provider = new InMemoryGraphProvider([], []);
    await provider.load();
    const result = resolveNearestNodes(provider, { x: 0, y: 0 });
    expect(result).toEqual([]);
  });

  it("geeft displayNumber/displayRegio mee als die aanwezig zijn", async () => {
    const provider = new InMemoryGraphProvider(
      [
        { id: "A", x: 0, y: 0, displayNumber: "42", displayRegio: "Utrecht" },
        { id: "B", x: 10, y: 0 },
      ],
      [edgeBetween("e1", "A", "B")]
    );
    await provider.load();
    const result = resolveNearestNodes(provider, { x: 0, y: 0 });
    expect(result[0].displayNumber).toBe("42");
    expect(result[0].displayRegio).toBe("Utrecht");
  });

  // --- Regressietest voor de Amsterdam-bug (28-8-2026) ---
  describe("uitsluiting van geïsoleerde nodes (0 edges)", () => {
    it("sluit een volledig geïsoleerde node uit, ook als die het dichtstbij is", async () => {
      const provider = new InMemoryGraphProvider(
        [
          { id: "ISOLATED", x: 0, y: 0 }, // dichtstbij, maar 0 edges
          { id: "ROUTABLE", x: 50, y: 0 }, // verder weg, maar wel bruikbaar
          { id: "OTHER", x: 60, y: 0 },
        ],
        [edgeBetween("e1", "ROUTABLE", "OTHER")] // ISOLATED heeft bewust geen enkele edge
      );
      await provider.load();

      const result = resolveNearestNodes(provider, { x: 0, y: 0 }, 5);
      expect(result.map((c) => c.logicalNodeId)).not.toContain("ISOLATED");
      expect(result.map((c) => c.logicalNodeId)).toEqual(["ROUTABLE", "OTHER"]);
    });

    it("geeft edgeCount mee in het resultaat, voor diagnose", async () => {
      const provider = new InMemoryGraphProvider(
        [
          { id: "A", x: 0, y: 0 },
          { id: "B", x: 10, y: 0 },
          { id: "C", x: 20, y: 0 },
        ],
        [edgeBetween("e1", "A", "B"), edgeBetween("e2", "A", "C")]
      );
      await provider.load();

      const result = resolveNearestNodes(provider, { x: 0, y: 0 });
      const nodeA = result.find((c) => c.logicalNodeId === "A");
      expect(nodeA?.edgeCount).toBe(2); // A heeft 2 edges (naar B en naar C)
    });

    it("geeft een lege lijst als ALLE nodes geïsoleerd zijn (geen edges in de hele graph)", async () => {
      const provider = new InMemoryGraphProvider(
        [
          { id: "A", x: 0, y: 0 },
          { id: "B", x: 10, y: 0 },
        ],
        []
      );
      await provider.load();
      const result = resolveNearestNodes(provider, { x: 0, y: 0 });
      expect(result).toEqual([]);
    });
  });
});
