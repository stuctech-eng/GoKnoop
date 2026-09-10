/**
 * Route-kwaliteitsvalidatie / fallback-laag -- architectuurbesluit 9-9-2026.
 *
 * Positionering (expliciet besloten, niet ter discussie in deze module):
 * dit is een validatiestap NA de kostenberekening, geen onderdeel van het
 * kostenmodel zelf. De router vindt eerst de goedkoopste route (F-factor,
 * connector-kosten), en PAS DAARNA wordt beoordeeld of die route als
 * "normale kandidaat" mag gelden, of dat een fallback nodig is.
 *
 * De concrete drempelwaarden hieronder zijn empirisch getoetst (zie
 * route-quality.test.ts) tegen de echte, vandaag verzamelde metingen:
 * de 337km-anomalie (Volendam-regio, twee gescheiden NWB-componenten
 * overbrugd via een toevallig zeer lange GoKnoop-verbinding) en 24+ gezonde
 * referentieroutes uit Fase 4/5B. Er zit een grote marge tussen de hoogste
 * legitieme waarde die vandaag gemeten is (~2,04) en de laagste anomalie
 * (~18,2) -- de drempels hieronder liggen ruim daartussenin, niet op een
 * fijn afgestemde grens.
 */

export type RouteQualityInput = {
  distanceM: number;
  straightLineDistanceM: number;
  switchCount: number; // aantal netwerkovergangen (connectors) in het pad
};

export type RouteQualityVerdict = "geaccepteerd" | "afgewezen_hard" | "afgewezen_zacht";

export type RouteQualityResult = {
  deviationFactor: number;
  switchesPerKm: number;
  verdict: RouteQualityVerdict;
  reden: string;
};

const HARD_DEVIATION_THRESHOLD = 3.5;
const SOFT_DEVIATION_THRESHOLD = 2.5;
const SOFT_SWITCHES_PER_KM_THRESHOLD = 0.2;

export function evaluateRouteQuality(input: RouteQualityInput): RouteQualityResult {
  const deviationFactor = input.straightLineDistanceM > 0 ? input.distanceM / input.straightLineDistanceM : Infinity;
  const distanceKm = input.distanceM / 1000;
  const switchesPerKm = distanceKm > 0 ? input.switchCount / distanceKm : 0;

  if (deviationFactor > HARD_DEVIATION_THRESHOLD) {
    return {
      deviationFactor,
      switchesPerKm,
      verdict: "afgewezen_hard",
      reden: `deviationFactor ${deviationFactor.toFixed(2)} overschrijdt de harde grens van ${HARD_DEVIATION_THRESHOLD}`,
    };
  }

  if (deviationFactor > SOFT_DEVIATION_THRESHOLD && switchesPerKm > SOFT_SWITCHES_PER_KM_THRESHOLD) {
    return {
      deviationFactor,
      switchesPerKm,
      verdict: "afgewezen_zacht",
      reden: `deviationFactor ${deviationFactor.toFixed(2)} in het twijfelachtige gebied (>${SOFT_DEVIATION_THRESHOLD}) EN ${switchesPerKm.toFixed(2)} overgangen/km (>${SOFT_SWITCHES_PER_KM_THRESHOLD}) -- combinatie van beide is verdacht`,
    };
  }

  return {
    deviationFactor,
    switchesPerKm,
    verdict: "geaccepteerd",
    reden: "binnen normale grenzen",
  };
}
