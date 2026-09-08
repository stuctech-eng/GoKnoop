import { describe, it, expect, afterEach } from "vitest";
import { vi } from "vitest";
import { ValhallaAdapter } from "./valhalla-adapter";

const ORIGIN = { lat: 52.5, lon: 5.1 };
const DESTINATION = { lat: 52.51, lon: 5.11 };
// "_p~iF~ps|U" decodeert (precisie 6) naar een enkel punt -- voldoende voor deze
// tests, de daadwerkelijke decodeer-logica zelf wordt apart getest (polyline.test.ts).
const SAMPLE_SHAPE = "_p~iF~ps|U";

function valhallaResponse(lengthKm: number, timeS: number, shape: string) {
  return { trip: { summary: { length: lengthKm, time: timeS }, legs: [{ shape }] } };
}

describe("ValhallaAdapter", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("gooit een duidelijke fout als baseUrl ontbreekt (geen hardcoded publiek endpoint, geen aanname)", () => {
    const originalEnv = process.env.VALHALLA_BASE_URL;
    delete process.env.VALHALLA_BASE_URL;
    expect(() => new ValhallaAdapter()).toThrow(/VALHALLA_BASE_URL/);
    if (originalEnv) process.env.VALHALLA_BASE_URL = originalEnv;
  });

  it("accepteert een expliciet meegegeven baseUrl (voor tests/self-hosting, i.p.v. env var)", () => {
    expect(() => new ValhallaAdapter("http://localhost:8002")).not.toThrow();
  });

  it("werkt ZONDER apiKey (self-hosted Valhalla draait vaak zonder authenticatie)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => valhallaResponse(0.742, 180, SAMPLE_SHAPE) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const adapter = new ValhallaAdapter("http://localhost:8002");
    await adapter.route(ORIGIN, DESTINATION, "cycling");
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers["Authorization"]).toBeUndefined();
  });

  it("stuurt locations als {lat,lon}-objecten (NIET [lon,lat]-arrays zoals ORS) en het juiste costing-profiel", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => valhallaResponse(0.742, 180, SAMPLE_SHAPE) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const adapter = new ValhallaAdapter("http://localhost:8002", "test-key");
    await adapter.route(ORIGIN, DESTINATION, "cycling");

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8002/route");
    expect(options.headers["Authorization"]).toBe("test-key");
    const body = JSON.parse(options.body);
    expect(body.locations).toEqual([
      { lat: ORIGIN.lat, lon: ORIGIN.lon },
      { lat: DESTINATION.lat, lon: DESTINATION.lon },
    ]);
    expect(body.costing).toBe("bicycle");
    expect(body.units).toBe("kilometers");
  });

  it("gebruikt het juiste Valhalla-costingprofiel voor 'foot' ('pedestrian')", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => valhallaResponse(0.1, 60, SAMPLE_SHAPE) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const adapter = new ValhallaAdapter("http://localhost:8002");
    await adapter.route(ORIGIN, DESTINATION, "foot");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.costing).toBe("pedestrian");
  });

  it("zet lengte in km correct om naar meters, en decodeert de shape", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => valhallaResponse(0.742, 180, SAMPLE_SHAPE) }) as unknown as typeof fetch;
    const adapter = new ValhallaAdapter("http://localhost:8002");
    const result = await adapter.route(ORIGIN, DESTINATION, "cycling");
    expect("distanceM" in result).toBe(true);
    if ("distanceM" in result) {
      expect(result.distanceM).toBeCloseTo(742, 5);
      expect(result.durationS).toBe(180);
      expect(result.geometry.length).toBeGreaterThan(0);
    }
  });

  it("herkent Valhalla's specifieke 'geen route'-foutcode (error_code 442) als no_route_found, niet als generieke provider_error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error_code: 442, error: "No path could be found for input", status_code: 400, status: "Bad Request" }),
    }) as unknown as typeof fetch;
    const adapter = new ValhallaAdapter("http://localhost:8002");
    const result = await adapter.route(ORIGIN, DESTINATION, "cycling");
    expect("reason" in result && result.reason).toBe("no_route_found");
  });

  it("behandelt een andere 400-fout (niet error_code 442) als provider_error, niet als no_route_found", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error_code: 154, error: "Path distance exceeds the max distance limit", status_code: 400, status: "Bad Request" }),
    }) as unknown as typeof fetch;
    const adapter = new ValhallaAdapter("http://localhost:8002");
    const result = await adapter.route(ORIGIN, DESTINATION, "cycling");
    expect("reason" in result && result.reason).toBe("provider_error");
  });

  it("geeft een provider_error terug als fetch zelf faalt (bijv. netwerkfout)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const adapter = new ValhallaAdapter("http://localhost:8002");
    const result = await adapter.route(ORIGIN, DESTINATION, "cycling");
    expect("reason" in result && result.reason).toBe("provider_error");
  });

  it("geeft invalid_response terug bij een onverwachte responsvorm (geen trip.summary)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ trip: { legs: [{ shape: SAMPLE_SHAPE }] } }) }) as unknown as typeof fetch;
    const adapter = new ValhallaAdapter("http://localhost:8002");
    const result = await adapter.route(ORIGIN, DESTINATION, "cycling");
    expect("reason" in result && result.reason).toBe("invalid_response");
  });

  it("geeft no_route_found terug als de respons geen route-shape bevat", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ trip: {} }) }) as unknown as typeof fetch;
    const adapter = new ValhallaAdapter("http://localhost:8002");
    const result = await adapter.route(ORIGIN, DESTINATION, "cycling");
    expect("reason" in result && result.reason).toBe("no_route_found");
  });

  it("geeft invalid_response terug als de respons geen geldige JSON is", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error("niet-JSON");
      },
    }) as unknown as typeof fetch;
    const adapter = new ValhallaAdapter("http://localhost:8002");
    const result = await adapter.route(ORIGIN, DESTINATION, "cycling");
    expect("reason" in result && result.reason).toBe("invalid_response");
  });

  it("verwijdert een trailing slash uit baseUrl (voorkomt dubbele // in de uiteindelijke URL)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => valhallaResponse(0.1, 60, SAMPLE_SHAPE) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const adapter = new ValhallaAdapter("http://localhost:8002/");
    await adapter.route(ORIGIN, DESTINATION, "cycling");
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:8002/route");
  });
});
