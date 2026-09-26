import type { LatLon, LocalBikeRoutingProfile, LocalBikeRouteResult, LocalBikeRoutingError, RoutingProvider } from "./types";

function cacheKey(origin: LatLon, destination: LatLon, profile: LocalBikeRoutingProfile, includeSteps: boolean): string {
  // Afgerond op 5 decimalen (~1m precisie) -- voorkomt cache-missen door piepkleine
  // GPS-ruis tussen twee vrijwel identieke aanvragen, zonder merkbaar nauwkeurigheidsverlies
  // voor korte fietsstukjes.
  const r = (n: number) => n.toFixed(5);
  // `includeSteps` in de sleutel (19-9-2026): een cache-hit zonder steps mag niet stilzwijgend
  // teruggegeven worden aan een aanroeper die wél steps nodig heeft.
  return `${profile}:${includeSteps ? "steps" : "nosteps"}:${r(origin.lat)},${r(origin.lon)}->${r(destination.lat)},${r(destination.lon)}`;
}

/**
 * LocalBikeRouter -- app-facing laag (sectie 9.3/9.6: "Navigation →
 * LocalBikeRouter → RoutingProvider → OpenRouteServiceAdapter"). De rest
 * van de app praat UITSLUITEND met deze klasse, nooit rechtstreeks met een
 * `RoutingProvider`-implementatie -- zelfde laagscheiding als
 * `GraphProvider` in de Route Engine.
 *
 * Voegt request-minimalisatie toe bovenop een kale provider: een simpele
 * in-memory cache (voorkomt dubbele aanvragen voor exact dezelfde
 * origin/destination/profile binnen één sessie -- "zo weinig mogelijk
 * requests", sectie 9.6). Bewust GEEN TTL/persistente cache: reset vanzelf
 * bij een nieuwe paginalaad, en een parkeerplaats/knooppunt-paar verandert
 * toch niet gedurende één sessie -- "niet onnodig alles persistent maken".
 *
 * Foutresultaten worden NIET gecached (een tijdelijke providerfout mag geen
 * blijvend cache-record worden).
 */
export class LocalBikeRouter {
  private readonly cache = new Map<string, LocalBikeRouteResult>();

  constructor(private readonly provider: RoutingProvider) {}

  async route(
    origin: LatLon,
    destination: LatLon,
    profile: LocalBikeRoutingProfile,
    options?: { includeSteps?: boolean }
  ): Promise<LocalBikeRouteResult | LocalBikeRoutingError> {
    const includeSteps = options?.includeSteps ?? false;
    const key = cacheKey(origin, destination, profile, includeSteps);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const result = await this.provider.route(origin, destination, profile, options);
    if (!("reason" in result)) {
      this.cache.set(key, result);
    }
    return result;
  }

  /** Puur voor tests/diagnose -- geen productiegebruik verwacht. */
  cacheSize(): number {
    return this.cache.size;
  }
}
