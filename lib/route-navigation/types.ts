/**
 * "Fase B: nieuwe Apple-style route-navigatie" (19-9-2026, GO van Te, na audit +
 * aanscherping door GPT: geometrisch bepaald, niet afhankelijk van ORS-instructietekst).
 *
 * Deze module is BEWUST volledig onafhankelijk van het bestaande GoKnoop-knooppunten-
 * model (GraphEdge, logicalNodeId, candidate-matcher, DeviationDetector,
 * NavigationStateMachine) -- zie de audit hierboven in het gesprek voor de volledige
 * onderbouwing. De routegeometrie zelf is de enige bron van waarheid.
 */

/** WGS84 -- zelfde vorm als LocalBikeRouteResult/ViaKnooppuntenResult, geen conversie nodig aan de randen. */
export type LatLon = { lat: number; lon: number };

/** Eén instructiestap zoals functie 1/2 'm al teruggeven -- puur aanvullende info (straatnaam), NOOIT de bron voor links/rechts. */
export type ExternalStep = { name: string; instruction: string; distanceM: number };

/** Minimale invoer die zowel functie 1 als functie 2 al leveren -- ongewijzigd hergebruikt. */
export type NavigationRoute = {
  geometry: LatLon[];
  distanceM: number;
  durationS: number;
  steps: ExternalStep[];
};

export type RouteProgress = {
  /** Dichtstbijzijnde punt op de routegeometrie (WGS84). */
  matchedPoint: LatLon;
  /** Index van het geometriesegment waarop gematcht is. */
  segmentIndex: number;
  /** 0..1 positie binnen dat segment. */
  segmentT: number;
  /** Loodrechte afstand van de GPS-positie tot de route, in meter. */
  perpendicularDistanceM: number;
  /** Cumulatieve afstand vanaf de start van de route tot het gematchte punt, in meter. */
  distanceAlongRouteM: number;
  remainingDistanceM: number;
  /** 0..1. */
  progressRatio: number;
};

/**
 * Geometrisch bepaalde manoeuvre (19-9-2026, expliciete aanscherping: GEEN tekstherkenning
 * op ORS-instructies). `direction` hergebruikt het bestaande `RelativeDirection`-type
 * (relative-direction.ts) -- dezelfde classificatie, nu toegepast op de bochthoek van de
 * route zelf i.p.v. op de hoek t.o.v. de actuele rijrichting.
 */
export type Maneuver = {
  /** Index in de geometrie waar de bocht zit. */
  atGeometryIndex: number;
  /** Bochthoek, -180..180 (positief = naar rechts), puur uit de geometrie afgeleid. */
  turnAngleDeg: number;
  distanceToManeuverM: number;
  /** Dichtstbijzijnde ORS-stap (op cumulatieve afstand) -- uitsluitend voor de straatnaam, nooit voor de richting. */
  streetName: string | null;
};

export type OffRouteStatus = {
  isOffRoute: boolean;
  /** Aantal opeenvolgende samples boven de drempel -- lichte demping tegen één enkele GPS-uitschieter. */
  consecutiveOffRouteSamples: number;
};
