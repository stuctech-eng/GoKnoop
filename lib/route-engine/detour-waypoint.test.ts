import { describe, it, expect } from "vitest";
import { computeDetourOffsetPoint } from "./detour-waypoint";

const ORIGIN = { x: 0, y: 0 };
const DESTINATION = { x: 10000, y: 0 }; // 10km recht naar het oosten

function pathDistance(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y);
}

describe("computeDetourOffsetPoint", () => {
  it("[kernbewijs] de rechte-lijn-omweg via het puntje voegt (vóór circuity-correctie) ongeveer de gevraagde extra afstand toe", () => {
    // circuityFactor=1 hier expliciet, om de PURE geometrie te bewijzen zonder de
    // praktische correctie ertussen -- die correctie wordt in een aparte test getoetst.
    const extraM = 4000;
    const point = computeDetourOffsetPoint(ORIGIN, DESTINATION, extraM, "left", 1);
    const totalPathM = pathDistance(ORIGIN, point, DESTINATION);
    const directM = Math.hypot(DESTINATION.x - ORIGIN.x, DESTINATION.y - ORIGIN.y);
    expect(totalPathM - directM).toBeCloseTo(extraM, 0); // binnen ~1m nauwkeurig
  });

  it("'left' en 'right' geven twee symmetrische, tegenovergestelde punten", () => {
    const left = computeDetourOffsetPoint(ORIGIN, DESTINATION, 4000, "left", 1);
    const right = computeDetourOffsetPoint(ORIGIN, DESTINATION, 4000, "right", 1);
    expect(left.y).toBeCloseTo(-right.y, 5);
    expect(left.x).toBeCloseTo(right.x, 5); // zelfde positie langs de lijn, spiegelbeeld loodrecht erop
  });

  it("een grotere gevraagde extra afstand geeft een punt verder van de directe lijn af", () => {
    const small = computeDetourOffsetPoint(ORIGIN, DESTINATION, 2000, "left", 1);
    const large = computeDetourOffsetPoint(ORIGIN, DESTINATION, 8000, "left", 1);
    expect(Math.abs(large.y)).toBeGreaterThan(Math.abs(small.y));
  });

  it("een hogere circuityFactor (praktische correctie) geeft een minder ver punt -- compenseert dat een echte route nooit kaarsrecht is", () => {
    const withoutCorrection = computeDetourOffsetPoint(ORIGIN, DESTINATION, 4000, "left", 1);
    const withCorrection = computeDetourOffsetPoint(ORIGIN, DESTINATION, 4000, "left", 1.4);
    expect(Math.abs(withCorrection.y)).toBeLessThan(Math.abs(withoutCorrection.y));
  });

  it("extraM = 0 geeft een punt vrijwel op de directe lijn zelf (geen omweg)", () => {
    const point = computeDetourOffsetPoint(ORIGIN, DESTINATION, 0, "left", 1);
    expect(Math.abs(point.y)).toBeCloseTo(0, 5);
  });

  it("gaat niet stuk als origin en bestemming toevallig samenvallen (randgeval)", () => {
    expect(() => computeDetourOffsetPoint(ORIGIN, ORIGIN, 4000, "left", 1)).not.toThrow();
  });
});
