import { describe, it, expect, vi } from "vitest";
import { BrowserGeolocationSource } from "./browser-geolocation-source";
import type { GeolocationLike, GeolocationPositionLike, GeolocationPositionErrorLike } from "./browser-geolocation-source";

class FakeGeolocation implements GeolocationLike {
  private nextWatchId = 1;
  public successCallback: ((position: GeolocationPositionLike) => void) | null = null;
  public errorCallback: ((error: GeolocationPositionErrorLike) => void) | null = null;
  public lastOptions: unknown = null;
  public clearWatchCalls: number[] = [];

  watchPosition(success: (position: GeolocationPositionLike) => void, error?: (error: GeolocationPositionErrorLike) => void, options?: unknown): number {
    this.successCallback = success;
    this.errorCallback = error ?? null;
    this.lastOptions = options;
    return this.nextWatchId++;
  }

  clearWatch(watchId: number): void {
    this.clearWatchCalls.push(watchId);
  }

  emit(position: GeolocationPositionLike): void {
    this.successCallback?.(position);
  }

  emitError(error: GeolocationPositionErrorLike): void {
    this.errorCallback?.(error);
  }
}

function position(overrides: Partial<GeolocationPositionLike["coords"]> = {}, timestamp = 1000): GeolocationPositionLike {
  return {
    coords: { latitude: 52.09, longitude: 5.12, accuracy: 8, heading: null, speed: null, ...overrides },
    timestamp,
  };
}

describe("BrowserGeolocationSource — constructie", () => {
  it("gooit een fout als er geen navigator.geolocation en geen geïnjecteerde implementatie is", () => {
    // In deze Node-testomgeving bestaat `navigator` niet -- precies het scenario dat getest wordt.
    expect(() => new BrowserGeolocationSource({})).toThrow(/Geolocation API/);
  });

  it("accepteert een geïnjecteerde Geolocation-implementatie zonder te crashen", () => {
    expect(() => new BrowserGeolocationSource({ geolocation: new FakeGeolocation() })).not.toThrow();
  });
});

describe("BrowserGeolocationSource — start/stop", () => {
  it("start() roept watchPosition aan met enableHighAccuracy standaard true", () => {
    const fake = new FakeGeolocation();
    const source = new BrowserGeolocationSource({ geolocation: fake });
    source.start();
    expect(fake.lastOptions).toMatchObject({ enableHighAccuracy: true });
  });

  it("start() twee keer aanroepen creëert geen tweede watch", () => {
    const fake = new FakeGeolocation();
    const watchSpy = vi.spyOn(fake, "watchPosition");
    const source = new BrowserGeolocationSource({ geolocation: fake });
    source.start();
    source.start();
    expect(watchSpy).toHaveBeenCalledTimes(1);
  });

  it("stop() roept clearWatch aan met het juiste watchId", () => {
    const fake = new FakeGeolocation();
    const source = new BrowserGeolocationSource({ geolocation: fake });
    source.start();
    source.stop();
    expect(fake.clearWatchCalls).toEqual([1]);
  });

  it("stop() zonder eerdere start() is een no-op, geen crash", () => {
    const fake = new FakeGeolocation();
    const source = new BrowserGeolocationSource({ geolocation: fake });
    expect(() => source.stop()).not.toThrow();
    expect(fake.clearWatchCalls).toEqual([]);
  });
});

describe("BrowserGeolocationSource — positie-conversie (GeolocationPosition → GpsSample)", () => {
  it("zet coords/timestamp correct om, inclusief nullable heading/speed", () => {
    const fake = new FakeGeolocation();
    const source = new BrowserGeolocationSource({ geolocation: fake });
    const received: unknown[] = [];
    source.subscribe((s) => received.push(s));
    source.start();

    fake.emit(position({ latitude: 52.5, longitude: 5.5, accuracy: 12, heading: 90, speed: 4.2 }, 555_000));

    expect(received).toEqual([
      { lat: 52.5, lon: 5.5, accuracyM: 12, headingDeg: 90, speedMps: 4.2, timestamp: 555_000 },
    ]);
  });

  it("behoudt null voor heading/speed wanneer de browser die niet levert", () => {
    const fake = new FakeGeolocation();
    const source = new BrowserGeolocationSource({ geolocation: fake });
    const received: unknown[] = [];
    source.subscribe((s) => received.push(s));
    source.start();

    fake.emit(position({ heading: null, speed: null }));

    expect((received[0] as { headingDeg: unknown; speedMps: unknown }).headingDeg).toBeNull();
    expect((received[0] as { headingDeg: unknown; speedMps: unknown }).speedMps).toBeNull();
  });

  it("getLastKnown() reflecteert de laatst ontvangen positie", () => {
    const fake = new FakeGeolocation();
    const source = new BrowserGeolocationSource({ geolocation: fake });
    source.start();
    expect(source.getLastKnown()).toBeNull();

    fake.emit(position({}, 1000));
    expect(source.getLastKnown()?.timestamp).toBe(1000);

    fake.emit(position({}, 2000));
    expect(source.getLastKnown()?.timestamp).toBe(2000);
  });
});

describe("BrowserGeolocationSource — foutafhandeling", () => {
  it("een Geolocation-fout gaat naar onError, crasht niet, emit geen sample", () => {
    const fake = new FakeGeolocation();
    const onError = vi.fn();
    const source = new BrowserGeolocationSource({ geolocation: fake, onError });
    const received: unknown[] = [];
    source.subscribe((s) => received.push(s));
    source.start();

    fake.emitError({ code: 1, message: "User denied Geolocation" });

    expect(onError).toHaveBeenCalledWith({ code: 1, message: "User denied Geolocation" });
    expect(received).toEqual([]);
  });

  it("werkt zonder onError-callback (optioneel) zonder te crashen bij een fout", () => {
    const fake = new FakeGeolocation();
    const source = new BrowserGeolocationSource({ geolocation: fake });
    source.start();
    expect(() => fake.emitError({ code: 2, message: "Position unavailable" })).not.toThrow();
  });
});
