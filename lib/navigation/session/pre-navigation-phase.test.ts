import { describe, it, expect } from "vitest";
import { determinePreNavigationPhase } from "./pre-navigation-phase";

const BASE = {
  sessionStarted: false,
  distanceToStartM: 100,
  arrivalAtStartThresholdM: 25,
  navigationState: "NOT_STARTED" as const,
  speedMps: null,
  movementSpeedThresholdMps: 0.5,
};

describe("determinePreNavigationPhase — A. Naar startpunt", () => {
  it("blijft TO_START zolang de sessie niet gestart is en de gebruiker buiten de aankomstdrempel is", () => {
    expect(determinePreNavigationPhase({ ...BASE, distanceToStartM: 100 })).toBe("TO_START");
  });

  it("schakelt naar START_GUIDANCE zodra de gebruiker binnen de aankomstdrempel komt, óók vóór sessiestart", () => {
    expect(determinePreNavigationPhase({ ...BASE, distanceToStartM: 20 })).toBe("START_GUIDANCE");
  });

  it("de drempel is inclusief (exact op de grens telt als aangekomen)", () => {
    expect(determinePreNavigationPhase({ ...BASE, distanceToStartM: 25, arrivalAtStartThresholdM: 25 })).toBe("START_GUIDANCE");
  });
});

describe("determinePreNavigationPhase — B. Start Guidance", () => {
  it("blijft START_GUIDANCE als de sessie gestart is maar de state nog geen ON_ROUTE is", () => {
    expect(
      determinePreNavigationPhase({ ...BASE, sessionStarted: true, navigationState: "POSSIBLE_DEVIATION", speedMps: 2 })
    ).toBe("START_GUIDANCE");
  });

  it("blijft START_GUIDANCE als de state ON_ROUTE is maar er nog geen betrouwbare snelheid is (speedMps null)", () => {
    expect(determinePreNavigationPhase({ ...BASE, sessionStarted: true, navigationState: "ON_ROUTE", speedMps: null })).toBe(
      "START_GUIDANCE"
    );
  });

  it("blijft START_GUIDANCE als de snelheid onder de bewegingsdrempel ligt (bijv. stilstaan bij een stoplicht)", () => {
    expect(
      determinePreNavigationPhase({ ...BASE, sessionStarted: true, navigationState: "ON_ROUTE", speedMps: 0.2 })
    ).toBe("START_GUIDANCE");
  });

  it("de bewegingsdrempel is exclusief (exact op de grens is nog GEEN betrouwbare beweging)", () => {
    expect(
      determinePreNavigationPhase({ ...BASE, sessionStarted: true, navigationState: "ON_ROUTE", speedMps: 0.5, movementSpeedThresholdMps: 0.5 })
    ).toBe("START_GUIDANCE");
  });
});

describe("determinePreNavigationPhase — C. Navigatie", () => {
  it("schakelt naar NAVIGATING zodra de state ON_ROUTE is én de snelheid boven de bewegingsdrempel ligt", () => {
    expect(determinePreNavigationPhase({ ...BASE, sessionStarted: true, navigationState: "ON_ROUTE", speedMps: 3 })).toBe(
      "NAVIGATING"
    );
  });

  it("valt terug naar START_GUIDANCE als de gebruiker stopt met bewegen (state blijft ON_ROUTE, snelheid daalt)", () => {
    const moving = determinePreNavigationPhase({ ...BASE, sessionStarted: true, navigationState: "ON_ROUTE", speedMps: 3 });
    expect(moving).toBe("NAVIGATING");
    const stopped = determinePreNavigationPhase({ ...BASE, sessionStarted: true, navigationState: "ON_ROUTE", speedMps: 0 });
    expect(stopped).toBe("START_GUIDANCE");
  });

  it("NAVIGATING niet mogelijk bij een afwijkende state, ook niet met hoge snelheid", () => {
    expect(
      determinePreNavigationPhase({ ...BASE, sessionStarted: true, navigationState: "OFF_ROUTE", speedMps: 5 })
    ).toBe("START_GUIDANCE");
  });
});
