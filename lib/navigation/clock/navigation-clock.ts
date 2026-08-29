/**
 * Navigation clock (ontwerp sectie 13B) -- implementatiestap 3.
 *
 * AANGESCHERPT ten opzichte van de eerdere formulering in
 * docs/phase4-navigation-design.md sectie 13B (die "navigation time" nog
 * omschreef als "gebaseerd op device-tijd van de sample"): op expliciete
 * instructie wordt "navigation time" hier een volledig onafhankelijke,
 * monotone klok, NOOIT afgeleid van `GpsSample.timestamp`. Reden: een GPS-
 * device-timestamp is meetgegeven, geen systeemklok -- hij kan (door
 * clock-drift, tijdsynchronisatie, gecachete/oude fixes) niet-monotoon zijn
 * of grote sprongen maken. State-machine-timers (bevestigingsvenster,
 * cooldown, GPS_LOST-detectie) mogen daar niet van afhangen.
 * Dit is een verfijning van sectie 13B, te verwerken bij de eerstvolgende
 * documentreview -- hier al zo geïmplementeerd omdat de tests er specifiek
 * op controleren (zie gps-fix-evaluator.test.ts).
 *
 * `GpsSample.timestamp` (de "GPS timestamp" in de drieledige begrippenset:
 * GPS timestamp / navigation time / last valid fix) blijft ongewijzigd
 * beschikbaar als meetgegeven -- deze klok vervangt dat veld niet, en leest
 * het ook niet.
 */
export interface NavigationClock {
  /** Monotone navigatietijd in ms. Bron is nooit een GPS-sample-timestamp. */
  now(): number;
}

/**
 * Productie-implementatie, voor een latere implementatiestap (sectie 23,
 * stap 11 -- echte GPS). Niet in deze stap tegen echte tijd getest --
 * bewust een dunne wrapper zonder eigen logica, zodat er niets te testen
 * valt behalve "roept de juiste browser-API aan" (triviaal, geen
 * tijdsafhankelijke assertie nodig).
 */
export class SystemNavigationClock implements NavigationClock {
  now(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
  }
}

/**
 * Testklok (ontwerp sectie 20-discipline: geen echte timers in tests).
 * Monotoniciteit wordt hier structureel afgedwongen -- `advance()`/`set()`
 * met een teruglopende waarde gooit een fout, in plaats van dat een test
 * per ongeluk een niet-monotone navigatietijd kan simuleren (dat zou het
 * hele punt van deze klok ondermijnen).
 */
export class ManualNavigationClock implements NavigationClock {
  private currentMs: number;

  constructor(startAt = 0) {
    this.currentMs = startAt;
  }

  now(): number {
    return this.currentMs;
  }

  /** Verplaatst de klok `ms` vooruit. `ms` moet niet-negatief zijn. */
  advance(ms: number): void {
    if (ms < 0) {
      throw new Error("ManualNavigationClock kan niet terugspoelen (monotone klok, ontwerp sectie 13B).");
    }
    this.currentMs += ms;
  }

  /** Zet de klok op een absolute waarde. Moet gelijk aan of later dan de huidige tijd zijn. */
  set(ms: number): void {
    if (ms < this.currentMs) {
      throw new Error("ManualNavigationClock kan niet terugspoelen (monotone klok, ontwerp sectie 13B).");
    }
    this.currentMs = ms;
  }
}
