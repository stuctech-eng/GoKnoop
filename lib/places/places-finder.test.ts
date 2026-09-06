import { describe, it, expect } from "vitest";
import { PlacesFinder } from "./places-finder";
import type { PlacesProvider, LatLon, PlaceResult, PlacesProviderError } from "./places-provider";

class FakeProvider implements PlacesProvider {
  public callCount = 0;
  constructor(private readonly result: PlaceResult[] | PlacesProviderError) {}
  async findNearby(_center: LatLon, _category: "parking", _radiusM: number, _limit: number) {
    this.callCount++;
    return this.result;
  }
}

const CENTER: LatLon = { lat: 52.3, lon: 5.2 };
const FAKE_RESULTS: PlaceResult[] = [{ name: "Parkeerplaats Centrum", lat: 52.301, lon: 5.201, distanceM: 150 }];

describe("PlacesFinder — caching (zelfde discipline als LocalBikeRouter, sectie 9.11)", () => {
  it("roept de provider aan en geeft het resultaat door", async () => {
    const provider = new FakeProvider(FAKE_RESULTS);
    const finder = new PlacesFinder(provider);
    const result = await finder.findNearby(CENTER, "parking", 1000, 5);
    expect(result).toEqual(FAKE_RESULTS);
    expect(provider.callCount).toBe(1);
  });

  it("roept de provider niet opnieuw aan voor exact hetzelfde gebied (cache-hit)", async () => {
    const provider = new FakeProvider(FAKE_RESULTS);
    const finder = new PlacesFinder(provider);
    await finder.findNearby(CENTER, "parking", 1000, 5);
    await finder.findNearby(CENTER, "parking", 1000, 5);
    expect(provider.callCount).toBe(1);
  });

  it("een andere straal wordt apart gecached (geen valse cache-hit)", async () => {
    const provider = new FakeProvider(FAKE_RESULTS);
    const finder = new PlacesFinder(provider);
    await finder.findNearby(CENTER, "parking", 1000, 5);
    await finder.findNearby(CENTER, "parking", 2000, 5);
    expect(provider.callCount).toBe(2);
  });

  it("een foutresultaat wordt niet gecached", async () => {
    const provider = new FakeProvider({ reason: "provider_error", message: "tijdelijk niet bereikbaar" });
    const finder = new PlacesFinder(provider);
    await finder.findNearby(CENTER, "parking", 1000, 5);
    await finder.findNearby(CENTER, "parking", 1000, 5);
    expect(provider.callCount).toBe(2);
  });
});
