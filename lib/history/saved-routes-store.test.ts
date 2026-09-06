import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSavedRoutes, saveRoute, deleteSavedRoute, defaultSavedRouteName } from "./saved-routes-store";

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

describe("saved-routes-store", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { localStorage: createMemoryStorage() };
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it("geeft een lege array terug als er nog niets bewaard is", () => {
    expect(getSavedRoutes()).toEqual([]);
  });

  it("bewaart een route met naam en kan 'm teruglezen", () => {
    saveRoute({ name: "Rondje Waterland", edgeIds: ["e1", "e2"], nodeIds: ["n1", "n2", "n3"], startNodeId: "n1", distanceM: 32600, datasetVersionId: "v1" });
    const routes = getSavedRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0].name).toBe("Rondje Waterland");
    expect(routes[0].id).toBeTruthy();
  });

  it("bewaart een route zonder naam (null) -- geen verplichting om te benoemen", () => {
    saveRoute({ name: null, edgeIds: ["e1"], nodeIds: ["n1", "n2"], startNodeId: "n1", distanceM: 5000, datasetVersionId: "v1" });
    expect(getSavedRoutes()[0].name).toBeNull();
  });

  it("nieuwste route staat vooraan", () => {
    saveRoute({ name: "Eerste", edgeIds: ["e1"], nodeIds: ["n1", "n2"], startNodeId: "n1", distanceM: 1000, datasetVersionId: "v1", savedAt: "2026-08-01T00:00:00.000Z" });
    saveRoute({ name: "Tweede", edgeIds: ["e2"], nodeIds: ["n1", "n3"], startNodeId: "n1", distanceM: 2000, datasetVersionId: "v1", savedAt: "2026-08-29T00:00:00.000Z" });
    const routes = getSavedRoutes();
    expect(routes[0].name).toBe("Tweede");
    expect(routes[1].name).toBe("Eerste");
  });

  it("elke opgeslagen route krijgt een uniek ID", () => {
    const a = saveRoute({ name: "A", edgeIds: ["e1"], nodeIds: ["n1", "n2"], startNodeId: "n1", distanceM: 1000, datasetVersionId: "v1" });
    const b = saveRoute({ name: "B", edgeIds: ["e2"], nodeIds: ["n1", "n3"], startNodeId: "n1", distanceM: 2000, datasetVersionId: "v1" });
    expect(a.id).not.toBe(b.id);
  });

  it("verwijdert een route op ID", () => {
    const saved = saveRoute({ name: "Te verwijderen", edgeIds: ["e1"], nodeIds: ["n1", "n2"], startNodeId: "n1", distanceM: 1000, datasetVersionId: "v1" });
    expect(getSavedRoutes()).toHaveLength(1);
    deleteSavedRoute(saved.id);
    expect(getSavedRoutes()).toHaveLength(0);
  });

  it("verwijderen van een niet-bestaand ID geeft geen fout", () => {
    expect(() => deleteSavedRoute("bestaat-niet")).not.toThrow();
  });

  it("gooit nooit een fout als localStorage ontbreekt (SSR-veilig)", () => {
    (globalThis as { window?: unknown }).window = undefined;
    expect(() => saveRoute({ name: "X", edgeIds: ["e1"], nodeIds: ["n1", "n2"], startNodeId: "n1", distanceM: 1000, datasetVersionId: "v1" })).not.toThrow();
    expect(getSavedRoutes()).toEqual([]);
  });
});

describe("defaultSavedRouteName", () => {
  it("geeft een Nederlands datumlabel terug", () => {
    const label = defaultSavedRouteName("2026-09-01T10:00:00.000Z");
    expect(label).toMatch(/^Route van \d+ /);
  });
});
