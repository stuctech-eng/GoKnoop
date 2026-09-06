import { describe, it, expect } from "vitest";
import { NavigationSessionController } from "./navigation-session-controller";
import { DeviationDetector } from "../deviation/deviation-detector";
import { NavigationStateMachine } from "../session/navigation-state-machine";
import { ManualNavigationClock } from "../clock/navigation-clock";
import { rdToWgs84 } from "../../route-engine/coordinate-transform";
import type { GpsSample } from "../types";
import type { Point } from "../../route-engine/types";

const CONFIRM_MS = 5000;
const COOLDOWN_MS = 10000;
const GPS_TIMEOUT_MS = 10000;

const STRAIGHT_GEOMETRY: Point[] = [{ x: 0, y: 0 }, { x: 0, y: 1000 }];

function sampleAt(point: Point, overrides: Partial<GpsSample> = {}): GpsSample {
  const wgs84 = rdToWgs84(point.x, point.y);
  return {
    lat: wgs84.lat,
    lon: wgs84.lon,
    accuracyM: 5,
    headingDeg: null,
    speedMps: null,
    timestamp: 0,
    ...overrides,
  };
}

function setup() {
  const clock = new ManualNavigationClock(0);
  const stateMachine = new NavigationStateMachine({ deviationConfirmDurationMs: CONFIRM_MS, rerouteCooldownMs: COOLDOWN_MS });
  const detector = new DeviationDetector(STRAIGHT_GEOMETRY, stateMachine, clock, {
    deviationThresholdM: 15,
    accuracyThresholdM: 20,
    gpsTimeoutMs: GPS_TIMEOUT_MS,
    matchOptions: { baseWindowM: 100, windowMarginPerMps: 10, weights: { distance: 1, heading: 0.1, continuity: 0.5 } },
  });
  const controller = new NavigationSessionController(detector, stateMachine);
  return { clock, stateMachine, detector, controller };
}

describe("NavigationSessionController — kernonderscheid: GPS_LOST versus PERMISSION_DENIED zijn NIET hetzelfde", () => {
  it("ON_ROUTE → GPS_LOST → GPS hersteld → ON_ROUTE (signaal weg, toestemming intact)", () => {
    const { clock, stateMachine, controller } = setup();
    stateMachine.start();
    expect(stateMachine.getState()).toBe("ON_ROUTE");
    controller.processGpsSample(sampleAt({ x: 0, y: 50 })); // vestigt een geldige-fix-baseline

    clock.advance(GPS_TIMEOUT_MS + 1); // geen samples ondertussen -- signaal valt weg
    controller.checkGpsHealth();
    expect(stateMachine.getState()).toBe("GPS_LOST");

    const outcome = controller.processGpsSample(sampleAt({ x: 0, y: 300 })); // signaal hersteld, op de route
    expect(outcome.action).toBe("reported_on_route");
    expect(stateMachine.getState()).toBe("ON_ROUTE");
  });

  it("NOT_STARTED → PERMISSION_DENIED is een compleet ANDER pad -- geen GPS-signaal ooit betrokken", () => {
    const { stateMachine, controller } = setup();
    expect(stateMachine.getState()).toBe("NOT_STARTED");

    controller.denyPermission();
    expect(stateMachine.getState()).toBe("PERMISSION_DENIED");

    // In dit pad is nooit GPS_LOST gerapporteerd, en de sessie is nooit ON_ROUTE geweest --
    // een expliciet ander scenario dan GPS_LOST, niet een variant ervan.
  });

  it("een gebruiker die toestemming weigert kan niet via een GPS-signaal 'herstellen' -- alleen via grantPermission()", () => {
    const { stateMachine, controller } = setup();
    controller.denyPermission();
    expect(stateMachine.getState()).toBe("PERMISSION_DENIED");

    // Een binnenkomende GPS-sample verandert hier niets -- toestemming is een aparte as.
    // DeviationDetector (stap 6) vangt dit netjes op als "abstained", geen crash.
    const outcome = controller.processGpsSample(sampleAt({ x: 0, y: 300 }));
    expect(outcome.action).toBe("abstained");
    expect(stateMachine.getState()).toBe("PERMISSION_DENIED"); // ongewijzigd

    controller.grantPermission();
    expect(stateMachine.getState()).toBe("NOT_STARTED"); // vers, niet automatisch ON_ROUTE
  });

  it("toestemming intrekken tijdens een actieve, lopende sessie (niet vanuit NOT_STARTED) blijft een apart pad van GPS_LOST", () => {
    const { clock, stateMachine, controller } = setup();
    stateMachine.start();
    controller.processGpsSample(sampleAt({ x: 50, y: 500 })); // afwijking, POSSIBLE_DEVIATION
    expect(stateMachine.getState()).toBe("POSSIBLE_DEVIATION");

    controller.denyPermission(); // toestemming ingetrokken, GEEN GPS_LOST-tussenstap
    expect(stateMachine.getState()).toBe("PERMISSION_DENIED");
  });
});

describe("NavigationSessionController — GPS_LOST-mechaniek", () => {
  it("checkGpsHealth() is een no-op zolang het signaal niet daadwerkelijk kwijt is", () => {
    const { clock, stateMachine, controller } = setup();
    stateMachine.start();
    controller.processGpsSample(sampleAt({ x: 0, y: 100 }));
    clock.advance(GPS_TIMEOUT_MS - 1);
    controller.checkGpsHealth();
    expect(stateMachine.getState()).toBe("ON_ROUTE"); // niet naar GPS_LOST
  });

  it("herhaaldelijk checkGpsHealth() aanroepen terwijl het signaal kwijt blijft, crasht niet (idempotent)", () => {
    const { clock, stateMachine, controller } = setup();
    stateMachine.start();
    controller.processGpsSample(sampleAt({ x: 0, y: 50 })); // vestigt een geldige-fix-baseline
    clock.advance(GPS_TIMEOUT_MS + 1);
    controller.checkGpsHealth();
    expect(stateMachine.getState()).toBe("GPS_LOST");
    expect(() => controller.checkGpsHealth()).not.toThrow(); // GPS_LOST -> GPS_LOST is ongeldig, wordt stil afgevangen
    expect(stateMachine.getState()).toBe("GPS_LOST");
  });

  it("checkGpsHealth() heeft geen effect in eindstadia (ARRIVED/CANCELLED) -- geen crash", () => {
    const { stateMachine, controller } = setup();
    stateMachine.start();
    stateMachine.arrive();
    expect(() => controller.checkGpsHealth()).not.toThrow();
    expect(stateMachine.getState()).toBe("ARRIVED");
  });

  it("processGpsSample() detecteert een GPS_LOST-periode vóór de nieuwe sample verwerkt wordt", () => {
    const { clock, stateMachine, controller } = setup();
    stateMachine.start();
    controller.processGpsSample(sampleAt({ x: 0, y: 100 }));
    clock.advance(GPS_TIMEOUT_MS + 1);
    // Eén enkele aanroep: detecteert GPS_LOST (want er kwam lang niets binnen) EN verwerkt
    // meteen deze nieuwe, geldige sample, die de sessie weer herstelt.
    const outcome = controller.processGpsSample(sampleAt({ x: 0, y: 400 }));
    expect(outcome.action).toBe("reported_on_route");
    expect(stateMachine.getState()).toBe("ON_ROUTE");
  });
});

describe("NavigationSessionController — pause/resume", () => {
  it("pause() en resume() delegeren rechtstreeks naar de state machine", () => {
    const { stateMachine, controller } = setup();
    stateMachine.start();
    controller.pause();
    expect(stateMachine.getState()).toBe("PAUSED");
    controller.resume();
    expect(stateMachine.getState()).toBe("ON_ROUTE");
  });
});

describe("NavigationSessionController — checkArrival", () => {
  it("meldt aankomst wanneer de resterende afstand de drempel bereikt, alleen vanuit ON_ROUTE", () => {
    const { stateMachine, controller } = setup();
    stateMachine.start();
    const arrived = controller.checkArrival(4, 5); // 4m resterend, drempel 5m
    expect(arrived).toBe(true);
    expect(stateMachine.getState()).toBe("ARRIVED");
  });

  it("meldt geen aankomst als de resterende afstand nog boven de drempel ligt", () => {
    const { stateMachine, controller } = setup();
    stateMachine.start();
    const arrived = controller.checkArrival(500, 5);
    expect(arrived).toBe(false);
    expect(stateMachine.getState()).toBe("ON_ROUTE");
  });

  it("heeft geen effect buiten ON_ROUTE (bijv. tijdens POSSIBLE_DEVIATION)", () => {
    const { stateMachine, controller } = setup();
    stateMachine.start();
    stateMachine.reportDeviation(0);
    expect(stateMachine.getState()).toBe("POSSIBLE_DEVIATION");
    const arrived = controller.checkArrival(1, 5);
    expect(arrived).toBe(false);
    expect(stateMachine.getState()).toBe("POSSIBLE_DEVIATION");
  });
});

describe("NavigationSessionController — cancel", () => {
  it("cancel() delegeert naar de state machine vanuit elke actieve state", () => {
    const { stateMachine, controller } = setup();
    stateMachine.start();
    controller.cancel();
    expect(stateMachine.getState()).toBe("CANCELLED");
  });
});

describe("NavigationSessionController — getState", () => {
  it("geeft de actuele state machine-state terug", () => {
    const { stateMachine, controller } = setup();
    expect(controller.getState()).toBe("NOT_STARTED");
    stateMachine.start();
    expect(controller.getState()).toBe("ON_ROUTE");
  });
});
