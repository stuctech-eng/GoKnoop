import { describe, it, expect } from "vitest";
import { RouteNavigationSession, DEFAULT_ROUTE_NAVIGATION_OPTIONS } from "./route-navigation-session";
import { wgs84ToRd, rdToWgs84 } from "@/lib/route-engine/coordinate-transform";
import type { LatLon, NavigationRoute } from "./types";

const ORIGIN_RD = wgs84ToRd(52.5, 5.0);
function rdOffset(dxM: number, dyM: number): LatLon {
  const p = rdToWgs84(ORIGIN_RD.x + dxM, ORIGIN_RD.y + dyM);
  return { lat: p.lat, lon: p.lon };
}

function straightRoute(lengthM: number): NavigationRoute {
  return {
    geometry: [rdOffset(0, 0), rdOffset(lengthM, 0)],
    distanceM: lengthM,
    durationS: lengthM / 4, // willekeurige, plausibele fietssnelheid
    steps: [{ name: "Testweg", instruction: "Head east", distanceM: lengthM }],
  };
}

/** Route met twee opeenvolgende bochten: bij 500m (rechts) en bij 1000m (links). */
function twoTurnsRoute(): NavigationRoute {
  return {
    geometry: [rdOffset(0, 0), rdOffset(500, 0), rdOffset(500, -500), rdOffset(0, -500)],
    distanceM: 1500,
    durationS: 375,
    steps: [{ name: "Testweg", instruction: "Head east", distanceM: 1500 }],
  };
}

describe("RouteNavigationSession", () => {
  it("geeft null terug voor een sample als de route zelf geen geldige progressie oplevert (bijv. lege geometrie)", () => {
    const session = new RouteNavigationSession({ geometry: [], distanceM: 0, durationS: 0, steps: [] });
    expect(session.process({ position: rdOffset(0, 0), headingDeg: 90, speedMps: 5 })).toBeNull();
  });

  it("een sample precies op de route geeft normale voortgang en geen afwijking", () => {
    const session = new RouteNavigationSession(straightRoute(1000));
    const update = session.process({ position: rdOffset(200, 0), headingDeg: 90, speedMps: 5 });
    expect(update).not.toBeNull();
    expect(update!.progress.distanceAlongRouteM).toBeCloseTo(200, 0);
    expect(update!.offRoute.isOffRoute).toBe(false);
    expect(update!.arrived).toBe(false);
  });

  it("afwijking wordt pas na het geconfigureerde aantal opeenvolgende samples als 'echt' aangemerkt (demping tegen één GPS-uitschieter)", () => {
    const session = new RouteNavigationSession(straightRoute(1000));
    const farOff: LatLon = rdOffset(200, 100); // ruim boven de standaard offRouteThresholdM van 40

    const first = session.process({ position: farOff, headingDeg: 90, speedMps: 5 });
    expect(first!.offRoute.isOffRoute).toBe(false); // 1 sample, nog niet bevestigd
    expect(first!.offRoute.consecutiveOffRouteSamples).toBe(1);

    const second = session.process({ position: farOff, headingDeg: 90, speedMps: 5 });
    expect(second!.offRoute.isOffRoute).toBe(false); // 2 samples, nog niet bevestigd (standaard drempel is 3)

    const third = session.process({ position: farOff, headingDeg: 90, speedMps: 5 });
    expect(third!.offRoute.isOffRoute).toBe(true); // 3 samples -- nu bevestigd
  });

  it("een sample weer terug op de route zet de teller direct terug naar 0 (geen blijvende afwijking na herstel)", () => {
    const session = new RouteNavigationSession(straightRoute(1000));
    const farOff: LatLon = rdOffset(200, 100);
    session.process({ position: farOff, headingDeg: 90, speedMps: 5 });
    session.process({ position: farOff, headingDeg: 90, speedMps: 5 });
    // Terug op de route vóór de derde, bevestigende sample:
    const backOnRoute = session.process({ position: rdOffset(200, 0), headingDeg: 90, speedMps: 5 });
    expect(backOnRoute!.offRoute.isOffRoute).toBe(false);
    expect(backOnRoute!.offRoute.consecutiveOffRouteSamples).toBe(0);
  });

  it("binnen de aankomstdrempel van het eindpunt wordt arrived: true", () => {
    const session = new RouteNavigationSession(straightRoute(1000));
    const update = session.process({ position: rdOffset(990, 0), headingDeg: 90, speedMps: 5 }); // 10m resterend, ruim binnen de standaard 25m
    expect(update!.arrived).toBe(true);
  });

  it("ver van het eindpunt is arrived: false", () => {
    const session = new RouteNavigationSession(straightRoute(1000));
    const update = session.process({ position: rdOffset(500, 0), headingDeg: 90, speedMps: 5 });
    expect(update!.arrived).toBe(false);
  });

  it("bij lage snelheid (onder de headingSpeedThresholdMps) blijft de laatst betrouwbare heading vastgehouden i.p.v. abrupt te veranderen", () => {
    const session = new RouteNavigationSession(straightRoute(1000));
    const moving = session.process({ position: rdOffset(100, 0), headingDeg: 90, speedMps: 5 });
    expect(moving!.smoothedHeadingDeg).not.toBeNull();
    const stoppedWithWildHeading = session.process({ position: rdOffset(105, 0), headingDeg: 270, speedMps: 0.1 }); // onder de standaard 0,5 m/s-drempel
    // Heading mag niet abrupt naar 270 gesprongen zijn -- de vorige, betrouwbare waarde blijft leidend.
    expect(stoppedWithWildHeading!.smoothedHeadingDeg).toBeCloseTo(moving!.smoothedHeadingDeg!, 0);
  });

  it("berekent nextManeuver als de manoeuvre NÁ de eerstvolgende manoeuvre (Apple-stijl 'daarna'-voorspelling)", () => {
    const session = new RouteNavigationSession(twoTurnsRoute());
    const update = session.process({ position: rdOffset(100, 0), headingDeg: 90, speedMps: 5 });
    expect(update!.maneuver).not.toBeNull();
    expect(update!.nextManeuver).not.toBeNull();
    // De twee gevonden manoeuvres moeten verschillende bochten zijn (niet twee keer dezelfde).
    expect(update!.maneuver!.atGeometryIndex).not.toBe(update!.nextManeuver!.atGeometryIndex);
  });

  it("nextManeuver is null als er geen manoeuvre gevonden wordt (niets om een 'daarna' voor te berekenen)", () => {
    const session = new RouteNavigationSession(straightRoute(1000));
    const update = session.process({ position: rdOffset(100, 0), headingDeg: 90, speedMps: 5 });
    expect(update!.maneuver).toBeNull();
    expect(update!.nextManeuver).toBeNull();
  });

  it("gebruikt de meegegeven, aangepaste opties i.p.v. de standaardwaarden wanneer expliciet gegeven", () => {
    const session = new RouteNavigationSession(straightRoute(1000), {
      ...DEFAULT_ROUTE_NAVIGATION_OPTIONS,
      offRouteConfirmSamples: 1, // direct bevestigen, geen demping
    });
    const farOff: LatLon = rdOffset(200, 100);
    const update = session.process({ position: farOff, headingDeg: 90, speedMps: 5 });
    expect(update!.offRoute.isOffRoute).toBe(true); // al bij de eerste sample, want confirmSamples=1
  });
});
