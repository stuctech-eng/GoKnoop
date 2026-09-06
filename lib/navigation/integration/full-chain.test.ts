import { describe, it, expect } from "vitest";
import { NavigationStateMachine } from "../session/navigation-state-machine";
import { ManualNavigationClock } from "../clock/navigation-clock";
import { DeviationDetector } from "../deviation/deviation-detector";
import type { DeviationDetectorOptions } from "../deviation/deviation-detector";
import { NavigationSessionController } from "../lifecycle/navigation-session-controller";
import { buildRouteProgressModel, calculateProgress } from "../progress/route-progress-model";
import { ProgressTracker } from "../progress/progress-tracker";
import { RerouteContextTracker } from "../reroute/reroute-context-tracker";
import { RerouteExecutor } from "../reroute/reroute-executor";
import { performReroute } from "../reroute/perform-reroute";
import type { RouteEngineClient, RouteEngineRequest } from "../reroute/route-engine-client";
import { rdToWgs84 } from "../../route-engine/coordinate-transform";
import type { GraphEdge, Point, Route } from "../../route-engine/types";
import type { GpsSample } from "../types";

/**
 * Integratietests (ontwerp sectie 20, implementatiestap 10) -- de volledige
 * keten getest als geheel, niet meer per geïsoleerde module:
 *
 *   GPS → GpsFixEvaluator → candidate matching → progress →
 *   deviation detection → NavigationSessionController → reroute-context →
 *   Route Engine (gesimuleerd) → nieuwe route → hervatte matching
 *
 * Nog steeds GEEN echte iPhone-GPS, GEEN UI (ontwerp sectie 23, stap 11/12
 * volgen pas hierna). De simulator blijft de bron van waarheid voor
 * deterministisch testen.
 *
 * BELANGRIJKE NUANCE (expliciet, niet stilzwijgend): de "kalibratie"-sectie
 * onderaan dit bestand test meerdere waarden per constante om te bepalen
 * WELKE range stabiel gedrag oplevert. Dat is geen productie-vaststelling --
 * één simulatiesessie bewijst geen definitieve waarde. De uitkomst is een
 * geldig-gebleken RANGE, niet een besluit.
 */

const DATASET_VERSION = "uINZ3y2QsgBdEyky3duq";

function sampleAt(point: Point, overrides: Partial<GpsSample> = {}): GpsSample {
  const wgs84 = rdToWgs84(point.x, point.y);
  return { lat: wgs84.lat, lon: wgs84.lon, accuracyM: 5, headingDeg: null, speedMps: null, timestamp: 0, ...overrides };
}

function edge(overrides: Partial<GraphEdge> & Pick<GraphEdge, "id" | "distanceM" | "geometry">): GraphEdge {
  return { fromLogicalNodeId: "?", toLogicalNodeId: "?", directionality: "unknown", ...overrides };
}

function routeFromEdges(id: string, edges: GraphEdge[], overrides: Partial<Route> = {}): Route {
  const nodeSequence = ["n1", ...edges.map((e) => e.toLogicalNodeId)];
  const model = buildRouteProgressModel(edges, nodeSequence);
  return {
    id,
    datasetVersionId: DATASET_VERSION,
    source: "route-engine-v1",
    network: "fiets",
    mode: "bicycle",
    nodes: nodeSequence,
    edges: edges.map((e) => e.id),
    geometry: model.geometry as Point[],
    distanceM: model.totalDistanceM,
    elevation: null,
    durationEstimate: null,
    preferences: {},
    constraints: {},
    waypoints: [],
    alternatives: [],
    navigation: null,
    metadata: { algorithm: "dijkstra", computedAt: "2026-08-29T00:00:00.000Z", computeTimeMs: 4, edgesConsidered: edges.length },
    ...overrides,
  };
}

// Oorspronkelijke route: rechtdoor naar het noorden, 1000m, 2 edges.
const ORIGINAL_EDGES: GraphEdge[] = [
  edge({ id: "e1", fromLogicalNodeId: "n1", toLogicalNodeId: "n2", distanceM: 500, geometry: [{ x: 0, y: 0 }, { x: 0, y: 500 }] }),
  edge({ id: "e2", fromLogicalNodeId: "n2", toLogicalNodeId: "n3", distanceM: 500, geometry: [{ x: 0, y: 500 }, { x: 0, y: 1000 }] }),
];

const DEFAULT_DETECTOR_OPTIONS: Omit<DeviationDetectorOptions, "matchOptions"> = {
  deviationThresholdM: 20,
  accuracyThresholdM: 20,
  gpsTimeoutMs: 10_000,
};
const DEFAULT_MATCH_OPTIONS = { baseWindowM: 100, windowMarginPerMps: 10, weights: { distance: 1, heading: 0.1, continuity: 0.5 } };
const CONFIRM_MS = 5000;
const COOLDOWN_MS = 10_000;

/** Bouwt een volledige, geïntegreerde navigatiesessie -- de keten uit sectie 20, samengesteld uit alle stap 1-9-bouwstenen. */
function buildSession(edges: GraphEdge[], detectorOptions: Partial<Omit<DeviationDetectorOptions, "matchOptions">> = {}) {
  const clock = new ManualNavigationClock(0);
  const stateMachine = new NavigationStateMachine({ deviationConfirmDurationMs: CONFIRM_MS, rerouteCooldownMs: COOLDOWN_MS });
  let progressModel = buildRouteProgressModel(edges, ["n1", ...edges.map((e) => e.toLogicalNodeId)]);
  let detector = new DeviationDetector(progressModel.geometry, stateMachine, clock, {
    ...DEFAULT_DETECTOR_OPTIONS,
    ...detectorOptions,
    matchOptions: DEFAULT_MATCH_OPTIONS,
  });
  const controller = new NavigationSessionController(detector, stateMachine);
  const rerouteTracker = new RerouteContextTracker();
  const progressTracker = new ProgressTracker(3); // 3m ruistolerantie

  function process(point: Point, overrides: Partial<GpsSample> = {}) {
    const outcome = controller.processGpsSample(sampleAt(point, overrides));
    if (outcome.action === "reported_on_route" || outcome.action === "reported_deviation") {
      const progress = calculateProgress(progressModel, outcome.matchedPosition);
      const reported = progressTracker.update(progress.distanceAlongRouteM, progressModel.totalDistanceM);
      rerouteTracker.recordPosition(progress.currentEdgeId, progress.distanceAlongRouteM);
      if (stateMachine.getState() === "ON_ROUTE") rerouteTracker.clear();
      return { outcome, progress, reported };
    }
    return { outcome, progress: null, reported: null };
  }

  /** Vervangt de actieve route na een succesvolle reroute -- NIEUWE matching-geometrie, ZELFDE state machine/klok. */
  function switchToRoute(newEdges: GraphEdge[]) {
    progressModel = buildRouteProgressModel(newEdges, ["n1", ...newEdges.map((e) => e.toLogicalNodeId)]);
    detector = new DeviationDetector(progressModel.geometry, stateMachine, clock, {
      ...DEFAULT_DETECTOR_OPTIONS,
      ...detectorOptions,
      matchOptions: DEFAULT_MATCH_OPTIONS,
    });
    // NavigationSessionController wikkelt om `detector` via zijn constructor-referentie;
    // een nieuwe controller-instantie hergebruikt dezelfde stateMachine (sessie blijft doorlopen).
    return new NavigationSessionController(detector, stateMachine);
  }

  return { clock, stateMachine, controller, rerouteTracker, progressTracker, process, switchToRoute, get progressModel() { return progressModel; } };
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Normale route
// ─────────────────────────────────────────────────────────────────────────
describe("Integratie 1 — normale route: GPS → match → progress → ON_ROUTE", () => {
  it("blijft ON_ROUTE en progress loopt monotoon op tot 100%", () => {
    const s = buildSession(ORIGINAL_EDGES);
    s.stateMachine.start();

    const points: Point[] = [{ x: 0, y: 0 }, { x: 0, y: 250 }, { x: 0, y: 500 }, { x: 0, y: 750 }, { x: 0, y: 1000 }];
    let lastProgress = -1;
    for (const p of points) {
      const { outcome, reported } = s.process(p);
      expect(outcome.action).toBe("reported_on_route");
      expect(s.stateMachine.getState()).toBe("ON_ROUTE");
      expect(reported!.progressRatio).toBeGreaterThanOrEqual(lastProgress);
      lastProgress = reported!.progressRatio;
    }
    expect(lastProgress).toBeCloseTo(1, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. GPS-ruis
// ─────────────────────────────────────────────────────────────────────────
describe("Integratie 2 — GPS-ruis: tijdelijk slechte positie → geen OFF_ROUTE", () => {
  it("kleine, kortstondige laterale ruis rond de route leidt niet tot OFF_ROUTE", () => {
    const s = buildSession(ORIGINAL_EDGES);
    s.stateMachine.start();

    const noisyOffsets = [3, -4, 2, -2, 5, -3, 1]; // meter, ruim onder de drempel van 20m
    let y = 100;
    for (const offset of noisyOffsets) {
      s.clock.advance(1000);
      s.process({ x: offset, y });
      y += 100;
      expect(s.stateMachine.getState()).toBe("ON_ROUTE"); // nooit zelfs maar POSSIBLE_DEVIATION
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Echte afwijking
// ─────────────────────────────────────────────────────────────────────────
describe("Integratie 3 — echte afwijking: POSSIBLE_DEVIATION → OFF_ROUTE", () => {
  it("een aanhoudende afwijking doorloopt het bevestigingsvenster en bereikt OFF_ROUTE", () => {
    const s = buildSession(ORIGINAL_EDGES);
    s.stateMachine.start();
    s.process({ x: 0, y: 200 }); // op de route, vestigt continuïteit

    s.process({ x: 60, y: 260 }); // afwijking begint
    expect(s.stateMachine.getState()).toBe("POSSIBLE_DEVIATION");

    s.clock.advance(CONFIRM_MS);
    s.process({ x: 60, y: 260 });
    expect(s.stateMachine.getState()).toBe("OFF_ROUTE");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Reroute
// ─────────────────────────────────────────────────────────────────────────
function detourRoute(): GraphEdge[] {
  return [
    edge({ id: "e1b", fromLogicalNodeId: "n1", toLogicalNodeId: "n2b", distanceM: 500.4, geometry: [{ x: 0, y: 0 }, { x: 20, y: 500 }] }),
    edge({ id: "e2b", fromLogicalNodeId: "n2b", toLogicalNodeId: "n2c", distanceM: 335.4, geometry: [{ x: 20, y: 500 }, { x: 5, y: 800 }] }),
    edge({ id: "e3b", fromLogicalNodeId: "n2c", toLogicalNodeId: "n3", distanceM: 206.2, geometry: [{ x: 5, y: 800 }, { x: 0, y: 1000 }] }),
  ];
}

/** Route Engine-double die pingpong via e1 zou "aanbieden" tenzij e1 expliciet vermeden wordt. */
class ScenarioRouteEngineClient implements RouteEngineClient {
  public lastRequest: RouteEngineRequest | null = null;
  async computeRoute(request: RouteEngineRequest) {
    this.lastRequest = request;
    const avoided = new Set(request.constraints?.avoidEdgeIds ?? []);
    if (avoided.has("e1")) {
      return routeFromEdges("route-detour", detourRoute());
    }
    // "Optimale" route zou hier gewoon terug over e1 gaan -- exact het pingpong-risico (ontwerp sectie 10).
    return routeFromEdges("route-pingpong", ORIGINAL_EDGES);
  }
}

describe("Integratie 4 — reroute: OFF_ROUTE → temporaryAvoidEdgeIds → Route Engine → nieuwe Route", () => {
  it("levert een nieuwe Route op en de sessie hervat matching daartegen", async () => {
    const s = buildSession(ORIGINAL_EDGES);
    s.stateMachine.start();
    s.process({ x: 0, y: 200 });
    s.process({ x: 60, y: 260 });
    s.clock.advance(CONFIRM_MS);
    s.process({ x: 60, y: 260 });
    expect(s.stateMachine.getState()).toBe("OFF_ROUTE");

    const originalRoute = routeFromEdges("route-original", ORIGINAL_EDGES);
    const avoidIds = s.rerouteTracker.getTemporaryAvoidEdgeIds(200, 300); // rond de laatst bekende afstand (200m op e1)
    expect(avoidIds).toContain("e1");

    const client = new ScenarioRouteEngineClient();
    const executor = new RerouteExecutor(client);
    const result = await performReroute({
      stateMachine: s.stateMachine,
      clock: s.clock,
      executor,
      request: { originalRoute, fromLogicalNodeId: "n1", temporaryAvoidEdgeIds: avoidIds },
    });

    expect(result.outcome).toBe("success");
    expect(s.stateMachine.getState()).toBe("REROUTED");
    if (result.outcome === "success") {
      expect(result.newRoute.id).not.toBe(originalRoute.id);

      const controller2 = s.switchToRoute(detourRoute());
      const onNewRoute = controller2.processGpsSample(sampleAt({ x: 15, y: 400 }));
      expect(onNewRoute.action).toBe("reported_on_route"); // matching hervat correct tegen de nieuwe geometrie
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Pingpong-kruising
// ─────────────────────────────────────────────────────────────────────────
describe("Integratie 5 — pingpong-kruising: temporaryAvoidEdgeIds voorkomt onmiddellijk terugsturen over e1", () => {
  it("de Route Engine-aanvraag bevat de recent bereden edge, en de teruggegeven route vermijdt die daadwerkelijk", async () => {
    const s = buildSession(ORIGINAL_EDGES);
    s.stateMachine.start();
    s.process({ x: 0, y: 200 }); // recent bereden: e1
    s.process({ x: 60, y: 260 });
    s.clock.advance(CONFIRM_MS);
    s.process({ x: 60, y: 260 });
    expect(s.stateMachine.getState()).toBe("OFF_ROUTE");

    const avoidIds = s.rerouteTracker.getTemporaryAvoidEdgeIds(200, 300);
    const client = new ScenarioRouteEngineClient();
    const executor = new RerouteExecutor(client);
    const result = await performReroute({
      stateMachine: s.stateMachine,
      clock: s.clock,
      executor,
      request: { originalRoute: routeFromEdges("route-original", ORIGINAL_EDGES), fromLogicalNodeId: "n1", temporaryAvoidEdgeIds: avoidIds },
    });

    // Kernvereiste: de aanvraag aan de Route Engine bevatte e1 als te vermijden edge...
    expect(client.lastRequest?.constraints?.avoidEdgeIds).toContain("e1");
    // ...en het resultaat is dus de detour-route, NIET de pingpong-route die zo terug over e1 zou gaan.
    expect(result.outcome).toBe("success");
    expect(result.outcome === "success" && result.newRoute.id).toBe("route-detour");
    expect(result.outcome === "success" && result.newRoute.edges).not.toContain("e1");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Legitieme U-bocht (RECENT_ROUTE_MEMORY vervalt bij bevestigd ON_ROUTE)
// ─────────────────────────────────────────────────────────────────────────
describe("Integratie 6 — legitieme U-bocht: RECENT_ROUTE_MEMORY blokkeert een edge niet blijvend", () => {
  it("na een bevestigde terugkeer naar ON_ROUTE (tracker.clear()) is een oude edge weer beschikbaar bij een latere reroute", async () => {
    const s = buildSession(ORIGINAL_EDGES);
    s.stateMachine.start();
    s.process({ x: 0, y: 200 }); // e1 recent bereden

    // Vals alarm: afwijking begint, maar gebruiker komt meteen terug -- GEEN OFF_ROUTE, WEL een bevestigde ON_ROUTE-terugkeer.
    s.process({ x: 60, y: 260 });
    expect(s.stateMachine.getState()).toBe("POSSIBLE_DEVIATION");
    s.process({ x: 0, y: 270 }); // terug op de route
    expect(s.stateMachine.getState()).toBe("ON_ROUTE");
    expect(s.rerouteTracker.getTemporaryAvoidEdgeIds(270, 300)).toEqual([]); // gewist bij bevestigd ON_ROUTE

    // Veel later ontstaat een NIEUWE, onafhankelijke afwijking (edge e1 is allang niet meer "recent").
    s.process({ x: 0, y: 900 }); // ver op e2
    s.process({ x: 60, y: 960 });
    s.clock.advance(CONFIRM_MS);
    s.process({ x: 60, y: 960 });
    expect(s.stateMachine.getState()).toBe("OFF_ROUTE");

    const avoidIds = s.rerouteTracker.getTemporaryAvoidEdgeIds(960, 300);
    // e1 ligt (960 - 300 = 660m cutoff) ruim buiten het geheugenvenster -- niet langer vermeden.
    expect(avoidIds).not.toContain("e1");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Permission denial, inclusief intrekken tijdens een actieve sessie
// ─────────────────────────────────────────────────────────────────────────
describe("Integratie 7 — permission denial", () => {
  it("weigering vooraf: sessie kan nooit ON_ROUTE bereiken", () => {
    const s = buildSession(ORIGINAL_EDGES);
    s.controller.denyPermission();
    expect(s.stateMachine.getState()).toBe("PERMISSION_DENIED");
  });

  it("intrekken tijdens een actieve, afwijkende sessie gaat rechtstreeks naar PERMISSION_DENIED, niet via GPS_LOST", () => {
    const s = buildSession(ORIGINAL_EDGES);
    s.stateMachine.start();
    s.process({ x: 0, y: 200 });
    s.process({ x: 60, y: 260 });
    expect(s.stateMachine.getState()).toBe("POSSIBLE_DEVIATION");

    s.controller.denyPermission();
    expect(s.stateMachine.getState()).toBe("PERMISSION_DENIED");

    s.controller.grantPermission();
    expect(s.stateMachine.getState()).toBe("NOT_STARTED"); // vers, geen hervatting van de oude afwijkingsstate
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8. GPS_LOST → herstel
// ─────────────────────────────────────────────────────────────────────────
describe("Integratie 8 — GPS_LOST → herstel, progress blijft consistent", () => {
  it("na signaalherstel is de voortgang nog steeds correct (geen sprong terug door de onderbreking)", () => {
    const s = buildSession(ORIGINAL_EDGES);
    s.stateMachine.start();
    const before = s.process({ x: 0, y: 400 });
    expect(before.outcome.action).toBe("reported_on_route");

    s.clock.advance(DEFAULT_DETECTOR_OPTIONS.gpsTimeoutMs + 1);
    s.controller.checkGpsHealth();
    expect(s.stateMachine.getState()).toBe("GPS_LOST");

    const after = s.process({ x: 0, y: 600 }); // fietser reed door tijdens de onderbreking
    expect(after.outcome.action).toBe("reported_on_route");
    expect(s.stateMachine.getState()).toBe("ON_ROUTE");
    expect(after.reported!.distanceAlongRouteM).toBeGreaterThan(before.reported!.distanceAlongRouteM);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 9. Arrival
// ─────────────────────────────────────────────────────────────────────────
describe("Integratie 9 — arrival", () => {
  it("bereikt ARRIVED zodra de resterende afstand de aankomstdrempel bereikt", () => {
    const s = buildSession(ORIGINAL_EDGES);
    s.stateMachine.start();
    const { reported } = s.process({ x: 0, y: 998 });
    const arrived = s.controller.checkArrival(reported!.remainingDistanceM, 5);
    expect(arrived).toBe(true);
    expect(s.stateMachine.getState()).toBe("ARRIVED");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 10. Dataset-version mismatch
// ─────────────────────────────────────────────────────────────────────────
describe("Integratie 10 — dataset-version mismatch tijdens reroute", () => {
  it("een reroute-resultaat met een afwijkende datasetVersionId eindigt in OFF_ROUTE, niet in REROUTED", async () => {
    const s = buildSession(ORIGINAL_EDGES);
    s.stateMachine.start();
    s.process({ x: 0, y: 200 });
    s.process({ x: 60, y: 260 });
    s.clock.advance(CONFIRM_MS);
    s.process({ x: 60, y: 260 });
    expect(s.stateMachine.getState()).toBe("OFF_ROUTE");

    const originalRoute = routeFromEdges("route-original", ORIGINAL_EDGES, { datasetVersionId: "v17" });
    const driftedClient: RouteEngineClient = {
      async computeRoute() {
        return routeFromEdges("route-drifted", detourRoute(), { datasetVersionId: "v18" });
      },
    };
    const result = await performReroute({
      stateMachine: s.stateMachine,
      clock: s.clock,
      executor: new RerouteExecutor(driftedClient),
      request: { originalRoute, fromLogicalNodeId: "n1", temporaryAvoidEdgeIds: [] },
    });

    expect(result.outcome).toBe("failed");
    expect(result.outcome === "failed" && result.reason).toBe("dataset_version_mismatch");
    expect(s.stateMachine.getState()).toBe("OFF_ROUTE");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Kalibratie-verkenning (GEEN productiewaarden -- alleen welke range stabiel is)
// ─────────────────────────────────────────────────────────────────────────
describe("Kalibratie-verkenning — welke waarden zijn stabiel genoeg voor MVP, niet welke waarde 'definitief' is", () => {
  it("deviationThresholdM: ruis van ±5m blijft ON_ROUTE voor een reeks kandidaat-drempels", () => {
    const candidateThresholds = [10, 15, 20, 25, 30];
    const stable: number[] = [];
    for (const threshold of candidateThresholds) {
      const s = buildSession(ORIGINAL_EDGES, { deviationThresholdM: threshold });
      s.stateMachine.start();
      let ok = true;
      for (const offset of [4, -5, 3, -4, 5]) {
        s.process({ x: offset, y: 300 });
        if (s.stateMachine.getState() !== "ON_ROUTE") ok = false;
      }
      if (ok) stable.push(threshold);
    }
    // Verwacht: alles vanaf ~10m is stabiel tegen ±5m ruis -- een RANGE, geen enkele "juiste" waarde.
    expect(stable).toEqual(candidateThresholds.filter((t) => t >= 10));
  });

  it("deviationConfirmDurationMs: een korte, voorbijgaande afwijking (korter dan het venster) leidt nooit tot OFF_ROUTE, voor een reeks kandidaat-duren", () => {
    const candidateDurations = [2000, 5000, 8000];
    for (const duration of candidateDurations) {
      const s = buildSession(ORIGINAL_EDGES);
      const sm = new NavigationStateMachine({ deviationConfirmDurationMs: duration, rerouteCooldownMs: COOLDOWN_MS });
      sm.start();
      sm.reportDeviation(0);
      sm.reportDeviation(duration - 1); // net vóór de drempel
      expect(sm.getState()).toBe("POSSIBLE_DEVIATION"); // geldt voor ELKE kandidaat-duur, per constructie
    }
  });

  it("RECENT_ROUTE_MEMORY: een kleiner venster laat een oudere edge sneller vrij, een groter venster blokkeert langer -- beide zijn intern consistent, geen van beide is 'fout'", () => {
    const tracker = new RerouteContextTracker();
    tracker.recordPosition("e1", 0);
    tracker.recordPosition("e2", 500);

    const narrow = tracker.getTemporaryAvoidEdgeIds(1000, 200); // cutoff 800 -> geen van beide
    const wide = tracker.getTemporaryAvoidEdgeIds(1000, 700); // cutoff 300 -> e2 wel, e1 niet
    const veryWide = tracker.getTemporaryAvoidEdgeIds(1000, 1200); // cutoff -200 -> beide

    expect(narrow).toEqual([]);
    expect(wide).toEqual(["e2"]);
    expect(veryWide).toEqual(["e1", "e2"]);
    // Conclusie voor kalibratie (stap 20/21): de keuze bepaalt een afweging tussen
    // pingpong-preventie (groter venster) en legitieme-U-bocht-vrijheid (kleiner venster) --
    // geen van deze drie waarden is hier al aangewezen als "de juiste".
  });

  it("rerouteCooldownMs: een reeks kandidaat-cooldowns onderdrukt allemaal een afwijking binnen het venster, en laat allemaal los erna", () => {
    const candidateCooldowns = [5000, 10000, 15000];
    for (const cooldown of candidateCooldowns) {
      const sm = new NavigationStateMachine({ deviationConfirmDurationMs: CONFIRM_MS, rerouteCooldownMs: cooldown });
      sm.start();
      sm.reportDeviation(0);
      sm.reportDeviation(CONFIRM_MS);
      sm.startReroute();
      sm.completeReroute(CONFIRM_MS + 100);

      sm.reportDeviation(CONFIRM_MS + 100 + cooldown - 1); // binnen cooldown
      expect(sm.getState()).toBe("REROUTED"); // genegeerd, voor elke kandidaat-waarde

      sm.reportDeviation(CONFIRM_MS + 100 + cooldown); // net erna
      expect(sm.getState()).toBe("POSSIBLE_DEVIATION"); // hervat, voor elke kandidaat-waarde
    }
  });
});
