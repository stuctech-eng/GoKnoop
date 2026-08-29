import { Point } from "../../route-engine/types";
import { MatchedPosition } from "../types";
import {
  segmentLengths,
  cumulativeDistances,
  bearingDegrees,
  angleDifferenceDegrees,
  projectOntoSegment,
  distanceBetween,
} from "./geometry";

/**
 * Candidate-based route-position matcher (ontwerp sectie 5, aangescherpt na
 * review) -- implementatiestap 4.
 *
 * Bewust GEEN pure "dichtstbijzijnde-lijn"-matching. Een puur geometrisch
 * criterium kan de verkeerde routetak kiezen wanneer de route zelf ergens
 * dicht langs zichzelf loopt (bijv. een lus met een parallel, dichtbij
 * gelegen retourtraject) -- zie de kern-testcase in
 * candidate-matcher.test.ts. In plaats daarvan wordt een kandidaat-segment
 * gescoord op een combinatie van signalen:
 *   - perpendicularDistanceM (geometrisch)
 *   - headingDeg-overeenkomst met de segmentrichting (indien beschikbaar)
 *   - continuïteit met de vorige match (voorkomt een onwaarschijnlijke
 *     sprong in routevoortgang)
 *
 * `speedMps` beïnvloedt hier alleen de venstergrootte (welke segmenten
 * überhaupt kandidaat zijn), niet de score zelf -- exact zoals ontwerp
 * sectie 5/13 vastlegt ("mede input voor de dynamische venstergrootte").
 *
 * Bewust GEEN afwijkingsdetectie, GEEN rerouting, GEEN echte GPS, GEEN
 * Route Engine-integratie hier -- dit bestand levert alleen een
 * MatchedPosition, het interpreteert die niet (latere stappen, sectie 23).
 */

export type MatchInput = {
  /** RD-gecoördineerde GPS-positie (na wgs84ToRd, buiten deze module -- matcher werkt uitsluitend in RD). */
  position: Point;
  headingDeg: number | null;
  speedMps: number | null;
  /** Vorige match, of null bij de allereerste match van een sessie (ontwerp sectie 6, randgeval sessiestart). */
  previousMatch: MatchedPosition | null;
};

export type MatchWeights = {
  /** Gewicht per meter perpendiculaire afstand. */
  distance: number;
  /** Gewicht per graad hoekverschil tussen GPS-heading en segmentrichting. */
  heading: number;
  /** Gewicht per meter geïmpliceerde sprong in cumulatieve routevoortgang t.o.v. de vorige match. */
  continuity: number;
};

export type MatchOptions = {
  /** Basis-venstergrootte in meter, vóór snelheidscorrectie (ontwerp sectie 5). */
  baseWindowM: number;
  /** Extra venstermarge per m/s snelheid. */
  windowMarginPerMps: number;
  /**
   * Scoregewichten -- expliciet injecteerbaar, geen hardcoded constanten.
   * Nog niet gekalibreerd (ontwerp sectie 20/21): de exacte waarden zijn een
   * latere kalibratiestap, niet hier vastgepind.
   */
  weights: MatchWeights;
};

/**
 * Matcht een ruwe GPS-positie tegen een route-geometrie (RD-polyline).
 * Retourneert `null` als er geen zinvolle match mogelijk is (geometrie te
 * kort of lengte 0) -- geen stille foutieve match.
 */
export function matchPosition(geometry: readonly Point[], input: MatchInput, options: MatchOptions): MatchedPosition | null {
  if (geometry.length < 2) return null;

  const lengths = segmentLengths(geometry);
  const cumEnds = cumulativeDistances(lengths);
  const totalLengthM = cumEnds[cumEnds.length - 1];
  if (totalLengthM === 0) return null;

  const candidateIndices = selectCandidateSegments(lengths, cumEnds, input, options);

  let best: (MatchedPosition & { cost: number }) | null = null;

  for (const segmentIndex of candidateIndices) {
    const a = geometry[segmentIndex];
    const b = geometry[segmentIndex + 1];
    const { point, t } = projectOntoSegment(input.position, a, b);
    const perpendicularDistanceM = distanceBetween(input.position, point);
    const segStart = segmentIndex === 0 ? 0 : cumEnds[segmentIndex - 1];
    const cumulativeDistanceM = segStart + t * lengths[segmentIndex];

    const distanceCost = options.weights.distance * perpendicularDistanceM;
    const headingCost = computeHeadingCost(input.headingDeg, a, b, options.weights.heading);
    const continuityCost = computeContinuityCost(cumulativeDistanceM, input.previousMatch, options.weights.continuity);
    const cost = distanceCost + headingCost + continuityCost;

    if (best === null || cost < best.cost) {
      best = { segmentIndex, segmentT: t, point, perpendicularDistanceM, cumulativeDistanceM, cost };
    }
  }

  if (best === null) return null;
  const { cost: _cost, ...result } = best;
  return result;
}

/**
 * Bepaalt welke segmenten kandidaat zijn. Zonder vorige match (sessiestart,
 * ontwerp sectie 6): alle segmenten, geen venster. Mét vorige match: alleen
 * segmenten waarvan het cumulatieve-afstandsbereik overlapt met een venster
 * rond de vorige positie -- dit is de PRIMAIRE bescherming tegen het
 * kiezen van een geometrisch nabij, maar qua routevoortgang ver weg gelegen
 * segment (bijv. een parallel retourtraject in een lus).
 */
function selectCandidateSegments(
  lengths: readonly number[],
  cumEnds: readonly number[],
  input: MatchInput,
  options: MatchOptions
): number[] {
  if (input.previousMatch === null) {
    return lengths.map((_, i) => i);
  }
  const windowM = options.baseWindowM + (input.speedMps ?? 0) * options.windowMarginPerMps;
  const center = input.previousMatch.cumulativeDistanceM;
  const indices: number[] = [];
  for (let i = 0; i < lengths.length; i++) {
    const segStart = i === 0 ? 0 : cumEnds[i - 1];
    const segEnd = cumEnds[i];
    if (segEnd >= center - windowM && segStart <= center + windowM) {
      indices.push(i);
    }
  }
  // Val terug op alle segmenten als het venster (onwaarschijnlijk) niets raakt --
  // expliciet, geen stille lege match (zelfde principe als het GPS_LOST-hervattingsgedrag, sectie 12).
  return indices.length > 0 ? indices : lengths.map((_, i) => i);
}

function computeHeadingCost(headingDeg: number | null, a: Point, b: Point, weight: number): number {
  if (headingDeg === null) return 0; // geen signaal, geen straf -- headingDeg is nullable (ontwerp sectie 13)
  const segmentBearing = bearingDegrees(a, b);
  const diff = angleDifferenceDegrees(headingDeg, segmentBearing);
  return weight * diff;
}

function computeContinuityCost(candidateCumulativeM: number, previousMatch: MatchInput["previousMatch"], weight: number): number {
  if (previousMatch === null) return 0; // geen vorige match, geen continuïteitssignaal
  const jumpM = Math.abs(candidateCumulativeM - previousMatch.cumulativeDistanceM);
  return weight * jumpM;
}
