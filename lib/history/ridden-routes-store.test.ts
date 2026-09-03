import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getRiddenRoutes, getRecentRiddenRoutesForDedup, recordRiddenRoute } from "./ridden-routes-store";

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

const BASE = { edgeIds: ["e1", "e2"], nodeIds: ["n1", "n2", "n3"], startNodeId: "n1", datasetVersionId: "v1", distanceM: 5000 };

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

  it("slaat een gereden route op en kan 'm weer teruglezen, met een uniek id en datasetVersionId", () => {
    recordRiddenRoute(BASE);
    const routes = getRiddenRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0].edgeIds).toEqual(["e1", "e2"]);
    expect(routes[0].distanceM).toBe(5000);
    expect(routes[0].datasetVersionId).toBe("v1");
    expect(typeof routes[0].id).toBe("string");
    expect(typeof routes[0].riddenAt).toBe("string");
  });

  it("nieuwste route staat vooraan", () => {
    recordRiddenRoute({ ...BASE, edgeIds: ["e1"], distanceM: 1000, riddenAt: "2026-08-01T00:00:00.000Z" });
    recordRiddenRoute({ ...BASE, edgeIds: ["e2"], distanceM: 2000, riddenAt: "2026-08-29T00:00:00.000Z" });
    const routes = getRiddenRoutes();
    expect(routes[0].edgeIds).toEqual(["e2"]);
    expect(routes[1].edgeIds).toEqual(["e1"]);
  });

  it("[BIJGESTELD 30-8-2026, 'nooit weggooien'] geen limiet meer op het aantal opgeslagen routes", () => {
    for (let i = 0; i < 30; i++) {
      recordRiddenRoute({ ...BASE, edgeIds: [`e${i}`] });
    }
    expect(getRiddenRoutes().length).toBe(30); // ALLES blijft bewaard, geen begrenzing meer
  });

  it("getRecentRiddenRoutesForDedup begrenst WEL (voor de server-aanroep), zonder de opslag zelf aan te tasten", () => {
    for (let i = 0; i < 30; i++) {
      recordRiddenRoute({ ...BASE, edgeIds: [`e${i}`] });
    }
    expect(getRiddenRoutes().length).toBe(30); // volledige opslag ongewijzigd
    expect(getRecentRiddenRoutesForDedup().length).toBe(20); // alleen de dedup-aanroep begrensd
    expect(getRecentRiddenRoutesForDedup(5).length).toBe(5); // aanpasbare limiet
  });

  it("gooit nooit een fout als localStorage ontbreekt (SSR-veilig)", () => {
    (globalThis as { window?: unknown }).window = undefined;
    expect(() => recordRiddenRoute(BASE)).not.toThrow();
    expect(getRiddenRoutes()).toEqual([]);
  });

  it("geeft een lege array terug bij corrupte opslag, geen crash", () => {
    (globalThis as { window: { localStorage: Storage } }).window.localStorage.setItem("goknoop.riddenRoutes.v1", "{niet geldig json");
    expect(getRiddenRoutes()).toEqual([]);
  });
});
