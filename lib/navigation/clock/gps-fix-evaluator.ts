import { GpsSample } from "../types";
import { NavigationClock } from "./navigation-clock";

/**
 * GPS-metadata/gezondheidstracking (ontwerp sectie 12/13B) -- implementatiestap 3.
 *
 * Houdt strikt de drie tijdbegrippen uit elkaar:
 *   GPS timestamp   -- `GpsSample.timestamp`, ruw meetgegeven, hier NOOIT gebruikt
 *                       om navigatietijd/GPS_LOST te bepalen, alleen gediagnosticeerd
 *                       (zie gpsTimestampNonMonotonic/gpsTimestampDeltaMs hieronder).
 *   Navigation time -- afkomstig van de geïnjecteerde NavigationClock, monotoon,
 *                       de enige bron voor lastUpdateAt/lastValidFixAt/isSignalLost.
 *   Last valid fix  -- de laatste GEACCEPTEERDE sample (voldoende nauwkeurig, geldig),
 *                       met het navigatietijdstip waarop die geaccepteerd werd.
 *
 * Bewust GEEN matching, GEEN afwijkingsdetectie, GEEN aanroep naar de
 * NavigationStateMachine (stap 2) hier -- deze klasse produceert alleen
 * betrouwbare metadata. Het daadwerkelijk melden van GPS_LOST aan de state
 * machine is een latere integratiestap (sectie 23, stap 9).
 */

export type GpsFixEvaluatorOptions = {
  /** Ontwerp sectie 12: GPS_ACCURACY_THRESHOLD_M. Samples met een hogere accuracyM worden afgekeurd. */
  accuracyThresholdM: number;
};

export type GpsHealthSnapshot = {
  /** Navigatietijd (NavigationClock) van de laatst VERWERKTE sample, ongeacht geldigheid. Null als er nog niets verwerkt is. */
  lastUpdateAt: number | null;
  /** Navigatietijd van de laatste GEACCEPTEERDE (geldige, voldoende nauwkeurige) fix. Null als die er nog niet was. */
  lastValidFixAt: number | null;
  /** Aantal opeenvolgende afgekeurde samples wegens lage nauwkeurigheid, sinds de laatste geaccepteerde fix. */
  consecutiveLowAccuracyCount: number;
  /** De ruwe, laatst geaccepteerde sample zelf -- ongewijzigd meetgegeven. */
  lastValidFix: GpsSample | null;
};

export type GpsFixResult =
  | {
      accepted: true;
      sample: GpsSample;
      gpsTimestampNonMonotonic: boolean;
      gpsTimestampDeltaMs: number | null;
    }
  | {
      accepted: false;
      reason: "invalid_sample" | "low_accuracy";
      gpsTimestampNonMonotonic: boolean;
      gpsTimestampDeltaMs: number | null;
    };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export class GpsFixEvaluator {
  private lastUpdateAt: number | null = null;
  private lastValidFixAt: number | null = null;
  private consecutiveLowAccuracyCount = 0;
  private lastValidFix: GpsSample | null = null;
  /** Laatst geziene GPS-timestamp (van ELKE sample, ook afgekeurde) -- puur voor de monotoniciteitsdiagnose. */
  private previousGpsTimestamp: number | null = null;

  constructor(
    private readonly clock: NavigationClock,
    private readonly options: GpsFixEvaluatorOptions
  ) {}

  /**
   * Verwerkt één inkomende, ruwe GPS-sample. Accepteert `null`/`undefined`
   * (ontbrekende fix) zonder te crashen -- expliciet als "invalid_sample"
   * gerapporteerd, geen stille negeer-actie.
   */
  process(rawSample: GpsSample | null | undefined): GpsFixResult {
    const navigationTime = this.clock.now();
    // Elke binnenkomende sample telt als een GPS-update, ook een afgekeurde/ontbrekende
    // (ontwerp sectie 13B, tabel "batterij/performance-throttling").
    this.lastUpdateAt = navigationTime;

    const { nonMonotonic, deltaMs } = this.diagnoseGpsTimestamp(rawSample);
    if (rawSample && isFiniteNumber(rawSample.timestamp)) {
      this.previousGpsTimestamp = rawSample.timestamp;
    }

    if (!this.isValidSample(rawSample)) {
      return { accepted: false, reason: "invalid_sample", gpsTimestampNonMonotonic: nonMonotonic, gpsTimestampDeltaMs: deltaMs };
    }

    if (rawSample.accuracyM > this.options.accuracyThresholdM) {
      this.consecutiveLowAccuracyCount += 1;
      return { accepted: false, reason: "low_accuracy", gpsTimestampNonMonotonic: nonMonotonic, gpsTimestampDeltaMs: deltaMs };
    }

    this.consecutiveLowAccuracyCount = 0;
    this.lastValidFixAt = navigationTime; // navigatietijd, NOOIT rawSample.timestamp
    this.lastValidFix = rawSample;
    return { accepted: true, sample: rawSample, gpsTimestampNonMonotonic: nonMonotonic, gpsTimestampDeltaMs: deltaMs };
  }

  /** Huidige gezondheidssnapshot -- vormt de basis voor het `gpsHealth`-veld op NavigationSession (latere stap). */
  getSnapshot(): GpsHealthSnapshot {
    return {
      lastUpdateAt: this.lastUpdateAt,
      lastValidFixAt: this.lastValidFixAt,
      consecutiveLowAccuracyCount: this.consecutiveLowAccuracyCount,
      lastValidFix: this.lastValidFix,
    };
  }

  /**
   * Of het GPS-signaal als "kwijt" geldt (ontwerp sectie 12), uitsluitend op
   * basis van navigatietijd sinds de laatste geldige fix -- nooit op basis
   * van een GPS-sample-timestamp. Vóór de eerste geldige fix is "kwijt" geen
   * zinvol begrip (er was nog nooit signaal); dat is hier een bewuste,
   * benoemde keuze, geen stilzwijgende aanname.
   */
  isSignalLost(gpsTimeoutMs: number): boolean {
    if (this.lastValidFixAt === null) return false;
    return this.clock.now() - this.lastValidFixAt >= gpsTimeoutMs;
  }

  private diagnoseGpsTimestamp(rawSample: GpsSample | null | undefined): { nonMonotonic: boolean; deltaMs: number | null } {
    if (!rawSample || !isFiniteNumber(rawSample.timestamp)) {
      return { nonMonotonic: false, deltaMs: null };
    }
    if (this.previousGpsTimestamp === null) {
      return { nonMonotonic: false, deltaMs: null };
    }
    const deltaMs = rawSample.timestamp - this.previousGpsTimestamp;
    return { nonMonotonic: deltaMs <= 0, deltaMs };
  }

  private isValidSample(sample: GpsSample | null | undefined): sample is GpsSample {
    if (!sample) return false;
    if (!isFiniteNumber(sample.lat) || sample.lat < -90 || sample.lat > 90) return false;
    if (!isFiniteNumber(sample.lon) || sample.lon < -180 || sample.lon > 180) return false;
    if (!isFiniteNumber(sample.accuracyM) || sample.accuracyM < 0) return false;
    if (!isFiniteNumber(sample.timestamp)) return false;
    if (sample.headingDeg !== null && (!isFiniteNumber(sample.headingDeg) || sample.headingDeg < 0 || sample.headingDeg >= 360)) {
      return false;
    }
    if (sample.speedMps !== null && (!isFiniteNumber(sample.speedMps) || sample.speedMps < 0)) {
      return false;
    }
    return true;
  }
}
