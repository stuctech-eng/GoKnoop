import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSharedRoutes, recordSharedRoute, updateSharedWith } from "./shared-routes-store";

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

const BASE = { routeName: "Rondje Waterland", edgeIds: ["e1", "e2"], nodeIds: ["n1", "n2", "n3"], datasetVersionId: "v1", distanceM: 24600 };

describe("shared-routes-store", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { localStorage: createMemoryStorage() };
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it("geeft een lege array terug als er nog niets gedeeld is", () => {
    expect(getSharedRoutes()).toEqual([]);
  });

  it("registreert een gedeelde route met sharedWith standaard null", () => {
    recordSharedRoute(BASE);
    const shared = getSharedRoutes();
    expect(shared).toHaveLength(1);
    expect(shared[0].routeName).toBe("Rondje Waterland");
    expect(shared[0].sharedWith).toBeNull();
    expect(typeof shared[0].id).toBe("string");
    expect(typeof shared[0].sharedAt).toBe("string");
  });

  it("nieuwste registratie staat vooraan", () => {
    recordSharedRoute({ ...BASE, routeName: "Eerste" });
    recordSharedRoute({ ...BASE, routeName: "Tweede" });
    const shared = getSharedRoutes();
    expect(shared[0].routeName).toBe("Tweede");
    expect(shared[1].routeName).toBe("Eerste");
  });

  it("updateSharedWith vult 'met wie' achteraf in", () => {
    recordSharedRoute(BASE);
    const id = getSharedRoutes()[0].id;
    updateSharedWith(id, "Jan en Marieke");
    expect(getSharedRoutes()[0].sharedWith).toBe("Jan en Marieke");
  });

  it("updateSharedWith met lege tekst zet het veld terug naar null", () => {
    recordSharedRoute(BASE);
    const id = getSharedRoutes()[0].id;
    updateSharedWith(id, "Jan");
    updateSharedWith(id, "   ");
    expect(getSharedRoutes()[0].sharedWith).toBeNull();
  });

  it("updateSharedWith op een onbekend id doet niets, geen crash", () => {
    recordSharedRoute(BASE);
    expect(() => updateSharedWith("bestaat-niet", "Iemand")).not.toThrow();
    expect(getSharedRoutes()[0].sharedWith).toBeNull();
  });

  it("gooit nooit een fout als localStorage ontbreekt (SSR-veilig)", () => {
    (globalThis as { window?: unknown }).window = undefined;
    expect(() => recordSharedRoute(BASE)).not.toThrow();
    expect(getSharedRoutes()).toEqual([]);
  });
});
