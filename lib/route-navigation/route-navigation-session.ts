import { computeRouteProgress } from "./route-progress";
import { findNextManeuver } from "./maneuver-detection";
import { selectHeadingDeg, smoothHeadingDeg, relativeAngleDeg } from "@/lib/navigation/direction/relative-direction";
import { wgs84ToRd } from "@/lib/route-engine/coordinate-transform";
import { bearingDegrees } from "@/lib/navigation/matching/geometry";
import type { LatLon, Maneuver, NavigationRoute, OffRouteStatus, RouteProgress } from "./types";

/**
 * "Fase B" (19-9-2026): de nieuwe, eenvoudige navigatie-orkestratie voor externe
 * routegeometrie. BEWUST GEEN state machine (zoals NavigationStateMachine bij de
 * knooppuntennavigatie) -- volgens het opdrachtdocument sectie 8: "dit is bewust
 * eenvoudiger... niet meteen een volledig nieuw rerouting-systeem bouwen". Afwijking is
 * een simpele drempel met een korte, vaste demping (paar opeenvolgende samples), geen
 * hysterese-tijdvenster/bevestigingslaag.
 *
 * Hergebruikt ONGEWIJZIGD: `computeRouteProgress`/`findNextManeuver` (hierboven, dit
 * pakket) en `selectHeadingDeg`/`smoothHeadingDeg`/`relativeAngleDeg`
 * (relative-direction.ts, ongewijzigd, dezelfde functies als de bestaande
 * Apple-stijl-navigatiekaart al gebruikt voor kaartrotatie).
 */

export type NavigationSampleInput = {
  position: LatLon;
  headingDeg: number | null;
  speedMps: number | null;
};

export type NavigationUpdate = {
  progress: RouteProgress;
  maneuver: Maneuver | null;
  /** Gesmoothde rijrichting -- voor kaartrotatie, exact zoals de bestaande Apple-stijl-kaart 'm gebruikt. */
  smoothedHeadingDeg: number | null;
  /** Relatieve hoek van de manoeuvre t.o.v. de actuele rijrichting -- voor de pijl op het scherm (0 = rechtdoor/boven). */
  maneuverArrowDeg: number;
  offRoute: OffRouteStatus;
  arrived: boolean;
};

export type RouteNavigationSessionOptions = {
  /** Boven deze loodrechte afstand (meter) wordt een sample als "van de route af" geteld. */
  offRouteThresholdM: number;
  /** Vanaf hoeveel opeenvolgende samples boven de drempel `offRoute.isOffRoute` echt true wordt (lichte demping tegen één GPS-uitschieter). */
  offRouteConfirmSamples: number;
  /** Binnen deze afstand van het eindpunt geldt de route als voltooid. */
  arrivalThresholdM: number;
  /** Zelfde betekenis als bij de bestaande navigatie (movementSpeedThresholdMps). */
  headingSpeedThresholdMps: number;
  headingSmoothingAlpha: number;
};

export const DEFAULT_ROUTE_NAVIGATION_OPTIONS: RouteNavigationSessionOptions = {
  offRouteThresholdM: 40,
  offRouteConfirmSamples: 3,
  arrivalThresholdM: 25,
  headingSpeedThresholdMps: 0.5,
  headingSmoothingAlpha: 0.3,
};

export class RouteNavigationSession {
  private smoothedHeading: number | null = null;
  private consecutiveOffRouteSamples = 0;

  constructor(
    private readonly route: NavigationRoute,
    private readonly options: RouteNavigationSessionOptions = DEFAULT_ROUTE_NAVIGATION_OPTIONS
  ) {}

  process(sample: NavigationSampleInput): NavigationUpdate | null {
    const progress = computeRouteProgress(this.route.geometry, sample.position);
    if (!progress) return null;

    const selectedHeading = selectHeadingDeg(
      { gpsHeadingDeg: sample.headingDeg, speedMps: sample.speedMps, previousStableHeadingDeg: this.smoothedHeading },
      { speedThresholdMps: this.options.headingSpeedThresholdMps }
    );
    if (selectedHeading !== null) {
      this.smoothedHeading = smoothHeadingDeg(this.smoothedHeading, selectedHeading, this.options.headingSmoothingAlpha);
    }

    const maneuver = findNextManeuver(this.route.geometry, this.route.steps, progress.distanceAlongRouteM);

    let maneuverArrowDeg = 0;
    if (maneuver && this.smoothedHeading !== null) {
      const maneuverPointRd = wgs84ToRd(
        this.route.geometry[Math.min(maneuver.atGeometryIndex, this.route.geometry.length - 1)].lat,
        this.route.geometry[Math.min(maneuver.atGeometryIndex, this.route.geometry.length - 1)].lon
      );
      const currentRd = wgs84ToRd(progress.matchedPoint.lat, progress.matchedPoint.lon);
      const bearingToManeuver = bearingDegrees(currentRd, maneuverPointRd);
      maneuverArrowDeg = relativeAngleDeg(bearingToManeuver, this.smoothedHeading);
    }

    if (progress.perpendicularDistanceM > this.options.offRouteThresholdM) {
      this.consecutiveOffRouteSamples += 1;
    } else {
      this.consecutiveOffRouteSamples = 0;
    }
    const offRoute: OffRouteStatus = {
      isOffRoute: this.consecutiveOffRouteSamples >= this.options.offRouteConfirmSamples,
      consecutiveOffRouteSamples: this.consecutiveOffRouteSamples,
    };

    const arrived = progress.remainingDistanceM <= this.options.arrivalThresholdM;

    return {
      progress,
      maneuver,
      smoothedHeadingDeg: this.smoothedHeading,
      maneuverArrowDeg,
      offRoute,
      arrived,
    };
  }
}
