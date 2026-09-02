import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getPausedRide, savePausedRide, clearPausedRide } from "./paused-ride-store";
import type { PausedRideSnapshot } from "./paused-ride-store";

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

function baseSnapshot(): Omit<PausedRideSnapshot, "pausedAt"> {
  return {
    routeNodes: ["n1", "n2", "n3", "n1"],
    routeEdges: ["e1", "e2", "e3"],
    datasetVersionId: "v1",
    physicalStart: { type: "parking", lat: 52.5, lon: 5.1 },
    lastKnownPosition: { lat: 52.51, lon: 5.11 },
    distanceTraveledM: 4200,
    rideTimeS: 1380,
  };
}

describe("paused-ride-store", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { localStorage: createMemoryStorage() };
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it("geeft null terug als er nog geen gepauzeerde rit is", () => {
    expect(getPausedRide()).toBeNull();
  });

  it("slaat een gepauzeerde rit op en kan 'm teruglezen", () => {
    savePausedRide(baseSnapshot());
    const ride = getPausedRide();
    expect(ride).not.toBeNull();
    expect(ride!.routeNodes).toEqual(["n1", "n2", "n3", "n1"]);
    expect(ride!.distanceTraveledM).toBe(4200);
    expect(typeof ride!.pausedAt).toBe("string");
  });

  it("een nieuwe pauze overschrijft de vorige snapshot (één actieve rit tegelijk)", () => {
    savePausedRide(baseSnapshot());
    savePausedRide({ ...baseSnapshot(), distanceTraveledM: 9000, routeNodes: ["nA", "nB", "nA"] });
    const ride = getPausedRide();
    expect(ride!.distanceTraveledM).toBe(9000);
    expect(ride!.routeNodes).toEqual(["nA", "nB", "nA"]);
  });

  it("clearPausedRide verwijdert de gepauzeerde rit", () => {
    savePausedRide(baseSnapshot());
    expect(getPausedRide()).not.toBeNull();
    clearPausedRide();
    expect(getPausedRide()).toBeNull();
  });

  it("clearPausedRide zonder bestaande rit geeft geen fout", () => {
    expect(() => clearPausedRide()).not.toThrow();
  });

  it("ondersteunt physicalStart/lastKnownPosition als null", () => {
    savePausedRide({ ...baseSnapshot(), physicalStart: null, lastKnownPosition: null });
    const ride = getPausedRide();
    expect(ride!.physicalStart).toBeNull();
    expect(ride!.lastKnownPosition).toBeNull();
  });

  it("gooit nooit een fout als localStorage ontbreekt (SSR-veilig)", () => {
    (globalThis as { window?: unknown }).window = undefined;
    expect(() => savePausedRide(baseSnapshot())).not.toThrow();
    expect(getPausedRide()).toBeNull();
  });

  it("geeft null terug bij corrupte opslag, geen crash", () => {
    (globalThis as { window: { localStorage: Storage } }).window.localStorage.setItem("goknoop.pausedRide.v1", "{niet geldig json");
    expect(getPausedRide()).toBeNull();
  });
});
