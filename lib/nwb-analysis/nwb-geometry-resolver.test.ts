import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveNwbGeometry } from "./nwb-geometry-resolver";

function mockFetchOnce(response: { status: number; body: string }) {
  const mockFetch = vi.fn().mockResolvedValueOnce({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    text: async () => response.body,
  } as Response);
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

const SAMPLE_FEATURE_COLLECTION = JSON.stringify({
  type: "FeatureCollection",
  features: [
    { type: "Feature", id: "wegvakken.aaa", geometry: { type: "LineString", coordinates: [[100, 200], [101, 201], [102, 202]] } },
    { type: "Feature", id: "wegvakken.bbb", geometry: { type: "MultiLineString", coordinates: [[[300, 400], [301, 401]]] } },
  ],
});

describe("resolveNwbGeometry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("BUG-REGRESSIE: voegt GEEN 'nwbwegen:'-prefix toe aan resourceId -- dit gaf live een InvalidParameterValue-fout (10-9-2026)", async () => {
    const mockFetch = mockFetchOnce({ status: 200, body: SAMPLE_FEATURE_COLLECTION });
    await resolveNwbGeometry(["wegvakken.aaa", "wegvakken.bbb"]);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("resourceId=wegvakken.aaa%2Cwegvakken.bbb");
    expect(calledUrl).not.toContain("nwbwegen%3Awegvakken.wegvakken"); // de exacte, live-bevestigde bug
    expect(calledUrl).not.toContain(encodeURIComponent("nwbwegen:wegvakken.wegvakken"));
  });

  it("parseert LineString en MultiLineString correct naar platte coördinatenlijsten", async () => {
    mockFetchOnce({ status: 200, body: SAMPLE_FEATURE_COLLECTION });
    const result = await resolveNwbGeometry(["wegvakken.aaa", "wegvakken.bbb"]);

    expect(result.resolved.size).toBe(2);
    expect(result.resolved.get("wegvakken.aaa")).toEqual([
      { x: 100, y: 200 },
      { x: 101, y: 201 },
      { x: 102, y: 202 },
    ]);
    expect(result.resolved.get("wegvakken.bbb")).toEqual([
      { x: 300, y: 400 },
      { x: 301, y: 401 },
    ]);
    expect(result.failed).toEqual([]);
  });

  it("markeert een gevraagd ID als failed als het niet in de respons voorkomt", async () => {
    mockFetchOnce({ status: 200, body: SAMPLE_FEATURE_COLLECTION });
    const result = await resolveNwbGeometry(["wegvakken.aaa", "wegvakken.niet-bestaand"]);

    expect(result.resolved.has("wegvakken.aaa")).toBe(true);
    expect(result.failed).toEqual(["wegvakken.niet-bestaand"]);
  });

  it("markeert de hele batch als failed bij een non-OK HTTP-status", async () => {
    mockFetchOnce({ status: 400, body: "<xml>error</xml>" });
    const result = await resolveNwbGeometry(["wegvakken.aaa", "wegvakken.bbb"]);

    expect(result.resolved.size).toBe(0);
    expect(result.failed).toEqual(["wegvakken.aaa", "wegvakken.bbb"]);
  });

  it("markeert de hele batch als failed bij een netwerkfout (fetch gooit een exception)", async () => {
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await resolveNwbGeometry(["wegvakken.aaa"]);
    expect(result.failed).toEqual(["wegvakken.aaa"]);
  });

  it("splitst grote lijsten in batches van maximaal 100 ID's per aanvraag", async () => {
    const manyIds = Array.from({ length: 150 }, (_, i) => `wegvakken.id${i}`);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ type: "FeatureCollection", features: [] }),
    } as Response);
    vi.stubGlobal("fetch", mockFetch);

    await resolveNwbGeometry(manyIds);
    expect(mockFetch).toHaveBeenCalledTimes(2); // 100 + 50
  });
});
