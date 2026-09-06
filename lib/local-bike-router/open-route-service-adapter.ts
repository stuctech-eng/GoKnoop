import type { LatLon, LocalBikeRoutingProfile, LocalBikeRouteResult, LocalBikeRoutingError, RoutingProvider } from "./types";

/**
 * OpenRouteServiceAdapter -- concrete `RoutingProvider`-implementatie voor
 * OpenRouteService's Directions API v2 (sectie 9.4/9.6). Uitsluitend
 * aangeroepen via `LocalBikeRouter`, nooit rechtstreeks door de rest van de
 * app (sectie 9.3, harde eis: "de app mag nergens rechtstreeks afhankelijk
 * worden van ORS").
 *
 * API-contract geverifieerd tegen de officiële ORS-documentatie
 * (webzoekopdracht, 30-8-2026) -- NIET live getest tegen een echte API-key
 * (die is er nu niet). Bij de eerste echte test kan kleine bijstelling van
 * de respons-parsing nodig zijn; expliciet zo vermeld, niet stilzwijgend
 * als "af" behandeld.
 *
 * ENDPOINT-MIGRATIE (bevestigd 30-8-2026, officiële HeiGIT-forumaankondiging):
 * `api.openrouteservice.org` is gedeprecieerd t.g.v. `api.heigit.org`, met
 * uitschakeling van de oude URL op 24 augustus 2026 -- dus AL VERLOPEN op
 * het moment van bouwen. Dit bestand gebruikt daarom uitsluitend de nieuwe
 * URL. LET OP: geen simpele domeinvervanging -- de nieuwe structuur bevat
 * een extra servicenaam-segment: `api.heigit.org/openrouteservice/v2/...`
 * (niet `api.heigit.org/v2/...`).
 *
 * Endpoint: POST /v2/directions/{profile}/geojson (GeoJSON-variant, geen
 * polyline-decoder nodig). LET OP: ORS verwacht coördinaten in
 * [longitude, latitude]-volgorde (GeoJSON-conventie) -- omgekeerd t.o.v. de
 * gangbare "lat, lon"-schrijfwijze.
 */

const ORS_PROFILE_MAP: Record<LocalBikeRoutingProfile, string> = {
  cycling: "cycling-regular",
  foot: "foot-walking",
};

export class OpenRouteServiceAdapter implements RoutingProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  /**
   * `apiKey` optioneel injecteerbaar (tests) -- valt anders terug op de
   * environment variable, zelfde patroon als `lib/firebase-admin.ts`
   * (nooit hardcoded, credentials uit Vercel env vars).
   */
  constructor(apiKey?: string, baseUrl = "https://api.heigit.org/openrouteservice/v2/directions") {
    const key = apiKey ?? process.env.OPENROUTESERVICE_API_KEY;
    if (!key) {
      throw new Error(
        "OPENROUTESERVICE_API_KEY ontbreekt (environment variable, Vercel) -- LocalBikeRouter kan niet zonder een geldige ORS-sleutel."
      );
    }
    this.apiKey = key;
    this.baseUrl = baseUrl;
  }

  async route(
    origin: LatLon,
    destination: LatLon,
    profile: LocalBikeRoutingProfile
  ): Promise<LocalBikeRouteResult | LocalBikeRoutingError> {
    const orsProfile = ORS_PROFILE_MAP[profile];
    const url = `${this.baseUrl}/${orsProfile}/geojson`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.apiKey,
        },
        // [lon, lat]-volgorde, zie klasse-commentaar hierboven.
        body: JSON.stringify({
          coordinates: [
            [origin.lon, origin.lat],
            [destination.lon, destination.lat],
          ],
        }),
      });
    } catch (err) {
      return { reason: "provider_error", message: err instanceof Error ? err.message : String(err) };
    }

    if (!res.ok) {
      return { reason: "provider_error", message: `OpenRouteService gaf status ${res.status}.` };
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return { reason: "invalid_response", message: "OpenRouteService-respons kon niet als JSON gelezen worden." };
    }

    // GeoJSON FeatureCollection, één Feature voor de (enige gevraagde) route.
    const feature = (data as { features?: unknown[] })?.features?.[0] as
      | {
          geometry?: { coordinates?: [number, number][] };
          properties?: { summary?: { distance?: number; duration?: number } };
        }
      | undefined;

    const coordinates = feature?.geometry?.coordinates;
    const summary = feature?.properties?.summary;

    if (!coordinates || coordinates.length === 0) {
      return { reason: "no_route_found", message: "OpenRouteService vond geen route tussen deze twee punten." };
    }
    if (!summary || typeof summary.distance !== "number" || typeof summary.duration !== "number") {
      return { reason: "invalid_response", message: "OpenRouteService-respons had niet de verwachte vorm (geen summary.distance/duration)." };
    }

    return {
      geometry: coordinates.map(([lon, lat]) => ({ lat, lon })),
      distanceM: summary.distance,
      durationS: summary.duration,
    };
  }
}
