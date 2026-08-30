/**
 * Meedraaiende (heading-up) navigatie -- reken-laag (implementatiestap
 * "heading-up navigatie", 29-8-2026). Bewust EERST alleen pure functies +
 * tests, GEEN kaartrotatie/UI-wijziging (die volgt in een latere,
 * afzonderlijke stap, nadat deze basis bevestigd is) -- zelfde discipline
 * als de rest van de navigatie-engine.
 *
 * Hergebruikt bewust bestaande bouwstenen waar mogelijk: `bearingDegrees`
 * (stap 4, `matching/geometry.ts`) blijft de enige plek die een bearing
 * tussen twee RD-punten berekent -- dit bestand voegt alleen toe wat
 * daarna nog ontbrak: normaliseren, RELATIEF maken t.o.v. de rijrichting,
 * classificeren, en de rijrichting zelf stabiel bepalen.
 *
 * Route Engine blijft verantwoordelijk voor welk knooppunt "volgend" is
 * (stap 5, `calculateNextNodeInfo`) -- dit bestand ontvangt dat gewoon als
 * gegeven, reconstrueert het niet.
 */

/** Normaliseert een hoek naar het bereik (-180, 180]. */
export function normalizeAngleDeg(angleDeg: number): number {
  let a = angleDeg % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

/** Normaliseert een hoek naar het bereik [0, 360). */
function normalizeTo360(angleDeg: number): number {
  let a = angleDeg % 360;
  if (a < 0) a += 360;
  return a;
}

/**
 * Richting naar het volgende knooppunt, RELATIEF t.o.v. de huidige
 * rijrichting (ontwerp sectie 5/6 van de heading-up-spec). 0° = rechtdoor,
 * negatief = links, positief = rechts, ±180° = achteruit. De exacte
 * teken-conventie is intern, zolang 'm consistent blijft (zoals de spec
 * zelf ook aangeeft) -- hier: rechts is positief, links is negatief.
 */
export function relativeAngleDeg(bearingToNextNodeDeg: number, currentHeadingDeg: number): number {
  return normalizeAngleDeg(bearingToNextNodeDeg - currentHeadingDeg);
}

export type RelativeDirection = "RECHTDOOR" | "LICHT_LINKS" | "LINKS" | "LICHT_RECHTS" | "RECHTS" | "ACHTERUIT";

export type DirectionThresholds = {
  /** Tot en met deze afwijking (graden, absoluut) geldt het als rechtdoor. */
  straightMaxAbsDeg: number;
  /** Tot en met deze afwijking geldt het als "licht links/rechts". */
  slightMaxAbsDeg: number;
  /** Tot en met deze afwijking geldt het als "links/rechts"; daarboven "achteruit/keren". */
  turnMaxAbsDeg: number;
};

/**
 * Uitgangspunten (ontwerp sectie 7 van de heading-up-spec) -- bewust net als
 * de overige kalibratiewaarden (GOKNOOP-MASTER.md sectie 3.7) NIET
 * definitief, hier als expliciete, injecteerbare parameters i.p.v.
 * hardgecodeerde magic numbers.
 */
export const DEFAULT_DIRECTION_THRESHOLDS: DirectionThresholds = {
  straightMaxAbsDeg: 15,
  slightMaxAbsDeg: 45,
  turnMaxAbsDeg: 135,
};

/**
 * Classificeert een relatieve hoek naar een stabiele, kleine set richtingen.
 * Puur, geen state -- het voorkomen van "heen-en-weer-springen" bij grens-
 * waarden is een latere, aparte laag (hysterese, net als bij deviation
 * detection, stap 6) -- hier bewust niet vooruitgelopen.
 */
export function classifyDirection(
  relativeAngle: number,
  thresholds: DirectionThresholds = DEFAULT_DIRECTION_THRESHOLDS
): RelativeDirection {
  const a = normalizeAngleDeg(relativeAngle);
  const abs = Math.abs(a);
  if (abs <= thresholds.straightMaxAbsDeg) return "RECHTDOOR";
  if (abs <= thresholds.slightMaxAbsDeg) return a < 0 ? "LICHT_LINKS" : "LICHT_RECHTS";
  if (abs <= thresholds.turnMaxAbsDeg) return a < 0 ? "LINKS" : "RECHTS";
  return "ACHTERUIT";
}

/**
 * Circulaire smoothing van de rijrichting (ontwerp sectie 8): voorkomt dat
 * de UI/kaart nerveus heen-en-weer draait bij elke losse GPS-update.
 * Werkt via de KORTSTE hoekafstand (normalizeAngleDeg), zodat de 0°/360°-
 * grens correct doorkruist wordt -- een naïeve lineaire interpolatie tussen
 * bijv. 359° en 2° zou anders de verkeerde kant op middelen.
 *
 * @param previousDeg vorige (gesmoothde) richting, of null bij de eerste meting.
 * @param rawDeg nieuwe, ruwe richting.
 * @param alpha gewicht van de nieuwe meting, in [0,1]. 1 = geen smoothing
 *   (direct de ruwe waarde), dichter bij 0 = trager/stabieler.
 */
export function smoothHeadingDeg(previousDeg: number | null, rawDeg: number, alpha: number): number {
  if (previousDeg === null) return normalizeTo360(rawDeg);
  const delta = normalizeAngleDeg(rawDeg - previousDeg);
  return normalizeTo360(previousDeg + alpha * delta);
}

export type HeadingSourceOptions = {
  /** Onder deze snelheid (m/s) wordt de GPS-bewegingsrichting niet vertrouwd (ontwerp sectie 16/17). */
  speedThresholdMps: number;
};

/**
 * Bepaalt welke rijrichting gebruikt moet worden (ontwerp sectie 16/17):
 * GPS-bewegingsrichting tijdens daadwerkelijke beweging, anders de laatst
 * bekende stabiele richting vasthouden (voorkomt dat de kaart bij stilstand
 * blijft ronddraaien op ruis). Bewust GEEN device-kompas/magnetometer hier
 * -- dat is een aparte sensor/toestemming, niet aangesloten in deze stap;
 * bij het ontbreken van een betrouwbare GPS-richting wordt expliciet de
 * vorige stabiele waarde (of `null`) teruggegeven, niet een geraden waarde.
 */
export function selectHeadingDeg(
  params: {
    gpsHeadingDeg: number | null;
    speedMps: number | null;
    previousStableHeadingDeg: number | null;
  },
  options: HeadingSourceOptions
): number | null {
  const movingFastEnough = params.speedMps !== null && params.speedMps > options.speedThresholdMps;
  if (movingFastEnough && params.gpsHeadingDeg !== null) {
    return params.gpsHeadingDeg;
  }
  return params.previousStableHeadingDeg;
}

/**
 * Eenvoudige aankomst-check (ontwerp sectie 12): binnen de aankomstradius.
 * Bewust GEEN stabiliteits-/bevestigingslaag hier (ontwerp sectie 13, "niet
 * te vroeg springen") -- dat vereist eenzelfde soort hysterese-mechanisme
 * als deviation detection (stap 6) en is een latere, aparte uitbreiding,
 * niet stilzwijgend in deze simpele functie verwerkt.
 */
export function hasArrivedAtNode(distanceToNextNodeM: number, arrivalRadiusM: number): boolean {
  return distanceToNextNodeM <= arrivalRadiusM;
}
