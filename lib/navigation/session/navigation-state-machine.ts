import { NavigationState } from "../types";

/**
 * NavigationSession state machine (ontwerp sectie 14) -- implementatiestap 2.
 *
 * Bewust GEEN echte GPS, GEEN map matching, GEEN daadwerkelijke Route Engine-
 * aanroep hier. Deze klasse kent alleen abstracte, tijdgestempelde signalen
 * ("dit is een on-route positie", "dit is een afwijkende positie", "GPS is
 * kwijt", "reroute is voltooid", etc.) -- waar die signalen vandaan komen
 * (matching, stap 3/4/6; Route Engine, stap 7/8) is een latere stap. Dat
 * maakt het straks mogelijk om precies te onderscheiden of een probleem in
 * de state machine zit of in de laag die de signalen produceert (exact de
 * reden die voor deze isolatie is gegeven).
 *
 * Elke methode representeert één signaal uit ontwerp sectie 14. Een aanroep
 * vanuit een state waarin dat signaal geen betekenis heeft, gooit een
 * expliciete fout -- geen stille no-op (zelfde principe als Phase 2 sectie 7:
 * geen stille failures).
 */

export type NavigationStateMachineOptions = {
  /**
   * Ontwerp sectie 11: hoe lang (ms) een afwijkingssignaal moet aanhouden
   * vanaf het eerste signaal, vóór het als bevestigd geldt (POSSIBLE_DEVIATION
   * -> OFF_ROUTE). Bewust een constructor-parameter, geen hardcoded waarde --
   * de exacte duur is nog niet gekalibreerd (ontwerp sectie 20/21).
   */
  deviationConfirmDurationMs: number;
  /**
   * Ontwerp sectie 11: cooldown (ms) na REROUTED waarbinnen een nieuw
   * afwijkingssignaal genegeerd wordt (voorkomt direct opnieuw herberekenen).
   * Eveneens nog niet gekalibreerd -- zie ontwerp sectie 20/21.
   */
  rerouteCooldownMs: number;
};

/** Foutklasse voor een signaal dat geen geldige transitie heeft vanuit de huidige state. */
export class InvalidNavigationTransitionError extends Error {
  constructor(action: string, from: NavigationState) {
    super(`Ongeldig navigatiesignaal "${action}" vanuit state "${from}".`);
    this.name = "InvalidNavigationTransitionError";
  }
}

export class NavigationStateMachine {
  private state: NavigationState = "NOT_STARTED";
  private possibleDeviationSince: number | null = null;
  private rerouteCompletedAt: number | null = null;

  constructor(private readonly options: NavigationStateMachineOptions) {}

  getState(): NavigationState {
    return this.state;
  }

  /** Voor tests/diagnose: sinds wanneer de huidige afwijkingsperiode loopt, of null. */
  getPossibleDeviationSince(): number | null {
    return this.possibleDeviationSince;
  }

  /** Voor tests/diagnose: wanneer de laatste reroute voltooid werd, of null. */
  getRerouteCompletedAt(): number | null {
    return this.rerouteCompletedAt;
  }

  private assertState(action: string, allowed: readonly NavigationState[]): void {
    if (!allowed.includes(this.state)) {
      throw new InvalidNavigationTransitionError(action, this.state);
    }
  }

  private transitionTo(next: NavigationState): void {
    this.state = next;
  }

  // ── Toestemming (ontwerp sectie 14, PERMISSION_DENIED) ──────────────────

  /**
   * Geolocation-toestemming geweigerd of ingetrokken. Geldig vanuit elke
   * actieve state (ontwerp sectie 14: "vanuit elke actieve state, net als
   * GPS_LOST"), niet vanuit de eindstadia of als al geweigerd.
   */
  denyPermission(): void {
    this.assertState("denyPermission", [
      "NOT_STARTED",
      "ON_ROUTE",
      "POSSIBLE_DEVIATION",
      "OFF_ROUTE",
      "REROUTING",
      "REROUTED",
      "GPS_LOST",
      "PAUSED",
    ]);
    this.possibleDeviationSince = null;
    this.transitionTo("PERMISSION_DENIED");
  }

  /** Gebruiker verleent alsnog toestemming. Sessie start "vers" op, geen hervatting van oude state. */
  grantPermission(): void {
    this.assertState("grantPermission", ["PERMISSION_DENIED"]);
    this.transitionTo("NOT_STARTED");
  }

  // ── Sessielevenscyclus ───────────────────────────────────────────────────

  /** Eerste GPS-fix ontvangen, sessie start. */
  start(): void {
    this.assertState("start", ["NOT_STARTED"]);
    this.transitionTo("ON_ROUTE");
  }

  /** Gebruiker pauzeert expliciet. */
  pause(): void {
    this.assertState("pause", [
      "ON_ROUTE",
      "POSSIBLE_DEVIATION",
      "OFF_ROUTE",
      "REROUTING",
      "REROUTED",
      "GPS_LOST",
    ]);
    this.transitionTo("PAUSED");
  }

  /**
   * Gebruiker hervat. Ontwerp sectie 14: "normale detectie vanaf de huidige
   * positie" -- deze implementatie zet de state terug naar ON_ROUTE als
   * uitgangspunt; het eerstvolgende positiesignaal (reportOnRoute/
   * reportDeviation, latere stap) corrigeert dit binnen één signaal als de
   * werkelijke positie afweek. Expliciet benoemd als ontwerpkeuze, geen
   * stilzwijgende aanname.
   */
  resume(): void {
    this.assertState("resume", ["PAUSED"]);
    this.transitionTo("ON_ROUTE");
  }

  /** Aankomst op het einddoel (ontwerp sectie 6, randgeval -- detectie zelf is een latere stap). */
  arrive(): void {
    this.assertState("arrive", ["ON_ROUTE"]);
    this.transitionTo("ARRIVED");
  }

  /** Gebruiker beëindigt de sessie expliciet. Geldig vanuit elke niet-eindstate. */
  cancel(): void {
    this.assertState("cancel", [
      "NOT_STARTED",
      "ON_ROUTE",
      "POSSIBLE_DEVIATION",
      "OFF_ROUTE",
      "REROUTING",
      "REROUTED",
      "GPS_LOST",
      "PAUSED",
      "PERMISSION_DENIED",
    ]);
    this.possibleDeviationSince = null;
    this.transitionTo("CANCELLED");
  }

  // ── Positiesignalen (abstract -- bron is een latere implementatiestap) ──

  /**
   * Signaal: de huidige (matched) positie is op de route.
   * @param timestamp device-tijd van het onderliggende signaal (ontwerp sectie 13B).
   */
  reportOnRoute(_timestamp: number): void {
    this.assertState("reportOnRoute", ["ON_ROUTE", "POSSIBLE_DEVIATION", "GPS_LOST", "REROUTED"]);
    this.possibleDeviationSince = null;
    this.rerouteCompletedAt = null;
    this.transitionTo("ON_ROUTE");
  }

  /**
   * Signaal: de huidige (matched) positie wijkt af van de route (ontwerp
   * sectie 9). Deze methode past zelf de hysterese toe (bevestigingsvenster,
   * ontwerp sectie 11) -- dus herhaaldelijk aanroepen terwijl de afwijking
   * aanhoudt is precies hoe POSSIBLE_DEVIATION uiteindelijk OFF_ROUTE wordt.
   * @param timestamp device-tijd van het onderliggende signaal.
   */
  reportDeviation(timestamp: number): void {
    this.assertState("reportDeviation", ["ON_ROUTE", "POSSIBLE_DEVIATION", "GPS_LOST", "REROUTED"]);

    if (this.state === "REROUTED") {
      const cooldownElapsed =
        this.rerouteCompletedAt !== null && timestamp - this.rerouteCompletedAt >= this.options.rerouteCooldownMs;
      if (!cooldownElapsed) {
        // Binnen de cooldown: signaal genegeerd, geen afwijkingsperiode gestart (ontwerp sectie 11).
        return;
      }
      // Cooldown verstreken: normale afwijkingsdetectie hervat, vers vanaf dit signaal.
      this.possibleDeviationSince = timestamp;
      this.transitionTo("POSSIBLE_DEVIATION");
      return;
    }

    if (this.state === "ON_ROUTE" || this.state === "GPS_LOST") {
      this.possibleDeviationSince = timestamp;
      this.transitionTo("POSSIBLE_DEVIATION");
      return;
    }

    // this.state === "POSSIBLE_DEVIATION"
    const since = this.possibleDeviationSince ?? timestamp;
    const confirmed = timestamp - since >= this.options.deviationConfirmDurationMs;
    if (confirmed) {
      this.possibleDeviationSince = null; // periode is afgerond (bevestigd) -- geen stale waarde laten doorlekken
      this.transitionTo("OFF_ROUTE");
    }
    // Nog niet bevestigd: blijft POSSIBLE_DEVIATION, possibleDeviationSince blijft ongewijzigd.
  }

  // ── GPS-gezondheid ───────────────────────────────────────────────────────

  /** GPS_TIMEOUT_S overschreden (ontwerp sectie 12). */
  reportGpsLost(): void {
    this.assertState("reportGpsLost", [
      "ON_ROUTE",
      "POSSIBLE_DEVIATION",
      "OFF_ROUTE",
      "REROUTING",
      "REROUTED",
    ]);
    this.possibleDeviationSince = null;
    this.transitionTo("GPS_LOST");
  }

  // ── Reroute-levenscyclus (mechaniek; de daadwerkelijke Route Engine-
  //    aanroep en reroute-context zijn latere stappen, sectie 7/8) ────────

  /** Herberekening gestart (ontwerp sectie 10). */
  startReroute(): void {
    this.assertState("startReroute", ["OFF_ROUTE"]);
    this.transitionTo("REROUTING");
  }

  /** Herberekening succesvol afgerond. */
  completeReroute(timestamp: number): void {
    this.assertState("completeReroute", ["REROUTING"]);
    this.rerouteCompletedAt = timestamp;
    this.transitionTo("REROUTED");
  }

  /** Herberekening mislukt (netwerkfout, 422, etc. -- ontwerp sectie 19) -- terug naar OFF_ROUTE. */
  failReroute(): void {
    this.assertState("failReroute", ["REROUTING"]);
    this.transitionTo("OFF_ROUTE");
  }
}
