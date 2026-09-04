/**
 * PlacesFinder -- parkeerplaats-zoekfunctie (GOKNOOP-MASTER.md sectie 9.42,
 * 30-8-2026), zoals vastgelegd/onderzocht in sectie 9.23. Zelfde
 * architectuurpatroon als `LocalBikeRouter` (sectie 9.11): interface +
 * concrete provider-implementatie, de rest van de app praat uitsluitend met
 * `PlacesFinder`, nooit rechtstreeks met een providerimplementatie.
 */

export type LatLon = { lat: number; lon: number };

export type PlaceResult = {
  name: string | null;
  lat: number;
  lon: number;
  distanceM: number;
};

export type PlacesProviderError = {
  reason: "provider_error" | "invalid_response";
  message: string;
};

export interface PlacesProvider {
  findNearby(center: LatLon, category: "parking", radiusM: number, limit: number): Promise<PlaceResult[] | PlacesProviderError>;
}
