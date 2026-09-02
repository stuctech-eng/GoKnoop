import { describe, it, expect, vi } from "vitest";
import { LocalBikeRouter } from "./local-bike-router";
import type { RoutingProvider, LatLon, LocalBikeRoutingProfile, LocalBikeRouteResult, LocalBikeRoutingError } from "./types";

function fakeSuccess(distanceM = 500): LocalBikeRouteResult {
  return { geometry: [{ lat: 52.0, lon: 5.0 }, { lat: 52.001, lon: 5.001 }], distanceM, durationS: 120 };
}

class FakeProvider implements RoutingProvider {
  public callCount = 0;
  constructor(private readonly result: LocalBikeRouteResult | LocalBikeRoutingError) {}
  async route(_origin: LatLon, _destination: LatLon, _profile: LocalBikeRoutingProfile) {
    this.callCount++;
    return this.result;
  }
}

const ORIGIN: LatLon = { lat: 52.5, lon: 5.1 };
const DESTINATION: LatLon = { lat: 52.51, lon: 5.11 };

describe("LocalBikeRouter — caching (sectie 9.6, 'zo weinig mogelijk requests')", () => {
  it("roept de provider aan en geeft het resultaat door", async () => {
    const provider = new FakeProvider(fakeSuccess());
    const router = new LocalBikeRouter(provider);
    const result = await router.route(ORIGIN, DESTINATION, "cycling");
    expect("distanceM" in result && result.distanceM).toBe(500);
    expect(provider.callCount).toBe(1);
  });

  it("roept de provider NIET opnieuw aan voor exact dezelfde aanvraag (cache-hit)", async () => {
    const provider = new FakeProvider(fakeSuccess());
    const router = new LocalBikeRouter(provider);
    await router.route(ORIGIN, DESTINATION, "cycling");
    await router.route(ORIGIN, DESTINATION, "cycling");
    await router.route(ORIGIN, DESTINATION, "cycling");
    expect(provider.callCount).toBe(1); // slechts 1 daadwerkelijke aanvraag
    expect(router.cacheSize()).toBe(1);
  });

  it("verschillende profielen worden apart gecached (geen valse cache-hit)", async () => {
    const provider = new FakeProvider(fakeSuccess());
    const router = new LocalBikeRouter(provider);
    await router.route(ORIGIN, DESTINATION, "cycling");
    await router.route(ORIGIN, DESTINATION, "foot");
    expect(provider.callCount).toBe(2);
  });

  it("verschillende origin/destination worden apart gecached", async () => {
    const provider = new FakeProvider(fakeSuccess());
    const router = new LocalBikeRouter(provider);
    await router.route(ORIGIN, DESTINATION, "cycling");
    await router.route({ lat: 53, lon: 6 }, DESTINATION, "cycling");
    expect(provider.callCount).toBe(2);
  });

  it("een foutresultaat wordt NIET gecached -- een volgende poging roept de provider opnieuw aan", async () => {
    const provider = new FakeProvider({ reason: "provider_error", message: "tijdelijk niet bereikbaar" });
    const router = new LocalBikeRouter(provider);
    const first = await router.route(ORIGIN, DESTINATION, "cycling");
    const second = await router.route(ORIGIN, DESTINATION, "cycling");
    expect("reason" in first).toBe(true);
    expect("reason" in second).toBe(true);
    expect(provider.callCount).toBe(2); // geen cache-hit bij een fout
    expect(router.cacheSize()).toBe(0);
  });

  it("bijna-identieke coördinaten (GPS-ruis binnen ~1m) treffen dezelfde cache-entry", async () => {
    const provider = new FakeProvider(fakeSuccess());
    const router = new LocalBikeRouter(provider);
    await router.route(ORIGIN, DESTINATION, "cycling");
    await router.route({ lat: ORIGIN.lat + 0.000001, lon: ORIGIN.lon }, DESTINATION, "cycling"); // <1m verschil
    expect(provider.callCount).toBe(1);
  });
});

describe("LocalBikeRouter — Fase 4-scenario's (parking ↔ startknooppunt, sectie 9.12)", () => {
  it("[verplichte test 1] parking → eerste knooppunt: een normale, korte fietsverbinding werkt", async () => {
    // 'parking' en 'destination' zijn hier gewoon willekeurige lat/lon-punten -- LocalBikeRouter
    // kent geen knooppunten, alleen coördinaten (dat is precies het punt van Layer B).
    const parking: LatLon = { lat: 52.5000, lon: 5.1000 };
    const firstNode: LatLon = { lat: 52.5020, lon: 5.1030 }; // ~250m verderop
    const provider = new FakeProvider(fakeSuccess(280));
    const router = new LocalBikeRouter(provider);

    const result = await router.route(parking, firstNode, "cycling");

    expect("distanceM" in result).toBe(true);
    expect(provider.callCount).toBe(1);
  });

  it("[verplichte test 2] parking buiten het knooppuntennetwerk: LocalBikeRouter routeert net zo goed, want die kent het knooppuntennetwerk helemaal niet", async () => {
    // Een 'parking' ergens midden in een woonwijk, ver van elk fietsknooppunt -- voor
    // LocalBikeRouter maakt dat niets uit, het is gewoon een GPS-coördinaat als elk ander.
    const parkingFarFromNetwork: LatLon = { lat: 51.9, lon: 4.4 }; // willekeurig, geen enkele relatie tot een knooppunt
    const someNode: LatLon = { lat: 52.5, lon: 5.1 };
    const provider = new FakeProvider(fakeSuccess(65000));
    const router = new LocalBikeRouter(provider);

    const result = await router.route(parkingFarFromNetwork, someNode, "cycling");

    expect("distanceM" in result).toBe(true); // geen enkele knooppunt-gerelateerde afwijzing
    expect(provider.callCount).toBe(1);
  });

  it("[verplichte test 3] parking dicht bij een knooppunt: een korte afstand wordt gewoon correct doorgegeven", async () => {
    const parkingNearNode: LatLon = { lat: 52.50000, lon: 5.10000 };
    const nearbyNode: LatLon = { lat: 52.50010, lon: 5.10010 }; // ~13m verderop
    const provider = new FakeProvider(fakeSuccess(15));
    const router = new LocalBikeRouter(provider);

    const result = await router.route(parkingNearNode, nearbyNode, "cycling");

    expect("distanceM" in result && result.distanceM).toBe(15);
  });
});
