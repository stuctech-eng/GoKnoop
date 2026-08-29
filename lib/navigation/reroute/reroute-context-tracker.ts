/**
 * Reroute-context (ontwerp sectie 10/11) -- implementatiestap 7.
 *
 * Houdt bij welke edges recent bereden zijn (op basis van cumulatieve
 * routeafstand uit de progress-laag, stap 5), zodat een latere
 * herberekeningsaanvraag (stap 8) `temporaryAvoidEdgeIds` kan meegeven om
 * een pingpong-reroute te voorkomen -- zonder het hele afgeweken traject
 * permanent te blokkeren (ontwerp sectie 10).
 *
 * `RECENT_ROUTE_MEMORY` is hier bewust een injecteerbare parameter (in
 * meter), NIET vastgepind op een specifieke waarde -- de kalibratie is
 * expliciet uitgesteld naar de integratietests (sectie 20/21, stap 10),
 * geleid door het kruisings-/pingpong-testscenario, niet door een a-priori
 * geschatte meterwaarde.
 *
 * Bewust GEEN daadwerkelijke Route Engine-aanroep, GEEN startReroute()-
 * aanroep, GEEN afwijkingsdetectie hier -- deze klasse levert alleen de
 * `temporaryAvoidEdgeIds`-lijst als data. Wanneer en hoe die daadwerkelijk
 * in een herberekeningsaanvraag terechtkomt, is implementatiestap 8.
 */

type EdgeVisit = {
  edgeId: string;
  distanceAlongRouteM: number;
};

export class RerouteContextTracker {
  private visits: EdgeVisit[] = [];

  /**
   * Registreert dat de gebruiker zich op `edgeId` bevindt, op de gegeven
   * cumulatieve routeafstand (rechtstreeks uit `ProgressSnapshot`/
   * `ProgressTracker`, stap 5). Opeenvolgende registraties voor dezelfde
   * edge overschrijven alleen de laatst bekende afstand op die edge (geen
   * ongebonden groei van de geschiedenis terwijl iemand op één edge blijft).
   */
  recordPosition(edgeId: string, distanceAlongRouteM: number): void {
    const last = this.visits[this.visits.length - 1];
    if (last && last.edgeId === edgeId) {
      last.distanceAlongRouteM = distanceAlongRouteM;
      return;
    }
    this.visits.push({ edgeId, distanceAlongRouteM });
  }

  /**
   * Geeft de edge-ID's terug die binnen `recentRouteMemoryM` achter de
   * huidige cumulatieve routeafstand liggen -- de tijdelijke
   * `temporaryAvoidEdgeIds` (ontwerp sectie 10). De huidige edge zelf (waar
   * de afwijking ontstond) is altijd inbegrepen als die binnen het bereik
   * valt; oudere edges buiten het geheugenvenster worden niet meegenomen
   * (geen blinde blokkade van het hele traject).
   */
  getTemporaryAvoidEdgeIds(currentDistanceAlongRouteM: number, recentRouteMemoryM: number): string[] {
    const cutoff = currentDistanceAlongRouteM - recentRouteMemoryM;
    return this.visits.filter((v) => v.distanceAlongRouteM >= cutoff).map((v) => v.edgeId);
  }

  /**
   * Wist de geschiedenis -- aan te roepen zodra de gebruiker weer bevestigd
   * ON_ROUTE is (ontwerp sectie 10: "de blokkade vervalt zodra de gebruiker
   * weer op een logisch aansluitend deel van de route zit"). Een edge die
   * ooit vermeden werd, blijft dus niet voor de rest van de sessie
   * geblokkeerd.
   */
  clear(): void {
    this.visits = [];
  }

  /** Voor tests/diagnose: het aantal onderscheiden edges in de huidige geschiedenis. */
  getVisitCount(): number {
    return this.visits.length;
  }
}
