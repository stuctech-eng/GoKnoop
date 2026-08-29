import { describe, it, expect } from "vitest";
import { NavigationStateMachine, InvalidNavigationTransitionError } from "./navigation-state-machine";

const OPTIONS = { deviationConfirmDurationMs: 5000, rerouteCooldownMs: 10000 };

function started(): NavigationStateMachine {
  const m = new NavigationStateMachine(OPTIONS);
  m.start();
  return m;
}

describe("NavigationStateMachine — basisstate en sessiestart", () => {
  it("start in NOT_STARTED", () => {
    const m = new NavigationStateMachine(OPTIONS);
    expect(m.getState()).toBe("NOT_STARTED");
  });

  it("start() gaat naar ON_ROUTE", () => {
    const m = new NavigationStateMachine(OPTIONS);
    m.start();
    expect(m.getState()).toBe("ON_ROUTE");
  });

  it("start() vanuit een andere state dan NOT_STARTED gooit een fout", () => {
    const m = started();
    expect(() => m.start()).toThrow(InvalidNavigationTransitionError);
  });
});

describe("NavigationStateMachine — PERMISSION_DENIED", () => {
  it("denyPermission() vanuit NOT_STARTED gaat naar PERMISSION_DENIED", () => {
    const m = new NavigationStateMachine(OPTIONS);
    m.denyPermission();
    expect(m.getState()).toBe("PERMISSION_DENIED");
  });

  it("denyPermission() is ook geldig vanuit een actieve sessie (toestemming ingetrokken, ontwerp sectie 14)", () => {
    const m = started();
    m.reportDeviation(1000);
    expect(m.getState()).toBe("POSSIBLE_DEVIATION");
    m.denyPermission();
    expect(m.getState()).toBe("PERMISSION_DENIED");
  });

  it("grantPermission() gaat terug naar NOT_STARTED, geen hervatting van oude state", () => {
    const m = new NavigationStateMachine(OPTIONS);
    m.denyPermission();
    m.grantPermission();
    expect(m.getState()).toBe("NOT_STARTED");
  });

  it("grantPermission() vanuit een andere state dan PERMISSION_DENIED gooit een fout", () => {
    const m = started();
    expect(() => m.grantPermission()).toThrow(InvalidNavigationTransitionError);
  });

  it("denyPermission() vanuit ARRIVED of CANCELLED gooit een fout (eindstadia)", () => {
    const m1 = started();
    m1.arrive();
    expect(() => m1.denyPermission()).toThrow(InvalidNavigationTransitionError);

    const m2 = started();
    m2.cancel();
    expect(() => m2.denyPermission()).toThrow(InvalidNavigationTransitionError);
  });

  it("PERMISSION_DENIED accepteert geen positiesignalen", () => {
    const m = new NavigationStateMachine(OPTIONS);
    m.denyPermission();
    expect(() => m.reportOnRoute(0)).toThrow(InvalidNavigationTransitionError);
    expect(() => m.reportDeviation(0)).toThrow(InvalidNavigationTransitionError);
  });
});

describe("NavigationStateMachine — afwijkingsdetectie en hysterese (ontwerp sectie 9/11)", () => {
  it("reportDeviation vanuit ON_ROUTE gaat naar POSSIBLE_DEVIATION, niet direct naar OFF_ROUTE", () => {
    const m = started();
    m.reportDeviation(1000);
    expect(m.getState()).toBe("POSSIBLE_DEVIATION");
  });

  it("reportOnRoute vanuit POSSIBLE_DEVIATION gaat terug naar ON_ROUTE (vals alarm, kern van de hysterese)", () => {
    const m = started();
    m.reportDeviation(1000);
    expect(m.getState()).toBe("POSSIBLE_DEVIATION");
    m.reportOnRoute(1500);
    expect(m.getState()).toBe("ON_ROUTE");
    expect(m.getPossibleDeviationSince()).toBeNull();
  });

  it("reportDeviation die blijft aanhouden maar het confirm-venster nog niet heeft bereikt, blijft POSSIBLE_DEVIATION", () => {
    const m = started();
    m.reportDeviation(0);
    m.reportDeviation(2000); // 2000ms < deviationConfirmDurationMs (5000ms)
    expect(m.getState()).toBe("POSSIBLE_DEVIATION");
  });

  it("reportDeviation die het confirm-venster bereikt, bevestigt naar OFF_ROUTE", () => {
    const m = started();
    m.reportDeviation(0);
    m.reportDeviation(5000); // exact op de drempel
    expect(m.getState()).toBe("OFF_ROUTE");
  });

  it("het confirm-venster meet vanaf het EERSTE afwijkingssignaal, niet vanaf het vorige", () => {
    const m = started();
    m.reportDeviation(0);
    m.reportDeviation(3000); // nog steeds < 5000ms sinds t=0 -> blijft POSSIBLE_DEVIATION
    expect(m.getState()).toBe("POSSIBLE_DEVIATION");
    m.reportDeviation(4900); // 4900ms sinds t=0, nog steeds < 5000ms
    expect(m.getState()).toBe("POSSIBLE_DEVIATION");
    m.reportDeviation(5001); // 5001ms sinds t=0 -> bevestigd
    expect(m.getState()).toBe("OFF_ROUTE");
  });

  it("na een vals alarm (terug naar ON_ROUTE) start een nieuwe afwijking een verse confirm-periode", () => {
    const m = started();
    m.reportDeviation(0);
    m.reportOnRoute(1000); // vals alarm
    m.reportDeviation(1100); // nieuwe afwijking begint
    expect(m.getState()).toBe("POSSIBLE_DEVIATION");
    m.reportDeviation(1100 + 4999); // nog niet 5000ms sinds 1100
    expect(m.getState()).toBe("POSSIBLE_DEVIATION");
    m.reportDeviation(1100 + 5000); // nu wel
    expect(m.getState()).toBe("OFF_ROUTE");
  });

  it("reportDeviation vanuit NOT_STARTED of OFF_ROUTE gooit een fout (geen gedefinieerde transitie)", () => {
    const m1 = new NavigationStateMachine(OPTIONS);
    expect(() => m1.reportDeviation(0)).toThrow(InvalidNavigationTransitionError);

    const m2 = started();
    m2.reportDeviation(0);
    m2.reportDeviation(5000); // -> OFF_ROUTE
    expect(m2.getState()).toBe("OFF_ROUTE");
    expect(() => m2.reportDeviation(6000)).toThrow(InvalidNavigationTransitionError);
  });
});

describe("NavigationStateMachine — reroute-levenscyclus (mechaniek, ontwerp sectie 10/14)", () => {
  function offRoute(): NavigationStateMachine {
    const m = started();
    m.reportDeviation(0);
    m.reportDeviation(5000);
    expect(m.getState()).toBe("OFF_ROUTE");
    return m;
  }

  it("startReroute vanuit OFF_ROUTE gaat naar REROUTING", () => {
    const m = offRoute();
    m.startReroute();
    expect(m.getState()).toBe("REROUTING");
  });

  it("startReroute vanuit een andere state dan OFF_ROUTE gooit een fout", () => {
    const m = started();
    expect(() => m.startReroute()).toThrow(InvalidNavigationTransitionError);
  });

  it("completeReroute vanuit REROUTING gaat naar REROUTED en registreert het tijdstip", () => {
    const m = offRoute();
    m.startReroute();
    m.completeReroute(9000);
    expect(m.getState()).toBe("REROUTED");
    expect(m.getRerouteCompletedAt()).toBe(9000);
  });

  it("failReroute vanuit REROUTING gaat terug naar OFF_ROUTE (ontwerp sectie 19)", () => {
    const m = offRoute();
    m.startReroute();
    m.failReroute();
    expect(m.getState()).toBe("OFF_ROUTE");
  });

  it("completeReroute/failReroute vanuit een andere state dan REROUTING gooit een fout", () => {
    const m = offRoute();
    expect(() => m.completeReroute(0)).toThrow(InvalidNavigationTransitionError);
    expect(() => m.failReroute()).toThrow(InvalidNavigationTransitionError);
  });
});

describe("NavigationStateMachine — cooldown na REROUTED (ontwerp sectie 11)", () => {
  function rerouted(completedAt: number): NavigationStateMachine {
    const m = started();
    m.reportDeviation(0);
    m.reportDeviation(5000);
    m.startReroute();
    m.completeReroute(completedAt);
    expect(m.getState()).toBe("REROUTED");
    return m;
  }

  it("een afwijkingssignaal binnen de cooldown wordt genegeerd -- state blijft REROUTED", () => {
    const m = rerouted(9000);
    m.reportDeviation(9000 + OPTIONS.rerouteCooldownMs - 1); // net binnen de cooldown
    expect(m.getState()).toBe("REROUTED");
    expect(m.getPossibleDeviationSince()).toBeNull(); // geen afwijkingsperiode gestart
  });

  it("een afwijkingssignaal ná de cooldown wordt weer normaal in behandeling genomen", () => {
    const m = rerouted(9000);
    const t = 9000 + OPTIONS.rerouteCooldownMs; // exact op de grens, cooldown verstreken
    m.reportDeviation(t);
    expect(m.getState()).toBe("POSSIBLE_DEVIATION");
    expect(m.getPossibleDeviationSince()).toBe(t);
  });

  it("reportOnRoute vanuit REROUTED werkt ALTIJD, ongeacht cooldown (positief signaal wordt niet onderdrukt)", () => {
    const m = rerouted(9000);
    m.reportOnRoute(9000 + 1); // ruim binnen de cooldown
    expect(m.getState()).toBe("ON_ROUTE");
  });

  it("een afwijking die na de cooldown wordt bevestigd, doorloopt weer het volledige confirm-venster", () => {
    const m = rerouted(0);
    const t = OPTIONS.rerouteCooldownMs; // cooldown net verstreken
    m.reportDeviation(t);
    expect(m.getState()).toBe("POSSIBLE_DEVIATION");
    m.reportDeviation(t + OPTIONS.deviationConfirmDurationMs - 1);
    expect(m.getState()).toBe("POSSIBLE_DEVIATION"); // nog niet bevestigd
    m.reportDeviation(t + OPTIONS.deviationConfirmDurationMs);
    expect(m.getState()).toBe("OFF_ROUTE");
  });
});

describe("NavigationStateMachine — GPS_LOST (ontwerp sectie 12/14)", () => {
  it("reportGpsLost vanuit ON_ROUTE/POSSIBLE_DEVIATION/OFF_ROUTE/REROUTING/REROUTED gaat naar GPS_LOST", () => {
    const m1 = started();
    m1.reportGpsLost();
    expect(m1.getState()).toBe("GPS_LOST");

    const m2 = started();
    m2.reportDeviation(0);
    m2.reportGpsLost();
    expect(m2.getState()).toBe("GPS_LOST");
  });

  it("reportGpsLost vanuit NOT_STARTED, PAUSED, ARRIVED, CANCELLED of PERMISSION_DENIED gooit een fout", () => {
    const notStarted = new NavigationStateMachine(OPTIONS);
    expect(() => notStarted.reportGpsLost()).toThrow(InvalidNavigationTransitionError);

    const paused = started();
    paused.pause();
    expect(() => paused.reportGpsLost()).toThrow(InvalidNavigationTransitionError);

    const arrived = started();
    arrived.arrive();
    expect(() => arrived.reportGpsLost()).toThrow(InvalidNavigationTransitionError);
  });

  it("reportOnRoute vanuit GPS_LOST herstelt naar ON_ROUTE (nieuwe sample -> passende state, ontwerp sectie 14)", () => {
    const m = started();
    m.reportGpsLost();
    m.reportOnRoute(1000);
    expect(m.getState()).toBe("ON_ROUTE");
  });

  it("reportDeviation vanuit GPS_LOST start een verse POSSIBLE_DEVIATION-periode", () => {
    const m = started();
    m.reportGpsLost();
    m.reportDeviation(1000);
    expect(m.getState()).toBe("POSSIBLE_DEVIATION");
    expect(m.getPossibleDeviationSince()).toBe(1000);
  });

  it("GPS_LOST wist een eventueel lopende afwijkingsperiode (ontwerp: geen afwijkingsdetectie tijdens GPS_LOST)", () => {
    const m = started();
    m.reportDeviation(0);
    expect(m.getPossibleDeviationSince()).toBe(0);
    m.reportGpsLost();
    expect(m.getPossibleDeviationSince()).toBeNull();
  });
});

describe("NavigationStateMachine — PAUSED / hervatten", () => {
  it("pause() vanuit elke actieve state gaat naar PAUSED", () => {
    const m1 = started();
    m1.pause();
    expect(m1.getState()).toBe("PAUSED");

    const m2 = started();
    m2.reportDeviation(0);
    m2.pause();
    expect(m2.getState()).toBe("PAUSED");
  });

  it("pause() vanuit NOT_STARTED, ARRIVED, CANCELLED of PERMISSION_DENIED gooit een fout", () => {
    const notStarted = new NavigationStateMachine(OPTIONS);
    expect(() => notStarted.pause()).toThrow(InvalidNavigationTransitionError);

    const arrived = started();
    arrived.arrive();
    expect(() => arrived.pause()).toThrow(InvalidNavigationTransitionError);
  });

  it("resume() vanuit PAUSED gaat naar ON_ROUTE", () => {
    const m = started();
    m.pause();
    m.resume();
    expect(m.getState()).toBe("ON_ROUTE");
  });

  it("resume() vanuit een andere state dan PAUSED gooit een fout", () => {
    const m = started();
    expect(() => m.resume()).toThrow(InvalidNavigationTransitionError);
  });
});

describe("NavigationStateMachine — ARRIVED / CANCELLED (eindstadia)", () => {
  it("arrive() vanuit ON_ROUTE gaat naar ARRIVED", () => {
    const m = started();
    m.arrive();
    expect(m.getState()).toBe("ARRIVED");
  });

  it("arrive() vanuit een andere state dan ON_ROUTE gooit een fout", () => {
    const m = started();
    m.reportDeviation(0);
    expect(() => m.arrive()).toThrow(InvalidNavigationTransitionError);
  });

  it("cancel() is geldig vanuit vrijwel elke actieve state", () => {
    const m1 = new NavigationStateMachine(OPTIONS);
    m1.cancel();
    expect(m1.getState()).toBe("CANCELLED");

    const m2 = started();
    m2.reportDeviation(0);
    m2.cancel();
    expect(m2.getState()).toBe("CANCELLED");

    const m3 = new NavigationStateMachine(OPTIONS);
    m3.denyPermission();
    m3.cancel();
    expect(m3.getState()).toBe("CANCELLED");
  });

  it("ARRIVED en CANCELLED zijn eindstadia: geen enkel signaal is daarna nog geldig", () => {
    const arrived = started();
    arrived.arrive();
    expect(() => arrived.reportOnRoute(0)).toThrow(InvalidNavigationTransitionError);
    expect(() => arrived.pause()).toThrow(InvalidNavigationTransitionError);
    expect(() => arrived.cancel()).toThrow(InvalidNavigationTransitionError);

    const cancelled = started();
    cancelled.cancel();
    expect(() => cancelled.reportDeviation(0)).toThrow(InvalidNavigationTransitionError);
    expect(() => cancelled.cancel()).toThrow(InvalidNavigationTransitionError);
  });
});

describe("NavigationStateMachine — volledige happy path (ontwerp sectie 14, diagram end-to-end)", () => {
  it("NOT_STARTED → ON_ROUTE → POSSIBLE_DEVIATION → OFF_ROUTE → REROUTING → REROUTED → ON_ROUTE → ARRIVED", () => {
    const m = new NavigationStateMachine(OPTIONS);
    expect(m.getState()).toBe("NOT_STARTED");

    m.start();
    expect(m.getState()).toBe("ON_ROUTE");

    m.reportDeviation(0);
    expect(m.getState()).toBe("POSSIBLE_DEVIATION");

    m.reportDeviation(OPTIONS.deviationConfirmDurationMs);
    expect(m.getState()).toBe("OFF_ROUTE");

    m.startReroute();
    expect(m.getState()).toBe("REROUTING");

    m.completeReroute(OPTIONS.deviationConfirmDurationMs + 100);
    expect(m.getState()).toBe("REROUTED");

    m.reportOnRoute(OPTIONS.deviationConfirmDurationMs + 200);
    expect(m.getState()).toBe("ON_ROUTE");

    m.arrive();
    expect(m.getState()).toBe("ARRIVED");
  });
});
