import type { NavigationState } from "../types";

/**
 * Drieledige voorfasering (GOKNOOP-MASTER.md sectie 5.4, implementatiestap
 * 12.7): A. Naar startpunt -> B. Start Guidance -> C. Navigatie.
 *
 * Bewust een kleine, PURE, apart geteste functie in de engine-laag, niet
 * losse if/else-logica in een UI-component -- dit is echte sessie-
 * levenscyclus-logica (wanneer begint de sessie feitelijk te navigeren),
 * geen presentatiedetail. `NavigationSessionController` blijft de
 * eigenaar van de daadwerkelijke state-machine-transities; deze functie
 * beslist alleen WELKE fase de UI moet tonen, gegeven wat er al bekend is.
 */

export type PreNavigationPhase = "TO_START" | "START_GUIDANCE" | "NAVIGATING";

export type DeterminePhaseParams = {
  /** Of de NavigationStateMachine al gestart is (eerste geldige fix verwerkt). */
  sessionStarted: boolean;
  /** Afstand (meter) van de huidige ruwe positie tot het startknooppunt van de route. */
  distanceToStartM: number;
  /** Drempel waarbinnen de gebruiker als "bij het startpunt" geldt. */
  arrivalAtStartThresholdM: number;
  /** Huidige NavigationState (alleen relevant zodra de sessie gestart is). */
  navigationState: NavigationState;
  /** Snelheid uit de laatste GPS-sample, of null als onbeschikbaar (ontwerp sectie 13). */
  speedMps: number | null;
  /** Drempel waarboven een betrouwbare bewegingsrichting aangenomen wordt. */
  movementSpeedThresholdMps: number;
};

/**
 * Bepaalt welke van de drie fasen de UI moet tonen.
 *
 * - TO_START: sessie nog niet gestart, gebruiker buiten de aankomstdrempel
 *   van het startknooppunt.
 * - START_GUIDANCE: sessie (nog) niet gestart maar binnen de drempel, ÓF
 *   sessie wel gestart maar nog geen betrouwbare bewegingsrichting
 *   (ontwerp sectie 5.5: GPS-heading pas betrouwbaar bij beweging).
 * - NAVIGATING: sessie gestart, bevestigd ON_ROUTE, én voldoende snelheid
 *   voor een betrouwbare richting.
 */
export function determinePreNavigationPhase(params: DeterminePhaseParams): PreNavigationPhase {
  if (!params.sessionStarted) {
    return params.distanceToStartM <= params.arrivalAtStartThresholdM ? "START_GUIDANCE" : "TO_START";
  }
  const hasReliableMovement = params.speedMps !== null && params.speedMps > params.movementSpeedThresholdMps;
  if (params.navigationState === "ON_ROUTE" && hasReliableMovement) {
    return "NAVIGATING";
  }
  return "START_GUIDANCE";
}
