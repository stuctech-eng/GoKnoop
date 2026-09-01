import { describe, it, expect } from "vitest";
import { buildRouteGeoJson } from "./route-geometry-adapter";
import { buildRouteProgressModel, calculateProgress } from "../navigation/progress/route-progress-model";
import { rdToWgs84 } from "../route-engine/coordinate-transform";
import type { GraphEdge } from "../route-engine/types";

function edge(overrides: Partial<GraphEdge> & Pick<GraphEdge, "id" | "distanceM" | "geometry">): GraphEdge {
  return { fromLogicalNodeId: "?", toLogicalNodeId: "?", directionality: "unknown", ...overrides };
}

describe("buildRouteGeoJson — Test 1: eenvoudige route met 2 edges → één doorlopende lijn", () => {
  it("levert één LineString met alle punten van beide edges samengevoegd", () => {
    const edges: GraphEdge[] = [
      edge({ id: "e1", fromLogicalNodeId: "n1", toLogicalNodeId: "n2", distanceM: 100, geometry: [{ x: 136000, y: 456000 }, { x: 136000, y: 456100 }] }),
      edge({ id: "e2", fromLogicalNodeId: "n2", toLogicalNodeId: "n3", distanceM: 50, geometry: [{ x: 136000, y: 456100 }, { x: 136000, y: 456150 }] }),
    ];
    const model = buildRouteProgressModel(edges, ["n1", "n2", "n3"]);
    const result = buildRouteGeoJson(model, ["n1", "n2", "n3"]);

    expect(result.line.type).toBe("Feature");
    expect(result.line.geometry.type).toBe("LineString");
    expect(result.line.geometry.coordinates).toHaveLength(3);
    expect(result.nodes.features).toHaveLength(3);
    expect(result.nodes.features.map((f) => f.properties.nodeId)).toEqual(["n1", "n2", "n3"]);
  });
});

describe("buildRouteGeoJson — Test 2: meerdere edges, volgorde en volledigheid", () => {
  it("behoudt de Route.edges[]-volgorde, geen ontbrekende segmenten, correcte geometrie", () => {
    const edges: GraphEdge[] = [
      edge({ id: "e1", fromLogicalNodeId: "n1", toLogicalNodeId: "n2", distanceM: 100, geometry: [{ x: 0, y: 0 }, { x: 0, y: 100 }] }),
      edge({ id: "e2", fromLogicalNodeId: "n2", toLogicalNodeId: "n3", distanceM: 100, geometry: [{ x: 0, y: 100 }, { x: 100, y: 100 }] }),
      edge({ id: "e3", fromLogicalNodeId: "n3", toLogicalNodeId: "n4", distanceM: 100, geometry: [{ x: 100, y: 100 }, { x: 100, y: 200 }] }),
    ];
    const model = buildRouteProgressModel(edges, ["n1", "n2", "n3", "n4"]);
    const result = buildRouteGeoJson(model, ["n1", "n2", "n3", "n4"]);

    expect(result.line.geometry.coordinates).toHaveLength(4);
    expect(result.nodes.features.map((f) => f.properties.sequenceIndex)).toEqual([0, 1, 2, 3]);

    const expectedN2 = rdToWgs84(0, 100);
    const expectedN3 = rdToWgs84(100, 100);
    expect(result.nodes.features[1].geometry.coordinates[0]).toBeCloseTo(expectedN2.lon, 6);
    expect(result.nodes.features[1].geometry.coordinates[1]).toBeCloseTo(expectedN2.lat, 6);
    expect(result.nodes.features[2].geometry.coordinates[0]).toBeCloseTo(expectedN3.lon, 6);
    expect(result.nodes.features[2].geometry.coordinates[1]).toBeCloseTo(expectedN3.lat, 6);
  });
});

describe("buildRouteGeoJson — Test 3: parallelle edges tussen dezelfde nodes worden niet gededupliceerd", () => {
  it("twee edges met identieke from/to-nodes, maar andere geometrie, leveren beide hun eigen lijnstuk", () => {
    const edges: GraphEdge[] = [
      edge({ id: "e1", fromLogicalNodeId: "A", toLogicalNodeId: "B", distanceM: 100, geometry: [{ x: 0, y: 0 }, { x: 0, y: 100 }] }),
      edge({ id: "e2", fromLogicalNodeId: "B", toLogicalNodeId: "A", distanceM: 100, geometry: [{ x: 0, y: 100 }, { x: 10, y: 0 }] }),
    ];
    const model = buildRouteProgressModel(edges, ["A", "B", "A"]);
    const result = buildRouteGeoJson(model, ["nA", "nB", "nA2"]);

    expect(result.line.geometry.coordinates).toHaveLength(3);
    expect(model.edges.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(model.edges).toHaveLength(2);
  });
});

describe("buildRouteGeoJson — Test 4: distance-invariant blijft ongewijzigd (de kaart is alleen visualisatie)", () => {
  it("de adapter herberekent distanceM niet en de bestaande progress-invariant blijft exact gelden", () => {
    const edges: GraphEdge[] = [
      edge({ id: "e1", fromLogicalNodeId: "n1", toLogicalNodeId: "n2", distanceM: 137, geometry: [{ x: 0, y: 0 }, { x: 0, y: 100 }] }),
      edge({ id: "e2", fromLogicalNodeId: "n2", toLogicalNodeId: "n3", distanceM: 63, geometry: [{ x: 0, y: 100 }, { x: 0, y: 150 }] }),
    ];
    const model = buildRouteProgressModel(edges, ["n1", "n2", "n3"]);

    buildRouteGeoJson(model, ["n1", "n2", "n3"]);
    expect(model.totalDistanceM).toBe(200);

    const progress = calculateProgress(model, { segmentIndex: 1, segmentT: 0.5, point: { x: 0, y: 125 }, perpendicularDistanceM: 0, cumulativeDistanceM: 125 });
    expect(progress.distanceAlongRouteM + progress.remainingDistanceM).toBeCloseTo(model.totalDistanceM, 6);

    const result = buildRouteGeoJson(model, ["n1", "n2", "n3"]);
    expect(result.line.properties).toEqual({});
    expect(Object.keys(result.nodes.features[0].properties)).toEqual(["nodeId", "sequenceIndex"]);
  });
});

describe("buildRouteGeoJson — Test 5: lege/ongeldige geometrie → geen crash, expliciete foutstatus", () => {
  it("gooit een duidelijke fout bij een geometrie met minder dan 2 punten (via buildRouteProgressModel's eigen edge)", () => {
    const edges: GraphEdge[] = [edge({ id: "e1", fromLogicalNodeId: "n1", toLogicalNodeId: "n2", distanceM: 0, geometry: [{ x: 0, y: 0 }] })];
    const model = buildRouteProgressModel(edges, ["n1", "n2"]);
    expect(() => buildRouteGeoJson(model, ["n1", "n2"])).toThrow(/minder dan 2 punten/);
  });

  it("gooit een duidelijke fout als nodeIds niet overeenkomt met edges.length + 1", () => {
    const edges: GraphEdge[] = [edge({ id: "e1", fromLogicalNodeId: "n1", toLogicalNodeId: "n2", distanceM: 100, geometry: [{ x: 0, y: 0 }, { x: 0, y: 100 }] })];
    const model = buildRouteProgressModel(edges, ["n1", "n2"]);
    expect(() => buildRouteGeoJson(model, ["alleen-een-node"])).toThrow(/nodeIds\.length/);
  });
});

describe("buildRouteGeoJson — Test 6: bounds voor auto-fit", () => {
  it("levert correcte [[minLon,minLat],[maxLon,maxLat]]-bounds die de hele route omvatten", () => {
    const edges: GraphEdge[] = [
      edge({ id: "e1", fromLogicalNodeId: "n1", toLogicalNodeId: "n2", distanceM: 1000, geometry: [{ x: 136000, y: 456000 }, { x: 137000, y: 457000 }] }),
    ];
    const model = buildRouteProgressModel(edges, ["n1", "n2"]);
    const result = buildRouteGeoJson(model, ["n1", "n2"]);

    const [[minLon, minLat], [maxLon, maxLat]] = result.bounds;
    for (const [lon, lat] of result.line.geometry.coordinates) {
      expect(lon).toBeGreaterThanOrEqual(minLon);
      expect(lon).toBeLessThanOrEqual(maxLon);
      expect(lat).toBeGreaterThanOrEqual(minLat);
      expect(lat).toBeLessThanOrEqual(maxLat);
    }
    expect(minLon).toBeLessThan(maxLon);
    expect(minLat).toBeLessThan(maxLat);
  });
});
