import { describe, it, expect } from "vitest";
import { InMemoryGraphProvider } from "./fixtures/in-memory-graph-provider";
import { resolveNearestNodes } from "./location-resolver";

describe("Location Resolver — resolveNearestNodes", () => {
  it("sorteert op afstand, dichtstbijzijnde eerst", async () => {
    const provider = new InMemoryGraphProvider(
      [
        { id: "A", x: 0, y: 0 },
        { id: "B", x: 100, y: 0 },
        { id: "C", x: 50, y: 0 },
        { id: "D", x: 1000, y: 0 },
      ],
      []
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
      []
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
      [{ id: "A", x: 0, y: 0, displayNumber: "42", displayRegio: "Utrecht" }],
      []
    );
    await provider.load();
    const result = resolveNearestNodes(provider, { x: 0, y: 0 });
    expect(result[0].displayNumber).toBe("42");
    expect(result[0].displayRegio).toBe("Utrecht");
  });
});
