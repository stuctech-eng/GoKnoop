/**
 * Ruistolerantie voor routevoortgang (ontwerp: "progress kan niet zomaar
 * achteruit springen door GPS-ruis") -- implementatiestap 5.
 *
 * `calculateProgress()` (route-progress-model.ts) is een PURE functie: geeft
 * exact terug wat een enkele MatchedPosition oplevert, zonder geheugen. Deze
 * klasse zit daar als een dunne, stateful laag bovenop en filtert kleine,
 * ruisachtige terugvallen eruit -- zonder de onderliggende matching-laag
 * (stap 4) te wantrouwen bij een grotere, aanhoudende terugval (dat is geen
 * taak van deze module; afwijkingsdetectie, stap 6, gaat daarover).
 */

export type ProgressUpdate = {
  distanceAlongRouteM: number;
  remainingDistanceM: number;
  progressRatio: number;
};

export class ProgressTracker {
  private maxObservedDistanceM = 0;
  private hasObservation = false;

  /** @param noiseToleranceM Terugval kleiner dan of gelijk aan deze waarde wordt genegeerd (niet gerapporteerd). */
  constructor(private readonly noiseToleranceM: number) {
    if (noiseToleranceM < 0) {
      throw new Error("ProgressTracker: noiseToleranceM moet niet-negatief zijn.");
    }
  }

  /**
   * Verwerkt een nieuwe, rauwe afstand-langs-de-route (rechtstreeks uit
   * calculateProgress().distanceAlongRouteM) en geeft de gefilterde,
   * gerapporteerde voortgang terug.
   */
  update(rawDistanceAlongRouteM: number, totalDistanceM: number): ProgressUpdate {
    if (!this.hasObservation) {
      this.maxObservedDistanceM = rawDistanceAlongRouteM;
      this.hasObservation = true;
    } else if (rawDistanceAlongRouteM > this.maxObservedDistanceM) {
      this.maxObservedDistanceM = rawDistanceAlongRouteM;
    } else {
      const regressionM = this.maxObservedDistanceM - rawDistanceAlongRouteM;
      if (regressionM > this.noiseToleranceM) {
        // Grotere terugval dan de ruistolerantie: geaccepteerd als een echte
        // correctie (bijv. een matching-herziening), niet stilzwijgend genegeerd.
        // Of dit een probleem is (afwijking) wordt elders beoordeeld (stap 6).
        this.maxObservedDistanceM = rawDistanceAlongRouteM;
      }
      // Anders: binnen tolerantie -- ruis, maxObservedDistanceM blijft ongewijzigd.
    }

    const distanceAlongRouteM = this.maxObservedDistanceM;
    const remainingDistanceM = totalDistanceM - distanceAlongRouteM;
    const progressRatio = totalDistanceM === 0 ? 0 : distanceAlongRouteM / totalDistanceM;
    return { distanceAlongRouteM, remainingDistanceM, progressRatio };
  }

  /** Laatst gerapporteerde afstand, of null als er nog geen update is geweest. */
  getCurrentDistanceM(): number | null {
    return this.hasObservation ? this.maxObservedDistanceM : null;
  }

  /** Zet de tracker terug -- nodig bij een reroute (nieuwe Route, sectie 3: nieuwe voortgang vanaf de huidige positie). */
  reset(): void {
    this.hasObservation = false;
    this.maxObservedDistanceM = 0;
  }
}
