import { GpsSample, GpsSource } from "../types";

/**
 * Browser GPS-adapter (ontwerp sectie 4) -- implementatiestap 11.
 *
 * Enige plek in het hele navigatiepakket die `navigator.geolocation`
 * aanraakt. Implementeert dezelfde `GpsSource`-interface als
 * `SimulatedGpsSource` (stap 1) -- de rest van de keten (GpsFixEvaluator,
 * candidate matcher, progress, deviation detection, NavigationSession-
 * Controller) kent het verschil niet en hoeft niet te weten of de bron
 * gesimuleerd of echt is. Dat is de vereiste architectuurkeuze uit deze
 * stap: geen `navigator.geolocation` rechtstreeks door de navigatielogica
 * laten lopen.
 *
 * De Geolocation API-vorm is hier LOKAAL getypeerd (`GeolocationLike` e.a.),
 * niet de globale `lib.dom.d.ts`-typen -- zodat deze klasse injecteerbaar en
 * testbaar is zonder een DOM-omgeving (jsdom) in de testrunner. In productie
 * is `options.geolocation` gewoon `navigator.geolocation`.
 */

export interface GeolocationLike {
  watchPosition(
    success: (position: GeolocationPositionLike) => void,
    error?: (error: GeolocationPositionErrorLike) => void,
    options?: PositionOptionsLike
  ): number;
  clearWatch(watchId: number): void;
}

export type GeolocationPositionLike = {
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number;
    heading: number | null;
    speed: number | null;
  };
  timestamp: number;
};

export type GeolocationPositionErrorLike = {
  code: number;
  message: string;
};

export type PositionOptionsLike = {
  enableHighAccuracy?: boolean;
  timeout?: number;
  maximumAge?: number;
};

export type BrowserGeolocationSourceOptions = {
  enableHighAccuracy?: boolean;
  timeout?: number;
  maximumAge?: number;
  /** Geïnjecteerd voor tests. Standaard `navigator.geolocation` in de browser. */
  geolocation?: GeolocationLike;
  onError?: (error: GeolocationPositionErrorLike) => void;
};

export class BrowserGeolocationSource implements GpsSource {
  private watchId: number | null = null;
  private lastKnown: GpsSample | null = null;
  private readonly listeners: Set<(sample: GpsSample) => void> = new Set();
  private readonly geolocation: GeolocationLike;

  constructor(private readonly options: BrowserGeolocationSourceOptions = {}) {
    const injected = options.geolocation;
    const globalGeolocation =
      typeof navigator !== "undefined" ? (navigator as unknown as { geolocation?: GeolocationLike }).geolocation : undefined;
    const resolved = injected ?? globalGeolocation;
    if (!resolved) {
      throw new Error(
        "BrowserGeolocationSource: geen Geolocation API beschikbaar (geen navigator.geolocation, geen geïnjecteerde implementatie)."
      );
    }
    this.geolocation = resolved;
  }

  /** Start `watchPosition`. Geen effect als al actief -- geen dubbele watch. */
  start(): void {
    if (this.watchId !== null) return;
    this.watchId = this.geolocation.watchPosition(
      (position) => this.handlePosition(position),
      (error) => this.options.onError?.(error),
      {
        enableHighAccuracy: this.options.enableHighAccuracy ?? true,
        timeout: this.options.timeout,
        maximumAge: this.options.maximumAge,
      }
    );
  }

  /** Stopt `watchPosition`. Geen effect als niet actief. */
  stop(): void {
    if (this.watchId !== null) {
      this.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  subscribe(callback: (sample: GpsSample) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  getLastKnown(): GpsSample | null {
    return this.lastKnown;
  }

  private handlePosition(position: GeolocationPositionLike): void {
    const sample: GpsSample = {
      lat: position.coords.latitude,
      lon: position.coords.longitude,
      accuracyM: position.coords.accuracy,
      headingDeg: position.coords.heading,
      speedMps: position.coords.speed,
      // GPS-timestamp = bronmetadata (ontwerp sectie 13B), NOOIT gebruikt als navigatieklok --
      // die scheiding wordt door GpsFixEvaluator/NavigationClock (stap 3) bewaakt, niet hier.
      timestamp: position.timestamp,
    };
    this.lastKnown = sample;
    for (const listener of this.listeners) listener(sample);
  }
}
