import { wgs84ToRd } from "@/lib/route-engine/coordinate-transform";
import { distanceBetween, bearingDegrees } from "@/lib/navigation/matching/geometry";
import { classifyDirection } from "@/lib/navigation/direction/relative-direction";
import type { RelativeDirection } from "@/lib/navigation/direction/relative-direction";
import type { Point } from "@/lib/route-engine/types";
import type { ExternalStep, LatLon, Maneuver } from "./types";

/**
 * EXPLICIETE AANSCHERPING (19-9-2026, Te + GPT): de manoeuvre wordt UITSLUITEND uit de
 * routegeometrie zelf afgeleid (bearing vóór vs. bearing ná elk geometriepunt), NOOIT door
 * ORS-instructietekst ("Turn left"/"Keep right"/...) te parsen. Dat maakt de navigator
 * robuust tegen elke formulering/taal die de routeringsdienst teruggeeft. De ORS-stap-tekst
 * (`ExternalStep.name`) wordt uitsluitend gebruikt om een STRAATNAAM te tonen naast de
 * geometrisch bepaalde richting -- nooit om de richting zelf te bepalen.
 *
 * Hergebruikt `classifyDirection` (relative-direction.ts) ONGEWIJZIGD -- dezelfde
 * links/rechts-classificatie die de bestaande navigatie al gebruikt, hier toegepast op de
 * bochthoek van de route zelf i.p.v. op de hoek t.o.v. de actuele rijrichting. Zelfde
 * betekenis van het getal (positief = naar rechts, negatief = naar links), dus consistent
 * hergebruikbaar zonder aanpassing.
 */

/** Onder deze hoek (graden) wordt een geometriepunt als "gewoon een lichte bocht in het wegdek" beschouwd, geen echte manoeuvre. */
const MANEUVER_ANGLE_THRESHOLD_DEG = 20;
/** Hoe ver vooruit gezocht wordt naar de eerstvolgende manoeuvre, in meter. */
const LOOKAHEAD_M = 2000;

export function classifyManeuverDirection(turnAngleDeg: number): RelativeDirection {
  return classifyDirection(turnAngleDeg);
}

/**
 * Zoekt, vanaf `fromDistanceAlongRouteM`, de eerstvolgende geometrische bocht die de
 * drempel overschrijdt. `geometryWgs84` is de VOLLEDIGE routegeometrie; `steps` de
 * bijbehorende ORS-stappen (uitsluitend voor de straatnaam-koppeling).
 */
export function findNextManeuver(
  geometryWgs84: readonly LatLon[],
  steps: readonly ExternalStep[],
  fromDistanceAlongRouteM: number
): Maneuver | null {
  if (geometryWgs84.length < 3) return null;

  const geometryRd: Point[] = geometryWgs84.map((p) => wgs84ToRd(p.lat, p.lon));
  const segLengths: number[] = [];
  for (let i = 0; i < geometryRd.length - 1; i++) segLengths.push(distanceBetween(geometryRd[i], geometryRd[i + 1]));

  let cumulative = 0;
  for (let i = 1; i < geometryRd.length - 1; i++) {
    const distanceAtVertex = cumulative + segLengths[i - 1];
    if (distanceAtVertex > fromDistanceAlongRouteM) {
      const bearingIn = bearingDegrees(geometryRd[i - 1], geometryRd[i]);
      const bearingOut = bearingDegrees(geometryRd[i], geometryRd[i + 1]);
      // Signed hoekverschil (-180..180, positief = naar rechts) -- zelfde conventie als
      // relativeAngleDeg/classifyDirection elders, hier expliciet zelf berekend omdat
      // relativeAngleDeg een ANDERE betekenis heeft (t.o.v. actuele heading, niet tussen
      // twee route-bearings).
      let turnAngleDeg = bearingOut - bearingIn;
      turnAngleDeg = ((turnAngleDeg + 180) % 360) - 180;
      if (turnAngleDeg < -180) turnAngleDeg += 360;

      if (Math.abs(turnAngleDeg) >= MANEUVER_ANGLE_THRESHOLD_DEG) {
        return {
          atGeometryIndex: i,
          turnAngleDeg,
          distanceToManeuverM: distanceAtVertex - fromDistanceAlongRouteM,
          streetName: findStreetNameNear(steps, distanceAtVertex),
        };
      }
    }
    if (distanceAtVertex - fromDistanceAlongRouteM > LOOKAHEAD_M) break;
    cumulative += segLengths[i - 1];
  }
  return null;
}

/** Zoekt de ORS-stap wiens cumulatieve bereik het dichtst bij `atDistanceM` ligt -- uitsluitend voor de straatnaam. */
function findStreetNameNear(steps: readonly ExternalStep[], atDistanceM: number): string | null {
  let cumulative = 0;
  for (const step of steps) {
    const stepEnd = cumulative + step.distanceM;
    if (atDistanceM <= stepEnd) return step.name || null;
    cumulative = stepEnd;
  }
  return steps.length > 0 ? steps[steps.length - 1].name || null : null;
}
