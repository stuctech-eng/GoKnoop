import { describe, it, expect } from "vitest";
import { GpsFixEvaluator } from "./gps-fix-evaluator";
import { ManualNavigationClock } from "./navigation-clock";
import type { GpsSample } from "../types";

const OPTIONS = { accuracyThresholdM: 20 };

function sample(overrides: Partial<GpsSample> = {}): GpsSample {
  return {
    lat: 52.09,
    lon: 5.12,
    accuracyM: 5,
    headingDeg: null,
    speedMps: null,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe("GpsFixEvaluator — basisacceptatie", () => {
  it("accepteert een geldige, nauwkeurige sample", () => {
    const evaluator = new GpsFixEvaluator(new ManualNavigationClock(), OPTIONS);
    const result = evaluator.process(sample());
    expect(result.accepted).toBe(true);
  });

  it("keurt een sample af wegens lage nauwkeurigheid, zonder te crashen", () => {
    const evaluator = new GpsFixEvaluator(new ManualNavigationClock(), OPTIONS);
    const result = evaluator.process(sample({ accuracyM: 50 }));
    expect(result.accepted).toBe(false);
    expect(result.accepted === false && result.reason).toBe("low_accuracy");
  });

  it("een sample exact op de drempel wordt geaccepteerd (drempel is een boven-grens, niet exclusief)", () => {
    const evaluator = new GpsFixEvaluator(new ManualNavigationClock(), OPTIONS);
    const result = evaluator.process(sample({ accuracyM: OPTIONS.accuracyThresholdM }));
    expect(result.accepted).toBe(true);
  });
});

describe("GpsFixEvaluator — ontbrekende/ongeldige GPS-fixes", () => {
  it("null en undefined worden expliciet afgekeurd als invalid_sample, geen crash, geen stille no-op", () => {
    const evaluator = new GpsFixEvaluator(new ManualNavigationClock(), OPTIONS);
    const r1 = evaluator.process(null);
    const r2 = evaluator.process(undefined);
    expect(r1.accepted).toBe(false);
    expect(r1.accepted === false && r1.reason).toBe("invalid_sample");
    expect(r2.accepted === false && r2.reason).toBe("invalid_sample");
  });

  it("NaN/Infinity in lat of lon wordt afgekeurd", () => {
    const evaluator = new GpsFixEvaluator(new ManualNavigationClock(), OPTIONS);
    expect(evaluator.process(sample({ lat: NaN })).accepted).toBe(false);
    expect(evaluator.process(sample({ lon: Infinity })).accepted).toBe(false);
  });

  it("lat/lon buiten het geldige bereik wordt afgekeurd", () => {
    const evaluator = new GpsFixEvaluator(new ManualNavigationClock(), OPTIONS);
    expect(evaluator.process(sample({ lat: 91 })).accepted).toBe(false);
    expect(evaluator.process(sample({ lat: -91 })).accepted).toBe(false);
    expect(evaluator.process(sample({ lon: 181 })).accepted).toBe(false);
    expect(evaluator.process(sample({ lon: -181 })).accepted).toBe(false);
  });

  it("een negatieve accuracyM wordt afgekeurd als invalid_sample (geen zinvol meetgegeven), niet als low_accuracy", () => {
    const evaluator = new GpsFixEvaluator(new ManualNavigationClock(), OPTIONS);
    const result = evaluator.process(sample({ accuracyM: -1 }));
    expect(result.accepted).toBe(false);
    expect(result.accepted === false && result.reason).toBe("invalid_sample");
  });

  it("een niet-numerieke/ontbrekende timestamp wordt afgekeurd", () => {
    const evaluator = new GpsFixEvaluator(new ManualNavigationClock(), OPTIONS);
    const result = evaluator.process(sample({ timestamp: NaN }));
    expect(result.accepted).toBe(false);
  });
});

describe("GpsFixEvaluator — speed en heading (nullable)", () => {
  it("headingDeg en speedMps mogen beide null zijn -- geldige sample", () => {
    const evaluator = new GpsFixEvaluator(new ManualNavigationClock(), OPTIONS);
    const result = evaluator.process(sample({ headingDeg: null, speedMps: null }));
    expect(result.accepted).toBe(true);
  });

  it("een geldige headingDeg (0-359.99) en speedMps (>=0) worden geaccepteerd", () => {
    const evaluator = new GpsFixEvaluator(new ManualNavigationClock(), OPTIONS);
    expect(evaluator.process(sample({ headingDeg: 0, speedMps: 0 })).accepted).toBe(true);
    expect(evaluator.process(sample({ headingDeg: 359.9, speedMps: 12.5 })).accepted).toBe(true);
  });

  it("een ongeldige headingDeg (buiten 0-360) wordt afgekeurd", () => {
    const evaluator = new GpsFixEvaluator(new ManualNavigationClock(), OPTIONS);
    expect(evaluator.process(sample({ headingDeg: -1 })).accepted).toBe(false);
    expect(evaluator.process(sample({ headingDeg: 360 })).accepted).toBe(false);
  });

  it("een negatieve speedMps wordt afgekeurd", () => {
    const evaluator = new GpsFixEvaluator(new ManualNavigationClock(), OPTIONS);
    expect(evaluator.process(sample({ speedMps: -0.1 })).accepted).toBe(false);
  });
});

describe("GpsFixEvaluator — GPS-timestamp is meetgegeven, geen systeemklok", () => {
  it("lastUpdateAt/lastValidFixAt gebruiken de NavigationClock, NIET GpsSample.timestamp", () => {
    const clock = new ManualNavigationClock(0);
    const evaluator = new GpsFixEvaluator(clock, OPTIONS);

    // Sample met een GPS-timestamp die totaal losstaat van de navigatietijd
    // (bijv. een oude, gecachete fix) -- mag de metadata niet beïnvloeden.
    clock.advance(5000);
    evaluator.process(sample({ timestamp: 1 })); // GPS-timestamp: 1ms epoch, absurd oud

    const snapshot = evaluator.getSnapshot();
    expect(snapshot.lastUpdateAt).toBe(5000);
    expect(snapshot.lastValidFixAt).toBe(5000);
  });

  it("verschil tussen GPS-tijd en lokale verwerkingstijd heeft geen invloed op de gerapporteerde navigatietijd", () => {
    const clock = new ManualNavigationClock(0);
    const evaluator = new GpsFixEvaluator(clock, OPTIONS);

    clock.advance(1000);
    evaluator.process(sample({ timestamp: 999_999_999_999 })); // GPS-tijd ver in de "toekomst" t.o.v. de vorige
    expect(evaluator.getSnapshot().lastValidFixAt).toBe(1000);

    clock.advance(200);
    evaluator.process(sample({ timestamp: 1 })); // GPS-tijd ver terug -- niet-monotoon, maar navigatietijd blijft correct
    expect(evaluator.getSnapshot().lastValidFixAt).toBe(1200);
  });

  it("detecteert niet-oplopende (niet-monotone) GPS-timestamps als diagnose, zonder de sample te weigeren", () => {
    const clock = new ManualNavigationClock(0);
    const evaluator = new GpsFixEvaluator(clock, OPTIONS);

    evaluator.process(sample({ timestamp: 1000 }));
    clock.advance(100);
    const result = evaluator.process(sample({ timestamp: 900 })); // GPS-tijd loopt terug t.o.v. de vorige sample

    expect(result.accepted).toBe(true); // GPS-timestamp-anomalie weerhoudt acceptatie niet
    expect(result.accepted === true && result.gpsTimestampNonMonotonic).toBe(true);
  });

  it("detecteert een gelijke (niet-strikt-stijgende) GPS-timestamp ook als niet-monotoon", () => {
    const clock = new ManualNavigationClock(0);
    const evaluator = new GpsFixEvaluator(clock, OPTIONS);

    evaluator.process(sample({ timestamp: 1000 }));
    clock.advance(100);
    const result = evaluator.process(sample({ timestamp: 1000 })); // exact gelijk

    expect(result.accepted === true && result.gpsTimestampNonMonotonic).toBe(true);
  });

  it("rapporteert grote GPS-timestamp-sprongen via gpsTimestampDeltaMs, zonder de verwerking te blokkeren", () => {
    const clock = new ManualNavigationClock(0);
    const evaluator = new GpsFixEvaluator(clock, OPTIONS);

    evaluator.process(sample({ timestamp: 1000 }));
    clock.advance(1000); // navigatietijd verstrijkt normaal (1s)
    const result = evaluator.process(sample({ timestamp: 1000 + 3_600_000 })); // GPS-tijd springt 1 uur vooruit

    expect(result.accepted).toBe(true);
    expect(result.accepted === true && result.gpsTimestampDeltaMs).toBe(3_600_000);
    // Navigatietijd zelf is hier niet door beïnvloed:
    expect(evaluator.getSnapshot().lastValidFixAt).toBe(1000);
  });

  it("gpsTimestampDeltaMs is null bij de eerste sample (geen vorige om mee te vergelijken)", () => {
    const evaluator = new GpsFixEvaluator(new ManualNavigationClock(), OPTIONS);
    const result = evaluator.process(sample({ timestamp: 5000 }));
    expect(result.accepted === true && result.gpsTimestampDeltaMs).toBeNull();
    expect(result.accepted === true && result.gpsTimestampNonMonotonic).toBe(false);
  });

  it("timestamp-diagnose blijft werken over afgekeurde samples heen (previousGpsTimestamp wordt ook bij afgekeurde samples bijgewerkt)", () => {
    const evaluator = new GpsFixEvaluator(new ManualNavigationClock(), OPTIONS);
    evaluator.process(sample({ timestamp: 1000, accuracyM: 500 })); // afgekeurd (lage nauwkeurigheid), maar timestamp wel geldig
    const result = evaluator.process(sample({ timestamp: 500 })); // loopt terug t.o.v. de vorige (ook al afgekeurde) sample
    expect(result.accepted === true && result.gpsTimestampNonMonotonic).toBe(true);
  });
});

describe("GpsFixEvaluator — consecutiveLowAccuracyCount", () => {
  it("telt op bij opeenvolgende lage-nauwkeurigheid-samples en reset bij een geaccepteerde fix", () => {
    const evaluator = new GpsFixEvaluator(new ManualNavigationClock(), OPTIONS);
    evaluator.process(sample({ accuracyM: 50 }));
    evaluator.process(sample({ accuracyM: 60 }));
    expect(evaluator.getSnapshot().consecutiveLowAccuracyCount).toBe(2);

    evaluator.process(sample({ accuracyM: 5 })); // geaccepteerd
    expect(evaluator.getSnapshot().consecutiveLowAccuracyCount).toBe(0);
  });

  it("een invalid_sample (bijv. null) telt niet mee als lage-nauwkeurigheid, en reset de teller ook niet", () => {
    const evaluator = new GpsFixEvaluator(new ManualNavigationClock(), OPTIONS);
    evaluator.process(sample({ accuracyM: 50 }));
    expect(evaluator.getSnapshot().consecutiveLowAccuracyCount).toBe(1);
    evaluator.process(null);
    expect(evaluator.getSnapshot().consecutiveLowAccuracyCount).toBe(1); // ongewijzigd
  });
});

describe("GpsFixEvaluator — isSignalLost (navigatietijd, ontwerp sectie 12)", () => {
  const GPS_TIMEOUT_MS = 10_000;

  it("is niet 'lost' vóór er ooit een geldige fix is geweest (bewuste keuze, geen aanname)", () => {
    const clock = new ManualNavigationClock(0);
    const evaluator = new GpsFixEvaluator(clock, OPTIONS);
    clock.advance(100_000); // ruim voorbij elke timeout, maar er was nog nooit een fix
    expect(evaluator.isSignalLost(GPS_TIMEOUT_MS)).toBe(false);
  });

  it("is niet 'lost' zolang de laatste geldige fix binnen de timeout ligt", () => {
    const clock = new ManualNavigationClock(0);
    const evaluator = new GpsFixEvaluator(clock, OPTIONS);
    evaluator.process(sample());
    clock.advance(GPS_TIMEOUT_MS - 1);
    expect(evaluator.isSignalLost(GPS_TIMEOUT_MS)).toBe(false);
  });

  it("wordt 'lost' zodra de timeout sinds de laatste geldige fix is overschreden", () => {
    const clock = new ManualNavigationClock(0);
    const evaluator = new GpsFixEvaluator(clock, OPTIONS);
    evaluator.process(sample());
    clock.advance(GPS_TIMEOUT_MS);
    expect(evaluator.isSignalLost(GPS_TIMEOUT_MS)).toBe(true);
  });

  it("herstelt (niet meer 'lost') zodra een nieuwe geldige fix binnenkomt", () => {
    const clock = new ManualNavigationClock(0);
    const evaluator = new GpsFixEvaluator(clock, OPTIONS);
    evaluator.process(sample());
    clock.advance(GPS_TIMEOUT_MS + 1);
    expect(evaluator.isSignalLost(GPS_TIMEOUT_MS)).toBe(true);

    evaluator.process(sample());
    expect(evaluator.isSignalLost(GPS_TIMEOUT_MS)).toBe(false);
  });

  it("blijft 'lost' als binnenkomende samples wel ontvangen maar afgekeurd worden (bijv. aanhoudend lage nauwkeurigheid)", () => {
    const clock = new ManualNavigationClock(0);
    const evaluator = new GpsFixEvaluator(clock, OPTIONS);
    evaluator.process(sample());
    clock.advance(GPS_TIMEOUT_MS + 1);
    evaluator.process(sample({ accuracyM: 999 })); // komt binnen, maar wordt afgekeurd
    expect(evaluator.isSignalLost(GPS_TIMEOUT_MS)).toBe(true);
  });

  it("GPS-timestamp-chaos (niet-monotoon, grote sprongen) heeft GEEN invloed op isSignalLost -- puur navigatietijd", () => {
    const clock = new ManualNavigationClock(0);
    const evaluator = new GpsFixEvaluator(clock, OPTIONS);

    evaluator.process(sample({ timestamp: 5_000_000 })); // ver in de "toekomst"
    clock.advance(1000);
    evaluator.process(sample({ timestamp: 100 })); // ver terug -- niet-monotoon
    clock.advance(1000);
    evaluator.process(sample({ timestamp: 9_000_000_000 })); // wéér een enorme sprong

    // Ondanks de chaotische GPS-timestamps: navigatietijd is pas 2000ms verstreken sinds start,
    // dus nog ruim binnen de timeout.
    expect(evaluator.isSignalLost(GPS_TIMEOUT_MS)).toBe(false);

    clock.advance(GPS_TIMEOUT_MS);
    expect(evaluator.isSignalLost(GPS_TIMEOUT_MS)).toBe(true);
  });
});

describe("GpsFixEvaluator — lastValidFix blijft ongewijzigd meetgegeven", () => {
  it("getSnapshot().lastValidFix bevat exact de laatst geaccepteerde sample, ongewijzigd", () => {
    const evaluator = new GpsFixEvaluator(new ManualNavigationClock(), OPTIONS);
    const s = sample({ lat: 52.5, lon: 5.5, speedMps: 4.2, headingDeg: 90 });
    evaluator.process(s);
    expect(evaluator.getSnapshot().lastValidFix).toEqual(s);
  });

  it("een afgekeurde sample overschrijft lastValidFix niet", () => {
    const evaluator = new GpsFixEvaluator(new ManualNavigationClock(), OPTIONS);
    const good = sample({ lat: 52.5 });
    evaluator.process(good);
    evaluator.process(sample({ lat: 53.0, accuracyM: 999 })); // afgekeurd
    expect(evaluator.getSnapshot().lastValidFix).toEqual(good);
  });
});
