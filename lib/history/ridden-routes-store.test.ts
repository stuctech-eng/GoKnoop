import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getRiddenRoutes, recordRiddenRoute } from "./ridden-routes-store";

/**
 * Lichte, handmatige localStorage-polyfill (geen jsdom-afhankelijkheid nodig)
 * -- puur om de opslaglogica zelf te bewijzen, niet om een browseromgeving
 * na te bootsen.
 */
function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
}

describe("ridden-routes-store", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { localStorage: createMemoryStorage() };
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it("geeft een lege array terug als er nog niets is opgeslagen", () => {
    expect(getRiddenRoutes()).toEqual([]);
  });

  it("slaat een gereden route op en kan 'm weer teruglezen", () => {
    recordRiddenRoute({ edgeIds: ["e1", "e2"], nodeIds: ["n1", "n2", "n3"], startNodeId: "n1", distanceM: 5000 });
    const routes = getRiddenRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0].edgeIds).toEqual(["e1", "e2"]);
    expect(routes[0].distanceM).toBe(5000);
    expect(typeof routes[0].riddenAt).toBe("string");
  });

  it("nieuwste route staat vooraan", () => {
    recordRiddenRoute({ edgeIds: ["e1"], nodeIds: ["n1", "n2"], startNodeId: "n1", distanceM: 1000, riddenAt: "2026-08-01T00:00:00.000Z" });
    recordRiddenRoute({ edgeIds: ["e2"], nodeIds: ["n1", "n3"], startNodeId: "n1", distanceM: 2000, riddenAt: "2026-08-29T00:00:00.000Z" });
    const routes = getRiddenRoutes();
    expect(routes[0].edgeIds).toEqual(["e2"]);
    expect(routes[1].edgeIds).toEqual(["e1"]);
  });

  it("begrenst het aantal opgeslagen routes (voorkomt onbeperkte groei)", () => {
    for (let i = 0; i < 25; i++) {
      recordRiddenRoute({ edgeIds: [`e${i}`], nodeIds: ["n1", "n2"], startNodeId: "n1", distanceM: 1000 });
    }
    expect(getRiddenRoutes().length).toBeLessThanOrEqual(20);
  });

  it("gooit nooit een fout als localStorage ontbreekt (SSR-veilig)", () => {
    (globalThis as { window?: unknown }).window = undefined;
    expect(() => recordRiddenRoute({ edgeIds: ["e1"], nodeIds: ["n1", "n2"], startNodeId: "n1", distanceM: 1000 })).not.toThrow();
    expect(getRiddenRoutes()).toEqual([]);
  });

  it("geeft een lege array terug bij corrupte opslag, geen crash", () => {
    (globalThis as { window: { localStorage: Storage } }).window.localStorage.setItem("goknoop.riddenRoutes.v1", "{niet geldig json");
    expect(getRiddenRoutes()).toEqual([]);
  });
});
