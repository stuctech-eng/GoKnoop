import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenRouteServiceAdapter } from "./open-route-service-adapter";

const ORIGIN = { lat: 52.5, lon: 5.1 };
const DESTINATION = { lat: 52.51, lon: 5.11 };

function geoJsonResponse(distance: number, duration: number, coords: [number, number][]) {
  return {
    features: [
      {
        geometry: { coordinates: coords },
        properties: { summary: { distance, duration } },
      },
    ],
  };
}

describe("OpenRouteServiceAdapter", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("gooit een duidelijke fout als de API-key ontbreekt (geen aanname/fallback)", () => {
    const originalEnv = process.env.OPENROUTESERVICE_API_KEY;
    delete process.env.OPENROUTESERVICE_API_KEY;
    expect(() => new OpenRouteServiceAdapter()).toThrow(/OPENROUTESERVICE_API_KEY/);
    if (originalEnv) process.env.OPENROUTESERVICE_API_KEY = originalEnv;
  });

  it("accepteert een expliciet meegegeven API-key (voor tests, i.p.v. env var)", () => {
    expect(() => new OpenRouteServiceAdapter("test-key")).not.toThrow();
  });

  it("stuurt coördinaten in [lon, lat]-volgorde, met de juiste headers/endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => geoJsonResponse(742, 180, [[5.1, 52.5], [5.11, 52.51]]),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const adapter = new OpenRouteServiceAdapter("test-key");
    await adapter.route(ORIGIN, DESTINATION, "cycling");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openrouteservice.org/v2/directions/cycling-regular/geojson");
    expect(options.method).toBe("POST");
    expect(options.headers["Authorization"]).toBe("test-key");
    const body = JSON.parse(options.body);
    expect(body.coordinates).toEqual([
      [ORIGIN.lon, ORIGIN.lat],
      [DESTINATION.lon, DESTINATION.lat],
    ]);
  });

  it("gebruikt het juiste ORS-profiel voor 'foot'", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => geoJsonResponse(100, 60, [[5.1, 52.5], [5.11, 52.51]]) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const adapter = new OpenRouteServiceAdapter("test-key");
    await adapter.route(ORIGIN, DESTINATION, "foot");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openrouteservice.org/v2/directions/foot-walking/geojson");
  });

  it("zet een geslaagde GeoJSON-respons correct om naar LocalBikeRouteResult (lon/lat teruggedraaid naar lat/lon)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => geoJsonResponse(742, 180, [[5.1, 52.5], [5.105, 52.505], [5.11, 52.51]]),
    }) as unknown as typeof fetch;

    const adapter = new OpenRouteServiceAdapter("test-key");
    const result = await adapter.route(ORIGIN, DESTINATION, "cycling");

    expect("distanceM" in result).toBe(true);
    if ("distanceM" in result) {
      expect(result.distanceM).toBe(742);
      expect(result.durationS).toBe(180);
      expect(result.geometry).toEqual([
        { lat: 52.5, lon: 5.1 },
        { lat: 52.505, lon: 5.105 },
        { lat: 52.51, lon: 5.11 },
      ]);
    }
  });

  it("geeft een provider_error terug bij een niet-ok HTTP-status (geen crash)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }) as unknown as typeof fetch;
    const adapter = new OpenRouteServiceAdapter("test-key");
    const result = await adapter.route(ORIGIN, DESTINATION, "cycling");
    expect("reason" in result && result.reason).toBe("provider_error");
  });

  it("geeft een provider_error terug als fetch zelf faalt (bijv. netwerkfout)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const adapter = new OpenRouteServiceAdapter("test-key");
    const result = await adapter.route(ORIGIN, DESTINATION, "cycling");
    expect("reason" in result && result.reason).toBe("provider_error");
  });

  it("geeft no_route_found terug als er geen features in de respons zitten", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ features: [] }) }) as unknown as typeof fetch;
    const adapter = new OpenRouteServiceAdapter("test-key");
    const result = await adapter.route(ORIGIN, DESTINATION, "cycling");
    expect("reason" in result && result.reason).toBe("no_route_found");
  });

  it("geeft invalid_response terug bij een onverwachte responsvorm (geen summary)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ features: [{ geometry: { coordinates: [[5.1, 52.5]] }, properties: {} }] }),
    }) as unknown as typeof fetch;
    const adapter = new OpenRouteServiceAdapter("test-key");
    const result = await adapter.route(ORIGIN, DESTINATION, "cycling");
    expect("reason" in result && result.reason).toBe("invalid_response");
  });

  it("geeft invalid_response terug als de respons geen geldige JSON is", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error("niet-JSON");
      },
    }) as unknown as typeof fetch;
    const adapter = new OpenRouteServiceAdapter("test-key");
    const result = await adapter.route(ORIGIN, DESTINATION, "cycling");
    expect("reason" in result && result.reason).toBe("invalid_response");
  });
});
