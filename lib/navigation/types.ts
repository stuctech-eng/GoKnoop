/**
 * Navigation Engine — kerntypes voor GPS-tracking.
 * Zie docs/phase4-navigation-design.md voor het volledige contract (Phase 4).
 *
 * Dit bestand hoort bij implementatiestap 1 (ontwerp sectie 23): de GPS-
 * simulator. Alleen wat daarvoor nodig is staat hier -- NavigationSession en
 * NavigationState (ontwerp sectie 2/14) volgen in implementatiestap 2, niet
 * hier vooruit gebouwd (Master System sectie 1: geen aannames vooruitlopend
 * op een latere, nog te bouwen stap).
 */

/**
 * De 11 navigatiestatussen uit het Phase 4-ontwerp (sectie 14), inclusief
 * PERMISSION_DENIED als expliciete state (na review, niet samengevoegd met
 * GPS_LOST -- zie ontwerp sectie 14, laatste bullet).
 *
 * Dit type hoort bij implementatiestap 2 (ontwerp sectie 23). De state
 * machine zelf staat in lib/navigation/session/navigation-state-machine.ts,
 * bewust nog los van echte GPS/matching/reroute-logica (latere stappen).
 */
export type NavigationState =
  | "NOT_STARTED"
  | "ON_ROUTE"
  | "POSSIBLE_DEVIATION"
  | "OFF_ROUTE"
  | "REROUTING"
  | "REROUTED"
  | "GPS_LOST"
  | "PAUSED"
  | "ARRIVED"
  | "CANCELLED"
  | "PERMISSION_DENIED";

/** Eén GPS-meting, zoals de Geolocation API die levert (of de simulator nabootst). */
export type GpsSample = {
  lat: number;
  lon: number;
  /** Geolocation API `coords.accuracy`, in meter. */
  accuracyM: number;
  /** Geolocation API `coords.heading`, in graden. Null indien onbeschikbaar (ontwerp sectie 13). */
  headingDeg: number | null;
  /** Geolocation API `coords.speed`, in m/s. Null indien onbeschikbaar (ontwerp sectie 13). */
  speedMps: number | null;
  /**
   * Epoch ms, device-tijd van de sample -- NIET de ontvangsttijd van de
   * browser/app. Leidend voor elk tijdgebaseerd mechanisme (ontwerp sectie 13B,
   * "navigation clock"): GPS_LOST-detectie, afwijkingsbevestiging, cooldown.
   */
  timestamp: number;
};

/**
 * Abstractie over de bron van GPS-data (ontwerp sectie 4). Latere navigatie-
 * logica (matching, deviation, state machine) praat alleen met deze
 * interface, nooit rechtstreeks met de Geolocation API of een simulator --
 * dezelfde laagscheiding als `GraphProvider` in de Route Engine
 * (Phase 2-ontwerp sectie 4).
 *
 * Implementaties (ontwerp sectie 4):
 *   SimulatedGpsSource        -- deze stap, test-eerst-strategie (sectie 20)
 *   BrowserGeolocationSource  -- latere implementatiestap (sectie 23, stap 11),
 *                                 niet hier gebouwd
 */
export interface GpsSource {
  /** Abonneert op nieuwe samples. Retourneert een functie om weer uit te schrijven. */
  subscribe(callback: (sample: GpsSample) => void): () => void;
  /** Laatst ontvangen sample, of null als er nog niets binnenkwam. */
  getLastKnown(): GpsSample | null;
}
