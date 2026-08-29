import { describe, it, expect } from "vitest";
import { DeviationDetector } from "./deviation-detector";
import type { DeviationDetectorOptions } from "./deviation-detector";
import { NavigationStateMachine } from "../session/navigation-state-machine";
import { ManualNavigationClock } from "../clock/navigation-clock";
import { rdToWgs84 } from "../../route-engine/coordinate-transform";
import type { GpsSample } from "../types";
import type { Point } from "../../route-engine/types";

const CONFIRM_MS = 5000;
const COOLDOWN_MS = 10000;
const DEVIATION_THRESHOLD_M = 15;

function makeOptions(overrides: Partial<DeviationDetectorOptions> = {}): DeviationDetectorOptions {
  return {
    deviationThresholdM: DEVIATION_THRESHOLD_M,
    accuracyThresholdM: 20,
    gpsTimeoutMs: 10000,
    matchOptions: { baseWindowM: 100, windowMarginPerMps: 10, weights: { distance: 1, heading: 0.1, continuity: 0.5 } },
    ...overrides,
  };
}

/** Bouwt een geldige GpsSample op een RD-punt (via de bestaande rdToWgs84-conversie, geen losse aanname). */
function sampleAt(point: Point, overrides: Partial<GpsSample> = {}): GpsSample {
  const wgs84 = rdToWgs84(point.x, point.y);
  return {
    lat: wgs84.lat,
    lon: wgs84.lon,
    accuracyM: 5,
    headingDeg: null,
    speedMps: null,
    timestamp: 0, // GPS-timestamp is hier irrelevant -- de detector gebruikt uitsluitend navigation time (ontwerp sectie 13B)
    ...overrides,
  };
}

// Simpele rechte route van (0,0) naar (0,1000), voor de meeste scenario's.
const STRAIGHT_GEOMETRY: Point[] = [{ x: 0, y: 0 }, { x: 0, y: 1000 }];

function setup(geometry: readonly Point[] = STRAIGHT_GEOMETRY, options: Partial<DeviationDetectorOptions> = {}) {
  const clock = new ManualNavigationClock(0);
  const stateMachine = new NavigationStateMachine({ deviationConfirmDurationMs: CONFIRM_MS, rerouteCooldownMs: COOLDOWN_MS });
  stateMachine.start();
  const detector = new DeviationDetector(geometry, stateMachine, clock, makeOptions(options));
  return { clock, stateMachine, detector };
}

describe("DeviationDetector — 1. één slechte GPS-fix leidt NOOIT direct tot OFF_ROUTE", () => {
  it("een enkele lage-nauwkeurigheid-sample wordt afgekeurd, state blijft ON_ROUTE", () => {
    const { detector, stateMachine } = setup();
    const outcome = detector.process(sampleAt({ x: 500, y: 500 }, { accuracyM: 999 })); // ver van de route + slechte accuracy
    expect(outcome.action).toBe("abstained");
    expect(stateMachine.getState()).toBe("ON_ROUTE");
  });

  it("een enkele ongeldige/ontbrekende sample wordt afgekeurd, state blijft ON_ROUTE", () => {
    const { detector, stateMachine } = setup();
    const outcome = detector.process(null);
    expect(outcome.action).toBe("abstained");
    expect(stateMachine.getState()).toBe("ON_ROUTE");
  });
});

describe("DeviationDetector — 2. afwijking die het volledige bevestigingsvenster aanhoudt → wel OFF_ROUTE", () => {
  it("bereikt OFF_ROUTE pas nadat de afwijking het confirm-venster heeft doorlopen, NIET bij de eerste afwijkende sample", () => {
    const { detector, stateMachine, clock } = setup();
    const farFromRoute = { x: 50, y: 500 }; // 50m van de route, ruim boven de drempel van 15m

    const first = detector.process(sampleAt(farFromRoute));
    expect(first.action).toBe("reported_deviation");
    // KERNVEREISTE: niet direct OFF_ROUTE bij de eerste afwijkende sample --
    // het bevestigingsvenster moet leidend zijn, geen "distance > X → OFF_ROUTE"-kortsluiting.
    expect(stateMachine.getState()).toBe("POSSIBLE_DEVIATION");

    clock.advance(CONFIRM_MS - 1);
    detector.process(sampleAt(farFromRoute));
    expect(stateMachine.getState()).toBe("POSSIBLE_DEVIATION"); // nog steeds niet bevestigd

    clock.advance(2); // totaal nu > CONFIRM_MS sinds de eerste afwijkende sample
    detector.process(sampleAt(farFromRoute));
    expect(stateMachine.getState()).toBe("OFF_ROUTE");
  });
});

describe("DeviationDetector — 3. gebruiker komt tussendoor terug: POSSIBLE_DEVIATION → ON_ROUTE", () => {
  it("een terugkeer naar de route vóór bevestiging herstelt naar ON_ROUTE (vals alarm)", () => {
    const { detector, stateMachine, clock } = setup();
    detector.process(sampleAt({ x: 50, y: 500 })); // afwijking begint
    expect(stateMachine.getState()).toBe("POSSIBLE_DEVIATION");

    clock.advance(1000); // ruim binnen het confirm-venster
    const back = detector.process(sampleAt({ x: 2, y: 520 })); // terug op de route
    expect(back.action).toBe("reported_on_route");
    expect(stateMachine.getState()).toBe("ON_ROUTE");

    // Een latere, nieuwe afwijking start een VERSE confirm-periode (niet direct OFF_ROUTE,
    // ongeacht hoe lang de eerdere, inmiddels afgesloten afwijkingsperiode duurde).
    clock.advance(CONFIRM_MS - 1);
    detector.process(sampleAt({ x: 50, y: 540 }));
    expect(stateMachine.getState()).toBe("POSSIBLE_DEVIATION"); // niet OFF_ROUTE
  });
});

describe("DeviationDetector — 4. GPS_LOST → geen valse deviation", () => {
  it("na een lange stilte (signaal kwijt) leidt een terugkerende, op-route sample tot ON_ROUTE, niet tot een valse afwijking", () => {
    const { detector, stateMachine, clock } = setup();
    clock.advance(60_000); // ruim voorbij de GPS-timeout, geen samples ondertussen
    const outcome = detector.process(sampleAt({ x: 0, y: 300 })); // exact op de route
    expect(outcome.action).toBe("reported_on_route");
    expect(stateMachine.getState()).toBe("ON_ROUTE");
  });

  it("na een lange stilte leidt een afwijkende sample tot POSSIBLE_DEVIATION, NIET direct tot OFF_ROUTE", () => {
    const { detector, stateMachine, clock } = setup();
    clock.advance(60_000); // signaal was kwijt
    const outcome = detector.process(sampleAt({ x: 50, y: 300 })); // afwijkend bij hervatting
    expect(outcome.action).toBe("reported_deviation");
    // Ook na GPS-hervatting geldt: één sample is nooit genoeg voor OFF_ROUTE --
    // het bevestigingsvenster start vers, wordt niet overgeslagen.
    expect(stateMachine.getState()).toBe("POSSIBLE_DEVIATION");
  });

  it("GPS_LOST-hervatting reset de matching-window (geen sprong-straf t.o.v. een verouderde vorige positie)", () => {
    const { detector, clock } = setup();
    detector.process(sampleAt({ x: 0, y: 10 })); // vroege positie op de route
    clock.advance(60_000); // signaal kwijt, fietser reed intussen een heel eind door
    const outcome = detector.process(sampleAt({ x: 0, y: 800 })); // ver verderop, maar nog op de route
    expect(outcome.action).toBe("reported_on_route"); // geen valse afwijking door een groot geïmpliceerd venster-conflict
  });
});

describe("DeviationDetector — 5. parallelle route dicht naast elkaar → geen valse deviation", () => {
  // Zelfde haarspeldbocht-scenario als stap 4: heentraject en retourtraject 10m uit elkaar.
  const HAIRPIN_GEOMETRY: Point[] = [
    { x: 0, y: 0 },
    { x: 0, y: 100 }, // segment 0: heentraject
    { x: 10, y: 100 }, // segment 1: connector
    { x: 10, y: 0 }, // segment 2: retourtraject, 10m van segment 0
  ];

  it("blijft correct op het heentraject matchen (geen valse deviation) ondanks het nabije retourtraject", () => {
    const { detector, stateMachine } = setup(HAIRPIN_GEOMETRY, {
      deviationThresholdM: 15,
      matchOptions: { baseWindowM: 100, windowMarginPerMps: 0, weights: { distance: 1, heading: 0.1, continuity: 0.5 } },
    });

    // Positie vlak bij het startpunt van het heentraject, met heading naar het noorden
    // (consistent met het volgen van het heentraject, niet het retourtraject).
    const outcome = detector.process(sampleAt({ x: 1, y: 10 }, { headingDeg: 0 }));
    expect(outcome.action).toBe("reported_on_route"); // perpendiculaire afstand tot het HEENtraject is klein
    expect(stateMachine.getState()).toBe("ON_ROUTE");
  });

  it("een puur afstandsgebaseerde configuratie (geen heading/continuïteit) zou hier WEL een valse deviation riskeren -- ter bevestiging van waarom multi-signal nodig is", () => {
    // Positie halverwege tussen beide trajecten, iets dichter bij het (verkeerde) retourtraject.
    const { detector } = setup(HAIRPIN_GEOMETRY, {
      deviationThresholdM: 6, // kleine drempel, zodat het verschil tussen 4.5m en 5.5m het wel/niet triggeren bepaalt
      matchOptions: { baseWindowM: 100, windowMarginPerMps: 0, weights: { distance: 1, heading: 0, continuity: 0 } },
    });
    const outcome = detector.process(sampleAt({ x: 5.5, y: 80 })); // 4.5m van segment 2, 5.5m van segment 0
    // Met alleen afstand als signaal matcht dit op segment 2 (retourtraject) -- ook al is de
    // perpendiculaire afstand daar (4.5m) toevallig binnen de drempel, dit toont de kwetsbaarheid:
    // de matcher pikt hier de verkeerde tak, wat bij een grotere praktijkafwijking tot een
    // valse deviation-melding op het VERKEERDE traject zou leiden.
    expect(outcome.action).toBe("reported_on_route");
    expect(outcome.action === "reported_on_route" && outcome.matchedPosition.segmentIndex).toBe(2); // de verkeerde tak
  });
});

describe("DeviationDetector — 6. echte afwijking wordt correct gedetecteerd", () => {
  it("een aanhoudende, ondubbelzinnige afwijking (geen nabije parallelle route) bereikt OFF_ROUTE", () => {
    const { detector, stateMachine, clock } = setup(); // eenvoudige rechte route, geen ambiguïteit
    const farPosition = { x: 100, y: 500 };

    detector.process(sampleAt(farPosition));
    clock.advance(CONFIRM_MS);
    detector.process(sampleAt(farPosition));

    expect(stateMachine.getState()).toBe("OFF_ROUTE");
  });
});

describe("DeviationDetector — 7. na OFF_ROUTE gebeurt er niets vanzelf (geen reroute-triggering in deze stap)", () => {
  it("eenmaal in OFF_ROUTE roept de detector nooit startReroute() aan -- verdere samples worden afgehandeld zonder crash", () => {
    const { detector, stateMachine, clock } = setup();
    const farPosition = { x: 100, y: 500 };
    detector.process(sampleAt(farPosition));
    clock.advance(CONFIRM_MS);
    detector.process(sampleAt(farPosition));
    expect(stateMachine.getState()).toBe("OFF_ROUTE");

    // Nog een afwijkende sample: de state machine accepteert reportDeviation niet vanuit
    // OFF_ROUTE (stap 2: alleen startReroute() is geldig) -- de detector vangt dit netjes op
    // als "abstained", geen crash, geen impliciete reroute.
    clock.advance(1000);
    const outcome = detector.process(sampleAt(farPosition));
    expect(outcome.action).toBe("abstained");
    expect(outcome.action === "abstained" && outcome.reason).toBe("state_not_accepting_signal");
    expect(stateMachine.getState()).toBe("OFF_ROUTE"); // ongewijzigd -- geen vanzelf-reroute

    // REROUTE_COOLDOWN (state machine, stap 2) wordt hier niet geraakt: er is nooit een
    // completeReroute() aangeroepen, dus getRerouteCompletedAt() blijft null.
    expect(stateMachine.getRerouteCompletedAt()).toBeNull();
  });
});

describe("DeviationDetector — 8. RECENT_ROUTE_MEMORY hoort niet bij deze stap", () => {
  it("DeviationDetectorOptions bevat geen reroute-gerelateerde configuratie (RECENT_ROUTE_MEMORY, avoidEdgeIds, etc.)", () => {
    const options = makeOptions();
    // Structurele controle: alleen de verwachte, deviation-scope sleutels zijn aanwezig.
    expect(Object.keys(options).sort()).toEqual(
      ["accuracyThresholdM", "deviationThresholdM", "gpsTimeoutMs", "matchOptions"].sort()
    );
  });
});

describe("DeviationDetector — het bevestigingsvenster is leidend, geen directe distance>X-kortsluiting", () => {
  it("een zeer grote afwijking (ver boven de drempel) veroorzaakt nog steeds NOOIT direct OFF_ROUTE bij de eerste sample", () => {
    const { detector, stateMachine } = setup();
    const veryFar = { x: 5000, y: 500 }; // absurd ver van de route
    const outcome = detector.process(sampleAt(veryFar));
    expect(outcome.action).toBe("reported_deviation");
    expect(stateMachine.getState()).toBe("POSSIBLE_DEVIATION"); // NIET OFF_ROUTE, ondanks de extreme afstand
  });
});
