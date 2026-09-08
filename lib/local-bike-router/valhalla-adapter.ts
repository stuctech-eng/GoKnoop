import type { LatLon, LocalBikeRoutingProfile, LocalBikeRouteResult, LocalBikeRoutingError, RoutingProvider } from "./types";
import { decodePolyline } from "./polyline";

/**
 * ValhallaAdapter -- tweede concrete `RoutingProvider`-implementatie
 * (8-9-2026), naast `OpenRouteServiceAdapter`. Zelfde interface, zelfde
 * laagscheiding (sectie 9.3): uitsluitend aangeroepen via `LocalBikeRouter`,
 * nooit rechtstreeks door de rest van de app.
 *
 * API-contract geverifieerd tegen de officiële Valhalla-documentatie
 * (webzoekopdracht, 8-9-2026) -- NIET live getest tegen een echte
 * Valhalla-server (die is er nu niet, self-hosting nog niet opgezet).
 *
 * Endpoint: POST /route. Request: `{ locations: [{lat,lon}, {lat,lon}],
 * costing, units: "kilometers" }`. Response: `trip.summary.length` (km, dus
 * ×1000 voor meters -- expliciet `units` meegegeven i.p.v. op een
 * onvermelde default te vertrouwen), `trip.summary.time` (seconden),
 * `trip.legs[0].shape` (encoded polyline, 6 decimalen precisie -- zie
 * polyline.ts voor waarom dit afwijkt van de gangbare 5).
 *
 * Foutafhandeling: een niet-gevonden route geeft bij Valhalla een HTTP 400
 * met een specifieke `error_code: 442` ("No path could be found for
 * input") -- dat onderscheid expliciet gemaakt (i.p.v. elke 400 als
 * generieke provider_error te behandelen), zodat de aanroepende code
 * (bridge-generator) een echte afwijzing kan onderscheiden van een
 * tijdelijke/technische fout, exact zoals bij OpenRouteServiceAdapter.
 *
 * SELF-HOSTING: `baseUrl` is VERPLICHT via environment variable of
 * constructor-argument, GEEN hardcoded publieke default -- op uitdrukkelijk
 * verzoek (8-9-2026), zodat dit bestand net zo goed tegen een eigen,
 * self-hosted Valhalla-server werkt als tegen een publiek endpoint.
 * `apiKey` is OPTIONEEL (i.t.t. ORS): veel self-hosted Valhalla-installaties
 * draaien zonder enige authenticatie.
 */

const VALHALLA_COSTING_MAP: Record<LocalBikeRoutingProfile, string> = {
  cycling: "bicycle",
  foot: "pedestrian",
};

const NO_ROUTE_FOUND_ERROR_CODE = 442;

export class ValhallaAdapter implements RoutingProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  /**
   * `baseUrl`/`apiKey` optioneel injecteerbaar (tests) -- vallen anders terug
   * op environment variables, zelfde patroon als `OpenRouteServiceAdapter`.
   * `baseUrl` is, anders dan bij ORS, VERPLICHT aanwezig (geen publieke
   * default) -- zie klasse-commentaar hierboven.
   */
  constructor(baseUrl?: string, apiKey?: string) {
    const url = baseUrl ?? process.env.VALHALLA_BASE_URL;
    if (!url) {
      throw new Error(
        "VALHALLA_BASE_URL ontbreekt (environment variable, Vercel) -- ValhallaAdapter heeft geen hardcoded publiek endpoint, wijs bewust naar een self-hosted of expliciet geconfigureerd Valhalla-endpoint."
      );
    }
    this.baseUrl = url.replace(/\/+$/, ""); // trailing slash(es) verwijderen, voorkomt dubbele // in de uiteindelijke URL
    this.apiKey = apiKey ?? process.env.VALHALLA_API_KEY;
  }

  async route(
    origin: LatLon,
    destination: LatLon,
    profile: LocalBikeRoutingProfile
  ): Promise<LocalBikeRouteResult | LocalBikeRoutingError> {
    const url = `${this.baseUrl}/route`;

    // Zelfde harde timeout-aanpak en -waarde als OpenRouteServiceAdapter
    // (8-9-2026, herzien: 6000ms geeft de provider echte ruimte, zie de
    // toelichting daar voor de volledige voorgeschiedenis van dit getal).
    const REQUEST_TIMEOUT_MS = 6000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: this.apiKey } : {}),
        },
        body: JSON.stringify({
          locations: [
            { lat: origin.lat, lon: origin.lon },
            { lat: destination.lat, lon: destination.lon },
          ],
          costing: VALHALLA_COSTING_MAP[profile],
          units: "kilometers", // expliciet -- voorkomt afhankelijkheid van een onvermelde default
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "AbortError";
      return {
        reason: "provider_error",
        message: isTimeout
          ? `Geen antwoord van Valhalla binnen ${REQUEST_TIMEOUT_MS}ms (verbinding geforceerd afgebroken).`
          : err instanceof Error
          ? err.message
          : String(err),
      };
    } finally {
      clearTimeout(timeoutId);
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return { reason: "invalid_response", message: "Valhalla-respons kon niet als JSON gelezen worden." };
    }

    if (!res.ok) {
      const errorBody = data as { error_code?: number; error?: string } | undefined;
      if (errorBody?.error_code === NO_ROUTE_FOUND_ERROR_CODE) {
        return { reason: "no_route_found", message: `Valhalla: ${errorBody.error ?? "No path could be found for input"}` };
      }
      return {
        reason: "provider_error",
        message: `Valhalla gaf status ${res.status}${errorBody?.error ? `: ${errorBody.error}` : ""}.`,
      };
    }

    const trip = (data as { trip?: unknown })?.trip as
      | {
          summary?: { length?: number; time?: number };
          legs?: { shape?: string }[];
        }
      | undefined;

    const shape = trip?.legs?.[0]?.shape;
    const summary = trip?.summary;

    if (!shape) {
      return { reason: "no_route_found", message: "Valhalla-respons bevatte geen route-shape." };
    }
    if (!summary || typeof summary.length !== "number" || typeof summary.time !== "number") {
      return { reason: "invalid_response", message: "Valhalla-respons had niet de verwachte vorm (geen trip.summary.length/time)." };
    }

    return {
      geometry: decodePolyline(shape, 6),
      distanceM: summary.length * 1000, // km -> m, zie "units: kilometers" hierboven
      durationS: summary.time,
    };
  }
}
