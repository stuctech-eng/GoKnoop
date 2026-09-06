/**
 * LocalBikeRouter -- Fase 3 van GOKNOOP-MASTER.md sectie 9 (Parkeerplaats →
 * Startknooppunt → Route → Back to Start). Types voor korte, algemene
 * fietsverbindingen BUITEN het knooppuntennetwerk (parkeerplaats↔knooppunt,
 * GPS↔gekozen knooppunt, Back to Start) -- de bestaande `KnotRouteEngine`
 * (`lib/route-engine/`) wordt hier NIET aangeraakt en blijft de enige
 * routinglaag voor knooppunt↔knooppunt.
 *
 * Laagscheiding (sectie 9.3/9.6), zelfde patroon als `GraphProvider` al
 * gebruikt in `lib/route-engine/types.ts` (interface + concrete
 * implementatie):
 *
 *   Navigation → LocalBikeRouter → RoutingProvider → OpenRouteServiceAdapter
 *
 * De rest van de app praat uitsluitend met `LocalBikeRouter`
 * (`local-bike-router.ts`), nooit rechtstreeks met een provider-
 * implementatie -- nergens in de app mag een rechtstreekse
 * ORS-afhankelijkheid ontstaan (sectie 9.3, harde eis).
 */

/** WGS84 lat/lon -- BEWUST niet de RD-gebaseerde `Point` uit route-engine/types.ts:
 *  dit werkt met ruwe GPS-coördinaten en de native coördinatenvolgorde van externe
 *  routing-API's, geen RD-conversie nodig voor deze laag. */
export type LatLon = { lat: number; lon: number };

/** Bouw eerst uitsluitend "cycling" (sectie 9.4) -- "foot" staat als bewust opengehouden
 *  deur in het type, geen bouwopdracht om nu al te implementeren. */
export type LocalBikeRoutingProfile = "cycling" | "foot";

export type LocalBikeRouteResult = {
  /** WGS84, in rijrichting. */
  geometry: LatLon[];
  distanceM: number;
  durationS: number;
};

export type LocalBikeRoutingError = {
  reason: "provider_error" | "no_route_found" | "invalid_response";
  message: string;
};

/**
 * Interface voor een externe routingdienst -- concrete implementaties
 * (`OpenRouteServiceAdapter`) mogen NOOIT rechtstreeks door de rest van de
 * app aangeroepen worden, alleen via `LocalBikeRouter`. Expliciete
 * foutresultaten i.p.v. exceptions, zelfde conventie als `RouteError` in
 * de Route Engine (`computeRoute()`).
 */
export interface RoutingProvider {
  route(origin: LatLon, destination: LatLon, profile: LocalBikeRoutingProfile): Promise<LocalBikeRouteResult | LocalBikeRoutingError>;
}
