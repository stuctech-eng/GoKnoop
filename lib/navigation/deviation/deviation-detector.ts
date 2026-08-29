import { Point } from "../../route-engine/types";
import { wgs84ToRd } from "../../route-engine/coordinate-transform";
import { GpsSample, MatchedPosition } from "../types";
import { NavigationClock } from "../clock/navigation-clock";
import { GpsFixEvaluator } from "../clock/gps-fix-evaluator";
import { matchPosition, MatchOptions } from "../matching/candidate-matcher";
import { NavigationStateMachine, InvalidNavigationTransitionError } from "../session/navigation-state-machine";

/**
 * Deviation detection (ontwerp sectie 9/11) -- implementatiestap 6.
 *
 * Verbindt de eerder gebouwde, geïsoleerde lagen tot de keten uit het
 * ontwerp:
 *
 *   GPS sample → GpsFixEvaluator (stap 3) → candidate matcher (stap 4)
 *     → MatchedPosition → (progress, stap 5, hier niet aangeroepen --
 *       parallel, geen invloed op het afwijkingsoordeel)
 *     → deviation-classificatie (DIT bestand)
 *     → NavigationStateMachine.reportOnRoute()/reportDeviation() (stap 2)
 *
 * KERNPRINCIPE, letterlijk uit de opdracht: dit bestand implementeert NOOIT
 * `perpendicularDistanceM > DEVIATION_THRESHOLD_M → OFF_ROUTE` rechtstreeks.
 * Het classificeert een sample alleen als "op de route" of "afwijkend" en
 * geeft dat door aan de state machine (`reportOnRoute`/`reportDeviation`,
 * stap 2) -- het BEVESTIGINGSVENSTER (hysterese, ontwerp sectie 11) dat
 * bepaalt of een afwijking daadwerkelijk tot OFF_ROUTE leidt, blijft
 * volledig en uitsluitend in de state machine zelf. Deze module dupliceert
 * die logica niet.
 *
 * Bewust GEEN reroute-triggering (`startReroute()` wordt hier NOOIT
 * aangeroepen), GEEN RECENT_ROUTE_MEMORY, GEEN REROUTE_COOLDOWN-gebruik --
 * die horen bij implementatiestap 7/8. Eenmaal in OFF_ROUTE, doet deze
 * module verder niets meer totdat een latere stap reroute-logica toevoegt.
 * Bewust ook GEEN `reportGpsLost()`-aanroep -- die expliciete transitie is
 * implementatiestap 9 ("GPS_LOST/PERMISSION_DENIED/PAUSED/ARRIVED-
 * afhandeling"). Deze module zorgt er wel voor dat een GPS-signaalverlies
 * nooit tot een valse afwijkingsmelding leidt (zie `process()`).
 */

export type DeviationDetectorOptions = {
  /** Ontwerp sectie 9: DEVIATION_THRESHOLD_M -- boven deze perpendiculaire afstand geldt een positie als afwijkend. */
  deviationThresholdM: number;
  /** Doorgegeven aan de GpsFixEvaluator (stap 3). */
  accuracyThresholdM: number;
  /** Doorgegeven aan de GpsFixEvaluator/isSignalLost (stap 3) -- alleen gebruikt om een fresh-match-reset te bepalen, GEEN reportGpsLost()-aanroep (stap 9). */
  gpsTimeoutMs: number;
  /** Doorgegeven aan de candidate-matcher (stap 4). */
  matchOptions: MatchOptions;
};

export type DeviationOutcome =
  | { action: "reported_on_route"; matchedPosition: MatchedPosition }
  | { action: "reported_deviation"; matchedPosition: MatchedPosition }
  | {
      action: "abstained";
      reason: "invalid_sample" | "low_accuracy" | "no_route_match" | "state_not_accepting_signal";
    };

export class DeviationDetector {
  private readonly fixEvaluator: GpsFixEvaluator;
  private lastMatch: MatchedPosition | null = null;

  constructor(
    private readonly geometry: readonly Point[],
    private readonly stateMachine: NavigationStateMachine,
    private readonly clock: NavigationClock,
    private readonly options: DeviationDetectorOptions
  ) {
    this.fixEvaluator = new GpsFixEvaluator(clock, { accuracyThresholdM: options.accuracyThresholdM });
  }

  /**
   * Verwerkt één ruwe GPS-sample. Roept, indien van toepassing, precies één
   * van `reportOnRoute()`/`reportDeviation()` aan op de state machine --
   * nooit beide, nooit vaker dan één keer per verwerkte sample.
   */
  process(rawSample: GpsSample | null | undefined): DeviationOutcome {
    // Vóór verwerking vastleggen of het signaal net hersteld is van een lange stilte
    // (ontwerp sectie 6, randgeval GPS-hervatting): de eerstvolgende match moet dan
    // vers zijn (geen venster rond een inmiddels achterhaalde vorige positie).
    const wasSignalLost = this.fixEvaluator.isSignalLost(this.options.gpsTimeoutMs);

    const fixResult = this.fixEvaluator.process(rawSample);
    if (!fixResult.accepted) {
      // Eén slechte/ontbrekende fix leidt NOOIT tot een afwijkingsmelding -- eenvoudigweg
      // geen signaal richting de state machine (geen "geen valse deviation"-uitzondering
      // nodig, want er wordt hier gewoon niets gerapporteerd).
      return { action: "abstained", reason: fixResult.reason };
    }

    if (wasSignalLost) {
      this.lastMatch = null; // fresh match, geen venster rond een verouderde positie
    }

    const rdPosition = wgs84ToRd(fixResult.sample.lat, fixResult.sample.lon);
    const matched = matchPosition(
      this.geometry,
      {
        position: rdPosition,
        headingDeg: fixResult.sample.headingDeg,
        speedMps: fixResult.sample.speedMps,
        previousMatch: this.lastMatch,
      },
      this.options.matchOptions
    );

    if (matched === null) {
      return { action: "abstained", reason: "no_route_match" };
    }
    this.lastMatch = matched;

    const navigationTime = this.clock.now();
    const isDeviating = matched.perpendicularDistanceM > this.options.deviationThresholdM;

    try {
      if (isDeviating) {
        this.stateMachine.reportDeviation(navigationTime);
        return { action: "reported_deviation", matchedPosition: matched };
      } else {
        this.stateMachine.reportOnRoute(navigationTime);
        return { action: "reported_on_route", matchedPosition: matched };
      }
    } catch (err) {
      if (err instanceof InvalidNavigationTransitionError) {
        // De state machine accepteert dit signaal niet vanuit de huidige state (bijv. OFF_ROUTE,
        // waar alleen startReroute() geldig is -- stap 7/8). Geen crash, geen stille aanname --
        // expliciet gerapporteerd als "abstained", zodat de aanroeper weet dat er niets gebeurd is.
        return { action: "abstained", reason: "state_not_accepting_signal" };
      }
      throw err;
    }
  }

  /** Laatste match, voor diagnose/tests. */
  getLastMatch(): MatchedPosition | null {
    return this.lastMatch;
  }

  /**
   * Of het GPS-signaal momenteel als "kwijt" geldt (ontwerp sectie 12),
   * puur navigatietijd-gebaseerd (stap 3). Voor gebruik door de
   * implementatiestap-9-orchestratie (`NavigationSessionController`) --
   * hergebruikt dezelfde interne `GpsFixEvaluator`-instantie, geen tweede,
   * los bijgehouden gezondheidsstatus die uit de pas zou kunnen lopen.
   */
  isGpsSignalLost(): boolean {
    return this.fixEvaluator.isSignalLost(this.options.gpsTimeoutMs);
  }
}
