import { GpsSample } from "../types";
import { DeviationDetector, DeviationOutcome } from "../deviation/deviation-detector";
import { NavigationStateMachine, InvalidNavigationTransitionError } from "../session/navigation-state-machine";

/**
 * Operationele levenscyclus-afhandeling (ontwerp sectie 12/14/19) --
 * implementatiestap 9.
 *
 * Beantwoordt precies één vraag: wat doet de NavigationSession wanneer de
 * GPS-bron, toestemming, pauzestatus of route-eindconditie verandert?
 * Bewust GEEN echte iPhone-GPS, GEEN UI, GEEN kaartweergave, GEEN
 * batterijoptimalisatie, GEEN achtergrondtracking -- dat zijn latere,
 * expliciet aparte stappen (sectie 23, stap 11/12).
 *
 * KERNONDERSCHEID (na review): GPS_LOST en PERMISSION_DENIED zijn NIET
 * hetzelfde en worden hier ook niet hetzelfde behandeld.
 *   - GPS_LOST: toestemming is er, het signaal valt tijdelijk weg. Het
 *     systeem blijft actief; zodra een nieuwe geldige fix binnenkomt,
 *     herstelt de sessie zelf (via DeviationDetector, stap 6) naar
 *     ON_ROUTE/POSSIBLE_DEVIATION -- geen aparte "herstel"-aanroep nodig.
 *   - PERMISSION_DENIED: er is helemaal geen toegang tot locatiedata. Dat
 *     is een expliciete, aparte gebruikers-/browseractie (denyPermission()/
 *     grantPermission()), nooit afgeleid uit GPS-signaalverlies.
 */
export class NavigationSessionController {
  constructor(
    private readonly detector: DeviationDetector,
    private readonly stateMachine: NavigationStateMachine
  ) {}

  /**
   * Verwerkt één GPS-sample. Controleert EERST (op basis van de tot dusver
   * bekende gezondheidsstatus, dus vóór deze sample verwerkt is) of het
   * signaal als kwijt gold, en meldt dat zo nodig aan de state machine.
   * Delegeert daarna aan de DeviationDetector (stap 6), die zelf al
   * correct omgaat met herstel na een GPS_LOST-periode.
   */
  processGpsSample(rawSample: GpsSample | null | undefined): DeviationOutcome {
    this.checkGpsHealth();
    return this.detector.process(rawSample);
  }

  /**
   * Controleert onafhankelijk van een inkomende sample of het signaal als
   * kwijt geldt (ontwerp sectie 12) en meldt dat zo nodig. Los aanroepbaar
   * (bijv. door een toekomstige periodieke check), zodat "geen samples meer
   * ontvangen" ook zonder een nieuwe sample gedetecteerd kan worden.
   */
  checkGpsHealth(): void {
    if (this.detector.isGpsSignalLost()) {
      this.tryTransition(() => this.stateMachine.reportGpsLost());
    }
  }

  /** Geolocation-toestemming geweigerd of ingetrokken (ontwerp sectie 14). NOOIT hetzelfde pad als GPS_LOST. */
  denyPermission(): void {
    this.stateMachine.denyPermission();
  }

  /** Gebruiker verleent alsnog toestemming; sessie start vers op (ontwerp sectie 14). */
  grantPermission(): void {
    this.stateMachine.grantPermission();
  }

  /** Gebruiker pauzeert expliciet. */
  pause(): void {
    this.stateMachine.pause();
  }

  /** Gebruiker hervat. */
  resume(): void {
    this.stateMachine.resume();
  }

  /**
   * Controleert of het einddoel bereikt is en meldt dat zo nodig. De
   * aanroeper levert `remainingDistanceM` aan (uit ProgressTracker/
   * calculateProgress, stap 5) -- deze module berekent zelf geen progress,
   * om matching niet te dupliceren. Geen effect als de state niet ON_ROUTE
   * is, of de drempel nog niet gehaald is.
   */
  checkArrival(remainingDistanceM: number, arrivalThresholdM: number): boolean {
    if (this.stateMachine.getState() !== "ON_ROUTE") return false;
    if (remainingDistanceM > arrivalThresholdM) return false;
    this.stateMachine.arrive();
    return true;
  }

  /** Gebruiker beëindigt de sessie expliciet. */
  cancel(): void {
    this.stateMachine.cancel();
  }

  getState() {
    return this.stateMachine.getState();
  }

  /**
   * Voert `fn` uit en slikt een `InvalidNavigationTransitionError` stil af
   * (de state accepteert dit signaal nu eenmaal niet -- bijv. al in
   * GPS_LOST, of in een eindstadium) -- geen crash voor een verwachte,
   * onschadelijke situatie. Elke andere fout wordt wél doorgegeven.
   */
  private tryTransition(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      if (err instanceof InvalidNavigationTransitionError) return;
      throw err;
    }
  }
}
