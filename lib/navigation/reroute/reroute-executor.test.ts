import { describe, it, expect } from "vitest";
import { RerouteExecutor } from "./reroute-executor";
import { performReroute } from "./perform-reroute";
import { NavigationStateMachine } from "../session/navigation-state-machine";
import { ManualNavigationClock } from "../clock/navigation-clock";
import type { RouteEngineClient, RouteEngineRequest } from "./route-engine-client";
import type { Route } from "../../route-engine/types";

function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    id: "route-original",
    datasetVersionId: "uINZ3y2QsgBdEyky3duq",
    source: "route-engine-v1",
    network: "fiets",
    mode: "bicycle",
    nodes: ["n1", "n2", "n3"],
    edges: ["e1", "e2"],
    geometry: [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 0, y: 200 }],
    distanceM: 200,
    elevation: null,
    durationEstimate: null,
    preferences: {},
    constraints: {},
    waypoints: [],
    alternatives: [],
    navigation: null,
    metadata: { algorithm: "dijkstra", computedAt: "2026-08-29T00:00:00.000Z", computeTimeMs: 5, edgesConsidered: 10 },
    ...overrides,
  };
}

/** Test-double: representeert de bestaande POST /api/route zonder echte HTTP/GraphProvider. */
class FakeRouteEngineClient implements RouteEngineClient {
  public lastRequest: RouteEngineRequest | null = null;
  constructor(
    private readonly behavior:
      | { type: "success"; route: Route }
      | { type: "failure"; reason: "all_paths_blocked_by_constraints" | "disconnected" | "no_traversable_edges"; message: string }
      | { type: "throw"; error: Error }
  ) {}

  async computeRoute(request: RouteEngineRequest) {
    this.lastRequest = request;
    if (this.behavior.type === "throw") throw this.behavior.error;
    if (this.behavior.type === "failure") return { reason: this.behavior.reason, message: this.behavior.message };
    return this.behavior.route;
  }
}

describe("RerouteExecutor — kern-testcase: oorspronkelijke route ongewijzigd, nieuwe route apart, dataset-versie gelijk", () => {
  it("oldRoute.id !== newRoute.id, oldRoute blijft ongewijzigd, datasetVersionId blijft gelijk", async () => {
    const originalRoute = makeRoute({ id: "route-original", datasetVersionId: "uINZ3y2QsgBdEyky3duq" });
    const originalRouteSnapshot = JSON.parse(JSON.stringify(originalRoute)); // diepe kopie vóór uitvoering

    const newRoute = makeRoute({ id: "route-rerouted", datasetVersionId: "uINZ3y2QsgBdEyky3duq" });
    const client = new FakeRouteEngineClient({ type: "success", route: newRoute });
    const executor = new RerouteExecutor(client);

    const result = await executor.execute({ originalRoute, fromLogicalNodeId: "n2", temporaryAvoidEdgeIds: ["e1"] });

    expect(result.outcome).toBe("success");
    expect(result.outcome === "success" && result.newRoute.id).toBe("route-rerouted");
    expect(originalRoute.id).not.toBe(result.outcome === "success" ? result.newRoute.id : "");
    expect(result.outcome === "success" && result.newRoute.datasetVersionId).toBe(originalRoute.datasetVersionId);

    // oldRoute is volledig ongewijzigd (diepe vergelijking met de kopie van vóór de aanroep).
    expect(originalRoute).toEqual(originalRouteSnapshot);
  });
});

describe("RerouteExecutor — constraint-vertaling (exact Phase 2-semantiek)", () => {
  it("vertaalt temporaryAvoidEdgeIds naar constraints.avoidEdgeIds in het bestaande request-contract", async () => {
    const originalRoute = makeRoute({ constraints: {} });
    const client = new FakeRouteEngineClient({ type: "success", route: makeRoute({ id: "new" }) });
    const executor = new RerouteExecutor(client);

    await executor.execute({ originalRoute, fromLogicalNodeId: "n2", temporaryAvoidEdgeIds: ["e1", "e2"] });

    expect(client.lastRequest).toEqual({
      fromLogicalNodeId: "n2",
      toLogicalNodeId: "n3", // laatste node van originalRoute.nodes
      constraints: { avoidNodeIds: undefined, avoidEdgeIds: ["e1", "e2"] },
    });
  });

  it("behoudt avoidNodeIds ongewijzigd van de oorspronkelijke route (stap 8 introduceert geen node-constraints)", async () => {
    const originalRoute = makeRoute({ constraints: { avoidNodeIds: ["blocked-node"] } });
    const client = new FakeRouteEngineClient({ type: "success", route: makeRoute({ id: "new" }) });
    const executor = new RerouteExecutor(client);

    await executor.execute({ originalRoute, fromLogicalNodeId: "n2", temporaryAvoidEdgeIds: [] });

    expect(client.lastRequest?.constraints?.avoidNodeIds).toEqual(["blocked-node"]);
  });

  it("voegt temporaryAvoidEdgeIds samen met reeds bestaande avoidEdgeIds op de oorspronkelijke route, zonder duplicaten", async () => {
    const originalRoute = makeRoute({ constraints: { avoidEdgeIds: ["e1", "e5"] } });
    const client = new FakeRouteEngineClient({ type: "success", route: makeRoute({ id: "new" }) });
    const executor = new RerouteExecutor(client);

    await executor.execute({ originalRoute, fromLogicalNodeId: "n2", temporaryAvoidEdgeIds: ["e1", "e2"] });

    expect(client.lastRequest?.constraints?.avoidEdgeIds).toEqual(["e1", "e5", "e2"]);
  });

  it("gebruikt de laatste node van originalRoute.nodes als toLogicalNodeId (oorspronkelijke bestemming blijft het doel)", async () => {
    const originalRoute = makeRoute({ nodes: ["a", "b", "c", "d"] });
    const client = new FakeRouteEngineClient({ type: "success", route: makeRoute({ id: "new" }) });
    const executor = new RerouteExecutor(client);

    await executor.execute({ originalRoute, fromLogicalNodeId: "b", temporaryAvoidEdgeIds: [] });
    expect(client.lastRequest?.toLogicalNodeId).toBe("d");
  });
});

describe("RerouteExecutor — dataset-versie-pinning (ontwerp sectie 19)", () => {
  it("weigert een reroute-resultaat met een afwijkende datasetVersionId, ondanks dat de client 'succes' meldt", async () => {
    const originalRoute = makeRoute({ datasetVersionId: "v17" });
    const driftedRoute = makeRoute({ id: "route-drifted", datasetVersionId: "v18" });
    const client = new FakeRouteEngineClient({ type: "success", route: driftedRoute });
    const executor = new RerouteExecutor(client);

    const result = await executor.execute({ originalRoute, fromLogicalNodeId: "n2", temporaryAvoidEdgeIds: [] });

    expect(result.outcome).toBe("failed");
    expect(result.outcome === "failed" && result.reason).toBe("dataset_version_mismatch");
  });
});

describe("RerouteExecutor — foutafhandeling (ontwerp sectie 19)", () => {
  it("een 422-achtige fout (bijv. all_paths_blocked_by_constraints) resulteert in outcome 'failed' met de machineleesbare reason", async () => {
    const client = new FakeRouteEngineClient({
      type: "failure",
      reason: "all_paths_blocked_by_constraints",
      message: "Geen route mogelijk binnen de opgegeven constraints.",
    });
    const executor = new RerouteExecutor(client);

    const result = await executor.execute({ originalRoute: makeRoute(), fromLogicalNodeId: "n2", temporaryAvoidEdgeIds: ["e1"] });

    expect(result.outcome).toBe("failed");
    expect(result.outcome === "failed" && result.reason).toBe("all_paths_blocked_by_constraints");
  });

  it("een netwerkfout (exception) resulteert in outcome 'failed' met reason network_error, geen crash", async () => {
    const client = new FakeRouteEngineClient({ type: "throw", error: new Error("fetch failed") });
    const executor = new RerouteExecutor(client);

    const result = await executor.execute({ originalRoute: makeRoute(), fromLogicalNodeId: "n2", temporaryAvoidEdgeIds: [] });

    expect(result.outcome).toBe("failed");
    expect(result.outcome === "failed" && result.reason).toBe("network_error");
  });
});

describe("performReroute — koppeling aan de NavigationStateMachine (stap 2)", () => {
  function offRouteMachine() {
    const clock = new ManualNavigationClock(0);
    const stateMachine = new NavigationStateMachine({ deviationConfirmDurationMs: 5000, rerouteCooldownMs: 10000 });
    stateMachine.start();
    stateMachine.reportDeviation(0);
    stateMachine.reportDeviation(5000);
    expect(stateMachine.getState()).toBe("OFF_ROUTE");
    return { clock, stateMachine };
  }

  it("een succesvolle reroute: OFF_ROUTE → REROUTING → REROUTED, en levert de nieuwe route op", async () => {
    const { clock, stateMachine } = offRouteMachine();
    const originalRoute = makeRoute();
    const newRoute = makeRoute({ id: "route-rerouted" });
    const executor = new RerouteExecutor(new FakeRouteEngineClient({ type: "success", route: newRoute }));

    const result = await performReroute({
      stateMachine,
      clock,
      executor,
      request: { originalRoute, fromLogicalNodeId: "n2", temporaryAvoidEdgeIds: ["e1"] },
    });

    expect(result.outcome).toBe("success");
    expect(stateMachine.getState()).toBe("REROUTED");
    expect(stateMachine.getRerouteCompletedAt()).toBe(0);
  });

  it("een mislukte reroute valt terug naar OFF_ROUTE (ontwerp sectie 19), niet vastgelopen in REROUTING", async () => {
    const { clock, stateMachine } = offRouteMachine();
    const executor = new RerouteExecutor(
      new FakeRouteEngineClient({ type: "failure", reason: "disconnected", message: "Geen pad gevonden." })
    );

    const result = await performReroute({
      stateMachine,
      clock,
      executor,
      request: { originalRoute: makeRoute(), fromLogicalNodeId: "n2", temporaryAvoidEdgeIds: [] },
    });

    expect(result.outcome).toBe("failed");
    expect(stateMachine.getState()).toBe("OFF_ROUTE");
  });

  it("een dataset-versie-mismatch valt eveneens netjes terug naar OFF_ROUTE (geen REROUTED met een verkeerde dataset)", async () => {
    const { clock, stateMachine } = offRouteMachine();
    const originalRoute = makeRoute({ datasetVersionId: "v17" });
    const driftedRoute = makeRoute({ id: "route-drifted", datasetVersionId: "v18" });
    const executor = new RerouteExecutor(new FakeRouteEngineClient({ type: "success", route: driftedRoute }));

    const result = await performReroute({
      stateMachine,
      clock,
      executor,
      request: { originalRoute, fromLogicalNodeId: "n2", temporaryAvoidEdgeIds: [] },
    });

    expect(result.outcome).toBe("failed");
    expect(stateMachine.getState()).toBe("OFF_ROUTE");
  });

  it("gooit een fout als de state machine niet in OFF_ROUTE staat (dezelfde eis als startReroute() zelf, stap 2)", async () => {
    const clock = new ManualNavigationClock(0);
    const stateMachine = new NavigationStateMachine({ deviationConfirmDurationMs: 5000, rerouteCooldownMs: 10000 });
    stateMachine.start(); // ON_ROUTE, niet OFF_ROUTE
    const executor = new RerouteExecutor(new FakeRouteEngineClient({ type: "success", route: makeRoute({ id: "new" }) }));

    await expect(
      performReroute({
        stateMachine,
        clock,
        executor,
        request: { originalRoute: makeRoute(), fromLogicalNodeId: "n2", temporaryAvoidEdgeIds: [] },
      })
    ).rejects.toThrow();
    expect(stateMachine.getState()).toBe("ON_ROUTE"); // ongewijzigd
  });
});
