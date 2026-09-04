import type { LatLon, PlaceResult, PlacesProviderError, PlacesProvider } from "./places-provider";

function cacheKey(center: LatLon, category: string, radiusM: number): string {
  const r = (n: number) => n.toFixed(4); // ~11m precisie -- ruim genoeg voor parkeerplaats-zoeken
  return `${category}:${radiusM}:${r(center.lat)},${r(center.lon)}`;
}

/**
 * PlacesFinder -- app-facing laag (sectie 9.42), zelfde patroon als
 * `LocalBikeRouter` (sectie 9.11). De rest van de app praat uitsluitend met
 * deze klasse, nooit rechtstreeks met `OverpassPlacesAdapter`.
 *
 * Simpele in-memory cache -- voorkomt dubbele aanvragen voor exact hetzelfde
 * gebied binnen één sessie (bijv. als de gebruiker twee keer naar dezelfde
 * bestemming zoekt).
 */
export class PlacesFinder {
  private readonly cache = new Map<string, PlaceResult[]>();

  constructor(private readonly provider: PlacesProvider) {}

  async findNearby(center: LatLon, category: "parking", radiusM: number, limit: number): Promise<PlaceResult[] | PlacesProviderError> {
    const key = cacheKey(center, category, radiusM);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const result = await this.provider.findNearby(center, category, radiusM, limit);
    if (!("reason" in result)) {
      this.cache.set(key, result);
    }
    return result;
  }
}
