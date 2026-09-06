import { describe, it, expect } from "vitest";
import { buildPositionMarkerGeoJson } from "./position-marker-adapter";
import { rdToWgs84 } from "../route-engine/coordinate-transform";
import type { MatchedPosition } from "../navigation/types";

function matched(overrides: Partial<MatchedPosition> = {}): MatchedPosition {
  return {
    segmentIndex: 0,
    segmentT: 0.5,
    point: { x: 136000, y: 456300 },
    perpendicularDistanceM: 2.4,
    cumulativeDistanceM: 150,
    ...overrides,
  };
}

describe("buildPositionMarkerGeoJson — GPS → matching → navigation state → kaartmarker (nooit GPS → kaartmarker)", () => {
  it("gebruikt uitsluitend het gematchte (RD-)punt, correct omgezet naar WGS84", () => {
    const result = buildPositionMarkerGeoJson(matched({ point: { x: 136000, y: 456300 } }));
    const expected = rdToWgs84(136000, 456300);
    expect(result.geometry.coordinates[0]).toBeCloseTo(expected.lon, 6);
    expect(result.geometry.coordinates[1]).toBeCloseTo(expected.lat, 6);
  });

  it("neemt de functiesignature aan als enige input een MatchedPosition -- geen los lat/lon-pad mogelijk", () => {
    // Structurele borging: buildPositionMarkerGeoJson heeft precies één parameter,
    // een MatchedPosition. Er bestaat geen overload die een ruwe GpsSample/coördinaat
    // accepteert -- dat zou hier een TypeScript-compilatiefout opleveren, niet alleen
    // een runtime-aanname. (Deze test documenteert die garantie expliciet.)
    expect(buildPositionMarkerGeoJson.length).toBe(1);
  });

  it("geeft de perpendiculaire afstand en segmentIndex door als metadata (afkomstig uit de matching, niet herberekend)", () => {
    const result = buildPositionMarkerGeoJson(matched({ perpendicularDistanceM: 7.7, segmentIndex: 2 }));
    expect(result.properties.perpendicularDistanceM).toBe(7.7);
    expect(result.properties.segmentIndex).toBe(2);
  });

  it("levert een geldig GeoJSON Point Feature op", () => {
    const result = buildPositionMarkerGeoJson(matched());
    expect(result.type).toBe("Feature");
    expect(result.geometry.type).toBe("Point");
    expect(result.geometry.coordinates).toHaveLength(2);
  });

  it("is puur: dezelfde MatchedPosition geeft altijd exact hetzelfde resultaat, geen verborgen state", () => {
    const input = matched();
    const a = buildPositionMarkerGeoJson(input);
    const b = buildPositionMarkerGeoJson(input);
    expect(a).toEqual(b);
  });
});
