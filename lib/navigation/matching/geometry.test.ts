import { describe, it, expect } from "vitest";
import {
  distanceBetween,
  segmentLengths,
  cumulativeDistances,
  pointAtDistance,
  bearingDegrees,
  angleDifferenceDegrees,
  projectOntoSegment,
} from "./geometry";

describe("distanceBetween", () => {
  it("berekent de Euclidische afstand tussen twee punten", () => {
    expect(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(distanceBetween({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(0);
  });
});

describe("segmentLengths / cumulativeDistances", () => {
  it("berekent segmentlengtes en cumulatieve afstanden voor een polyline", () => {
    const geometry = [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 0, y: 250 },
    ];
    const lengths = segmentLengths(geometry);
    expect(lengths).toEqual([100, 150]);
    expect(cumulativeDistances(lengths)).toEqual([100, 250]);
  });

  it("geeft een lege array voor een polyline met minder dan 2 punten", () => {
    expect(segmentLengths([{ x: 0, y: 0 }])).toEqual([]);
    expect(segmentLengths([])).toEqual([]);
  });
});

describe("pointAtDistance", () => {
  const geometry = [
    { x: 0, y: 0 },
    { x: 0, y: 100 },
  ];
  const lengths = segmentLengths(geometry);

  it("interpoleert correct binnen een enkel segment", () => {
    expect(pointAtDistance(geometry, lengths, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAtDistance(geometry, lengths, 50)).toEqual({ x: 0, y: 50 });
    expect(pointAtDistance(geometry, lengths, 100)).toEqual({ x: 0, y: 100 });
  });

  it("clampt afstanden voorbij het einde aan het laatste punt", () => {
    expect(pointAtDistance(geometry, lengths, 500)).toEqual({ x: 0, y: 100 });
  });
});

describe("bearingDegrees", () => {
  it("noord = 0°", () => {
    expect(bearingDegrees({ x: 0, y: 0 }, { x: 0, y: 100 })).toBeCloseTo(0, 6);
  });
  it("oost = 90°", () => {
    expect(bearingDegrees({ x: 0, y: 0 }, { x: 100, y: 0 })).toBeCloseTo(90, 6);
  });
  it("zuid = 180°", () => {
    expect(bearingDegrees({ x: 0, y: 0 }, { x: 0, y: -100 })).toBeCloseTo(180, 6);
  });
  it("west = 270°", () => {
    expect(bearingDegrees({ x: 0, y: 0 }, { x: -100, y: 0 })).toBeCloseTo(270, 6);
  });
});

describe("angleDifferenceDegrees", () => {
  it("geeft 0 voor identieke bearings", () => {
    expect(angleDifferenceDegrees(45, 45)).toBe(0);
  });
  it("geeft het kleinste verschil, ook over de 0/360-grens heen", () => {
    expect(angleDifferenceDegrees(350, 10)).toBeCloseTo(20, 6);
    expect(angleDifferenceDegrees(10, 350)).toBeCloseTo(20, 6);
  });
  it("geeft 180 voor tegenovergestelde richtingen", () => {
    expect(angleDifferenceDegrees(0, 180)).toBe(180);
  });
});

describe("projectOntoSegment", () => {
  it("projecteert loodrecht op een verticaal segment", () => {
    const result = projectOntoSegment({ x: 5, y: 50 }, { x: 0, y: 0 }, { x: 0, y: 100 });
    expect(result.point).toEqual({ x: 0, y: 50 });
    expect(result.t).toBeCloseTo(0.5, 6);
  });

  it("clampt t aan [0,1] -- geen extrapolatie voorbij de segment-uiteinden", () => {
    const before = projectOntoSegment({ x: 5, y: -50 }, { x: 0, y: 0 }, { x: 0, y: 100 });
    expect(before.t).toBe(0);
    expect(before.point).toEqual({ x: 0, y: 0 });

    const after = projectOntoSegment({ x: 5, y: 150 }, { x: 0, y: 0 }, { x: 0, y: 100 });
    expect(after.t).toBe(1);
    expect(after.point).toEqual({ x: 0, y: 100 });
  });

  it("geeft het startpunt terug voor een segment met lengte 0", () => {
    const result = projectOntoSegment({ x: 5, y: 5 }, { x: 1, y: 1 }, { x: 1, y: 1 });
    expect(result.point).toEqual({ x: 1, y: 1 });
    expect(result.t).toBe(0);
  });
});
