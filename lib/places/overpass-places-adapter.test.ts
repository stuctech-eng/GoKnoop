import { describe, it, expect, vi, afterEach } from "vitest";
import { OverpassPlacesAdapter } from "./overpass-places-adapter";

const CENTER = { lat: 52.3, lon: 5.2 };

function overpassResponse(elements: unknown[]) {
  return { elements };
}

describe("OverpassPlacesAdapter", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("stuurt de juiste query (nwr, amenity=parking, around) naar het juiste endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => overpassResponse([]) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const adapter = new OverpassPlacesAdapter();
    await adapter.findNearby(CENTER, "parking", 1500, 5);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://overpass-api.de/api/interpreter");
    expect(options.method).toBe("POST");
    const bodyText = decodeURIComponent(options.body.replace("data=", ""));
    expect(bodyText).toContain('nwr["amenity"="parking"]');
    expect(bodyText).toContain("around:1500,52.3,5.2");
  });

  it("verwerkt een node-resultaat correct (directe lat/lon)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => overpassResponse([{ type: "node", lat: 52.301, lon: 5.201, tags: { name: "Parkeerplaats Centrum" } }]),
    }) as unknown as typeof fetch;

    const adapter = new OverpassPlacesAdapter();
    const result = await adapter.findNearby(CENTER, "parking", 1000, 5);

    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result[0].name).toBe("Parkeerplaats Centrum");
      expect(result[0].lat).toBe(52.301);
      expect(result[0].distanceM).toBeGreaterThan(0);
    }
  });

  it("verwerkt een way-resultaat correct (via 'center', geen directe lat/lon)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => overpassResponse([{ type: "way", center: { lat: 52.302, lon: 5.202 }, tags: {} }]),
    }) as unknown as typeof fetch;

    const adapter = new OverpassPlacesAdapter();
    const result = await adapter.findNearby(CENTER, "parking", 1000, 5);

    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result[0].lat).toBe(52.302);
      expect(result[0].name).toBeNull(); // geen naam-tag -- moet null zijn, geen crash
    }
  });

  it("sorteert resultaten op afstand, dichtstbijzijnde eerst", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        overpassResponse([
          { type: "node", lat: 52.31, lon: 5.21, tags: {} }, // ver
          { type: "node", lat: 52.301, lon: 5.201, tags: {} }, // dichtbij
        ]),
    }) as unknown as typeof fetch;

    const adapter = new OverpassPlacesAdapter();
    const result = await adapter.findNearby(CENTER, "parking", 5000, 5);

    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result[0].lat).toBe(52.301); // dichtstbijzijnde eerst
      expect(result[0].distanceM).toBeLessThan(result[1].distanceM);
    }
  });

  it("geeft een provider_error terug bij een netwerkfout, geen crash", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const adapter = new OverpassPlacesAdapter();
    const result = await adapter.findNearby(CENTER, "parking", 1000, 5);
    expect("reason" in result && result.reason).toBe("provider_error");
  });

  it("geeft een provider_error terug bij een niet-ok status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 504 }) as unknown as typeof fetch;
    const adapter = new OverpassPlacesAdapter();
    const result = await adapter.findNearby(CENTER, "parking", 1000, 5);
    expect("reason" in result && result.reason).toBe("provider_error");
  });

  it("geeft lege resultaten terug als er niets gevonden wordt, geen crash", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => overpassResponse([]) }) as unknown as typeof fetch;
    const adapter = new OverpassPlacesAdapter();
    const result = await adapter.findNearby(CENTER, "parking", 1000, 5);
    expect(result).toEqual([]);
  });

  it("[verplichte test] valt terug op de tweede (mirror-)server als de eerste niet reageert", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { name: "AbortError" })) // eerste server faalt
      .mockResolvedValueOnce({ ok: true, json: async () => overpassResponse([{ type: "node", lat: 52.301, lon: 5.201, tags: {} }]) }); // tweede lukt
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const adapter = new OverpassPlacesAdapter();
    const result = await adapter.findNearby(CENTER, "parking", 1000, 5);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondUrl = fetchMock.mock.calls[1][0];
    expect(secondUrl).toBe("https://overpass.kumi.systems/api/interpreter");
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result[0].lat).toBe(52.301);
    }
  });

  it("geeft de laatste fout terug als BEIDE servers falen (geen crash, duidelijke melding)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("beide down")) as unknown as typeof fetch;
    const adapter = new OverpassPlacesAdapter();
    const result = await adapter.findNearby(CENTER, "parking", 1000, 5);
    expect("reason" in result && result.reason).toBe("provider_error");
  });

  it("geeft een herkenbare 'even geduld'-melding bij status 429, geen algemene foutmelding", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 }) as unknown as typeof fetch;
    const adapter = new OverpassPlacesAdapter();
    const result = await adapter.findNearby(CENTER, "parking", 1000, 5);
    expect("reason" in result).toBe(true);
    if ("reason" in result) {
      expect(result.message).toContain("te veel aanvragen");
    }
  });
});
