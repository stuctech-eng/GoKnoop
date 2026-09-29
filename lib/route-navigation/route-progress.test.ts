import { describe, it, expect } from "vitest";
import { computeRouteProgress } from "./route-progress";
import { wgs84ToRd, rdToWgs84 } from "@/lib/route-engine/coordinate-transform";
import type { LatLon } from "./types";

/**
 * Rechte, oost-westlopende testroute in RD, omgezet naar WGS84 -- zodat de verwachte
 * afstanden in RD-meters exact controleerbaar zijn, ondanks dat de functie zelf WGS84
 * aanneemt (de conversie zit al in `computeRouteProgress` zelf).
 */
const ORIGIN_RD = wgs84ToRd(52.5, 5.0); // ergens in Noord-Holland, willekeurig maar realistisch
function rdOffset(dxM: number, dyM: number): LatLon {
  const p = rdToWgs84(ORIGIN_RD.x + dxM, ORIGIN_RD.y + dyM);
  return { lat: p.lat, lon: p.lon };
}
// Rechte lijn van 0,0 naar 1000,0 (RD), dus 1000m recht "oost" (bij benadering, WGS84-vervorming is voor deze afstand verwaarloosbaar).
const STRAIGHT_ROUTE: LatLon[] = [rdOffset(0, 0), rdOffset(500, 0), rdOffset(1000, 0)];

describe("computeRouteProgress", () => {
  it("geeft null terug voor een route met minder dan 2 punten", () => {
    expect(computeRouteProgress([], rdOffset(0, 0))).toBeNull();
    expect(computeRouteProgress([rdOffset(0, 0)], rdOffset(0, 0))).toBeNull();
  });

  it("een positie exact op het beginpunt geeft distanceAlongRouteM ≈ 0", () => {
    const progress = computeRouteProgress(STRAIGHT_ROUTE, rdOffset(0, 0));
    expect(progress).not.toBeNull();
    expect(progress!.distanceAlongRouteM).toBeCloseTo(0, 0);
    expect(progress!.perpendicularDistanceM).toBeCloseTo(0, 0);
    expect(progress!.progressRatio).toBeCloseTo(0, 2);
  });

  it("een positie exact op het eindpunt geeft distanceAlongRouteM ≈ de totale lengte, remainingDistanceM ≈ 0", () => {
    const progress = computeRouteProgress(STRAIGHT_ROUTE, rdOffset(1000, 0));
    expect(progress!.distanceAlongRouteM).toBeCloseTo(1000, 0);
    expect(progress!.remainingDistanceM).toBeCloseTo(0, 0);
    expect(progress!.progressRatio).toBeCloseTo(1, 2);
  });

  it("een positie halverwege, iets naast de route, geeft de juiste voortgang én de juiste loodrechte afstand", () => {
    // 500m langs de route, 20m ernaast (loodrecht op een oost-west-lijn = een noord-zuid-afwijking).
    const progress = computeRouteProgress(STRAIGHT_ROUTE, rdOffset(500, 20));
    expect(progress!.distanceAlongRouteM).toBeCloseTo(500, 0);
    expect(progress!.perpendicularDistanceM).toBeCloseTo(20, 0);
    expect(progress!.remainingDistanceM).toBeCloseTo(500, 0);
  });

  it("een positie ver vóór het beginpunt clamt naar het beginpunt (geen extrapolatie voorbij de route)", () => {
    const progress = computeRouteProgress(STRAIGHT_ROUTE, rdOffset(-500, 0));
    expect(progress!.distanceAlongRouteM).toBeCloseTo(0, 0);
    expect(progress!.segmentIndex).toBe(0);
    expect(progress!.segmentT).toBeCloseTo(0, 2);
  });

  it("een positie ver ná het eindpunt clamt naar het eindpunt", () => {
    const progress = computeRouteProgress(STRAIGHT_ROUTE, rdOffset(1500, 0));
    expect(progress!.distanceAlongRouteM).toBeCloseTo(1000, 0);
    expect(progress!.segmentIndex).toBe(STRAIGHT_ROUTE.length - 2);
    expect(progress!.segmentT).toBeCloseTo(1, 2);
  });

  it("kiest het juiste segment bij een route met een echte bocht (niet zomaar het eerste/laatste segment)", () => {
    // L-vormige route: 0,0 -> 1000,0 -> 1000,1000. Een punt vlak bij (1000, 500) hoort
    // duidelijk bij het TWEEDE segment, niet het eerste.
    const bentRoute: LatLon[] = [rdOffset(0, 0), rdOffset(1000, 0), rdOffset(1000, 1000)];
    const progress = computeRouteProgress(bentRoute, rdOffset(1000, 500));
    expect(progress!.segmentIndex).toBe(1);
    expect(progress!.distanceAlongRouteM).toBeCloseTo(1500, 0); // 1000 (eerste segment) + 500 (in het tweede)
    expect(progress!.perpendicularDistanceM).toBeCloseTo(0, 0);
  });
});
